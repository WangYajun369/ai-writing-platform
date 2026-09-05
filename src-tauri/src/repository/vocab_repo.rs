//! 英语生词本数据访问层
//!
//! 提供 vocab_words / vocab_reviews 两表的 SQL 操作。
//! 复习状态的推进（SM-2 计算）在 service 层完成，本层只负责读写。

use crate::models::{StatsDay, VocabKnowledge, VocabMeaning, VocabWord};
use rusqlite::{params, Connection, OptionalExtension, Result};

/// SELECT 常用列（顺序固定，row_to_word 依赖此顺序）
const WORD_COLS: &str = "id, word, phonetic, meanings, example, example_zh, repetition, \
    interval_days, ease_factor, status, next_review_at, last_review_at, review_count, correct_count, \
    source, ai_details, created_at, updated_at";

/// 解析数据库中 meanings JSON 字符串为 Vec<VocabMeaning>
fn parse_meanings(raw: String) -> Vec<VocabMeaning> {
    serde_json::from_str(&raw).unwrap_or_default()
}

/// 解析 ai_details JSON 字符串（空串 / 解析失败返回 None）
fn parse_knowledge(raw: Option<String>) -> Option<VocabKnowledge> {
    match raw {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(&s).ok(),
        _ => None,
    }
}

/// 按固定列序从行中解析 VocabWord
fn row_to_word(row: &rusqlite::Row) -> rusqlite::Result<VocabWord> {
    Ok(VocabWord {
        id: row.get(0)?,
        word: row.get(1)?,
        phonetic: row.get(2)?,
        meanings: parse_meanings(row.get(3)?),
        example: row.get(4)?,
        example_zh: row.get(5)?,
        repetition: row.get(6)?,
        interval_days: row.get(7)?,
        ease_factor: row.get(8)?,
        status: row.get(9)?,
        next_review_at: row.get(10)?,
        last_review_at: row.get(11)?,
        review_count: row.get(12)?,
        correct_count: row.get(13)?,
        source: row.get(14)?,
        knowledge: parse_knowledge(row.get(15)?),
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

/// 新增生词（初始 learning，按传入的首次复习日期排期）
pub fn create_word(
    conn: &Connection,
    id: &str,
    word: &str,
    phonetic: &str,
    meanings_json: &str,
    example: &str,
    example_zh: &str,
    ai_details: &str,
    source: &str,
    next_review_at: Option<&str>,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO vocab_words (id, word, phonetic, meanings, example, example_zh, repetition, \
            interval_days, ease_factor, status, next_review_at, last_review_at, review_count, correct_count, \
            source, ai_details, created_at, updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,0,0,2.5,'learning',?7,NULL,0,0,?8,?9,?10,?10)",
        params![
            id,
            word,
            phonetic,
            meanings_json,
            example,
            example_zh,
            next_review_at,
            source,
            ai_details,
            ts
        ],
    )?;
    Ok(())
}

/// 按单词精确查找（小写）
pub fn find_by_word(conn: &Connection, word: &str) -> Result<Option<VocabWord>> {
    let sql = format!(
        "SELECT {} FROM vocab_words WHERE word = ?1 COLLATE NOCASE",
        WORD_COLS
    );
    let result = conn
        .query_row(&sql, params![word], row_to_word)
        .optional()?;
    Ok(result)
}

/// 按 id 查找
pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<VocabWord>> {
    let sql = format!("SELECT {} FROM vocab_words WHERE id = ?1", WORD_COLS);
    let result = conn.query_row(&sql, params![id], row_to_word).optional()?;
    Ok(result)
}

/// 更新释义类字段（音标/释义/例句/AI 学习知识）
pub fn update_content_fields(
    conn: &Connection,
    id: &str,
    phonetic: &str,
    meanings_json: &str,
    example: &str,
    example_zh: &str,
    ai_details: &str,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE vocab_words SET phonetic = ?2, meanings = ?3, example = ?4, example_zh = ?5, ai_details = ?6, updated_at = ?7 WHERE id = ?1",
        params![id, phonetic, meanings_json, example, example_zh, ai_details, ts],
    )?;
    Ok(())
}

/// 直接设置状态
pub fn set_status(conn: &Connection, id: &str, status: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE vocab_words SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, status, ts],
    )?;
    Ok(())
}

/// 复习后推进记忆状态（SM-2 参数 + 统计）
pub fn update_review_state(
    conn: &Connection,
    id: &str,
    repetition: i64,
    interval_days: i64,
    ease_factor: f64,
    status: &str,
    next_review_at: Option<&str>,
    last_review_at: &str,
    correct: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE vocab_words SET repetition = ?2, interval_days = ?3, ease_factor = ?4, \
         status = ?5, next_review_at = ?6, last_review_at = ?7, \
         review_count = review_count + 1, correct_count = correct_count + ?8, \
         updated_at = ?9 WHERE id = ?1",
        params![
            id,
            repetition,
            interval_days,
            ease_factor,
            status,
            next_review_at,
            last_review_at,
            correct as i64,
            last_review_at,
        ],
    )?;
    Ok(())
}

/// 删除生词（复习记录由外键级联删除）
pub fn delete_word(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
    Ok(())
}

/// 列出生词：可选按状态过滤 + 单词前缀模糊搜索
pub fn list_words(
    conn: &Connection,
    status: Option<&str>,
    query: Option<&str>,
) -> Result<Vec<VocabWord>> {
    let sql = format!("SELECT {} FROM vocab_words", WORD_COLS);
    let mut conditions: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(st) = status {
        if !st.is_empty() && st != "all" {
            conditions.push(format!("status = ?{}", args.len() + 1));
            args.push(Box::new(st.to_string()));
        }
    }
    if let Some(q) = query {
        let q = q.trim();
        if !q.is_empty() {
            conditions.push(format!("word LIKE ?{} COLLATE NOCASE", args.len() + 1));
            args.push(Box::new(format!("%{}%", q)));
        }
    }
    let mut sql = sql;
    if !conditions.is_empty() {
        sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
    }
    // 学习中优先按最近更新排序，方便查看
    sql.push_str(" ORDER BY created_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let arg_refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let items = stmt.query_map(arg_refs.as_slice(), row_to_word)?;
    items.collect()
}

/// 今日到期队列：next_review_at <= today 且处于 learning 状态
pub fn list_due(conn: &Connection, today: &str) -> Result<Vec<VocabWord>> {
    let sql = format!(
        "SELECT {} FROM vocab_words \
         WHERE status = 'learning' AND next_review_at IS NOT NULL AND next_review_at <= ?1 \
         ORDER BY next_review_at ASC, created_at ASC",
        WORD_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt.query_map(params![today], row_to_word)?;
    items.collect()
}

/// 插入一条复习记录
pub fn insert_review_log(
    conn: &Connection,
    id: &str,
    word_id: &str,
    review_date: &str,
    rating: i64,
    repetition: i64,
    interval_days: i64,
    ease_factor: f64,
    reviewed_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO vocab_reviews (id, word_id, review_date, rating, repetition, interval_days, ease_factor, reviewed_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id, word_id, review_date, rating, repetition, interval_days, ease_factor, reviewed_at],
    )?;
    Ok(())
}

/// 按状态统计数量
pub fn count_by_status(conn: &Connection, status: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE status = ?1",
        params![status],
        |row| row.get(0),
    )
}

/// 总词数
pub fn count_total(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM vocab_words", [], |row| row.get(0))
}

/// 到期数（含逾期）
pub fn count_due(conn: &Connection, today: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM vocab_words \
         WHERE status = 'learning' AND next_review_at IS NOT NULL AND next_review_at <= ?1",
        params![today],
        |row| row.get(0),
    )
}

/// 某日已复习次数（按 review_date）
pub fn count_reviewed_on(conn: &Connection, date: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM vocab_reviews WHERE review_date = ?1",
        params![date],
        |row| row.get(0),
    )
}

/// 某日起新增词数（created_at 按 UTC 文本前缀比较 YYYY-MM-DD 前 10 位）
pub fn count_new_since(conn: &Connection, date_prefix: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE substr(created_at, 1, 10) >= ?1",
        params![date_prefix],
        |row| row.get(0),
    )
}

/// 某生词的复习记录（按时间倒序）
pub fn list_review_logs(
    conn: &Connection,
    word_id: &str,
) -> Result<Vec<crate::models::VocabReviewLog>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, word_id, review_date, rating, repetition, interval_days, ease_factor, reviewed_at \
         FROM vocab_reviews WHERE word_id = ?1 ORDER BY reviewed_at DESC LIMIT 100",
    )?;
    let items = stmt.query_map(params![word_id], |row| {
        Ok(crate::models::VocabReviewLog {
            id: row.get(0)?,
            word_id: row.get(1)?,
            review_date: row.get(2)?,
            rating: row.get(3)?,
            repetition: row.get(4)?,
            interval_days: row.get(5)?,
            ease_factor: row.get(6)?,
            reviewed_at: row.get(7)?,
        })
    })?;
    items.collect()
}

/// 近 N 天复习分布（按 review_date 分组升序）
pub fn review_history(conn: &Connection, start_date: &str) -> Result<Vec<StatsDay>> {
    let mut stmt = conn.prepare(
        "SELECT review_date, COUNT(*) FROM vocab_reviews \
         WHERE review_date >= ?1 GROUP BY review_date ORDER BY review_date ASC",
    )?;
    let items = stmt.query_map(params![start_date], |row| {
        Ok(StatsDay {
            date: row.get(0)?,
            count: row.get(1)?,
        })
    })?;
    items.collect()
}
