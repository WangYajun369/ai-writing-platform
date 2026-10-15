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

/// create_word 的业务参数封装（除 conn 外）
#[derive(Debug)]
pub struct CreateWordArgs<'a> {
    pub id: &'a str,
    pub word: &'a str,
    pub phonetic: &'a str,
    pub meanings_json: &'a str,
    pub example: &'a str,
    pub example_zh: &'a str,
    pub ai_details: &'a str,
    pub source: &'a str,
    pub next_review_at: Option<&'a str>,
    pub ts: &'a str,
}

/// 新增生词（初始 learning，按传入的首次复习日期排期）
///
/// 用 `ON CONFLICT(word) DO NOTHING` 而非裸 INSERT：多窗口并发收录同一单词时，
/// 后到的请求不再撞 UNIQUE(word) 报错，而是静默让先到者胜出（调用方按 word 回读）。
pub fn create_word(conn: &Connection, args: CreateWordArgs<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO vocab_words (id, word, phonetic, meanings, example, example_zh, repetition, \
            interval_days, ease_factor, status, next_review_at, last_review_at, review_count, correct_count, \
            source, ai_details, created_at, updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,0,0,2.5,'learning',?7,NULL,0,0,?8,?9,?10,?10) \
         ON CONFLICT(word) DO NOTHING",
        params![
            args.id,
            args.word,
            args.phonetic,
            args.meanings_json,
            args.example,
            args.example_zh,
            args.next_review_at,
            args.source,
            args.ai_details,
            args.ts
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

/// update_content_fields 的业务参数封装（除 conn 外）
#[derive(Debug)]
pub struct UpdateContentArgs<'a> {
    pub id: &'a str,
    pub phonetic: &'a str,
    pub meanings_json: &'a str,
    pub example: &'a str,
    pub example_zh: &'a str,
    pub ai_details: &'a str,
    pub ts: &'a str,
}

/// 更新释义类字段（音标/释义/例句/AI 学习知识）
pub fn update_content_fields(conn: &Connection, args: UpdateContentArgs<'_>) -> Result<()> {
    conn.execute(
        "UPDATE vocab_words SET phonetic = ?2, meanings = ?3, example = ?4, example_zh = ?5, ai_details = ?6, updated_at = ?7 WHERE id = ?1",
        params![args.id, args.phonetic, args.meanings_json, args.example, args.example_zh, args.ai_details, args.ts],
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

/// update_review_state 的业务参数封装（除 conn 外）
#[derive(Debug)]
pub struct UpdateReviewStateArgs<'a> {
    pub id: &'a str,
    pub repetition: i64,
    pub interval_days: i64,
    pub ease_factor: f64,
    pub status: &'a str,
    pub next_review_at: Option<&'a str>,
    pub last_review_at: &'a str,
    pub correct: bool,
    /// 本次写入的 updated_at（与 last_review_at 分离，避免复用导致语义混淆）
    pub updated_at: &'a str,
}

/// 复习后推进记忆状态（SM-2 参数 + 统计）
pub fn update_review_state(conn: &Connection, args: UpdateReviewStateArgs<'_>) -> Result<()> {
    // correct 以 0/1 整数落入 correct_count 累加（答对 +1、答错 +0）
    conn.execute(
        "UPDATE vocab_words SET repetition = ?2, interval_days = ?3, ease_factor = ?4, \
         status = ?5, next_review_at = ?6, last_review_at = ?7, \
         review_count = review_count + 1, correct_count = correct_count + ?8, \
         updated_at = ?9 WHERE id = ?1",
        params![
            args.id,
            args.repetition,
            args.interval_days,
            args.ease_factor,
            args.status,
            args.next_review_at,
            args.last_review_at,
            args.correct as i64,
            args.updated_at,
        ],
    )?;
    Ok(())
}

/// 删除生词（复习记录由外键级联删除）
///
/// 同时清理**他人关系中指向本词文本**的孤儿行（`related_word` 以文本存储，
/// 不受 `word_id` 外键级联保护），避免删除后残留永远显示为「未收录」的虚假关联。
pub fn delete_word(conn: &Connection, id: &str, word: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vocab_word_relations WHERE related_word = ?1 COLLATE NOCASE",
        params![word],
    )?;
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

/// 统计匹配（状态过滤 + 模糊搜索）的生词总数（分页场景的总量）
pub fn count_words(
    conn: &Connection,
    status: Option<&str>,
    query: Option<&str>,
) -> Result<i64> {
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
            // 与前端旧版一致：单词 / 音标 / 释义三字段子串匹配（同一参数占位符复用）
            let ph = format!("?{}", args.len() + 1);
            conditions.push(format!(
                "(word LIKE {ph} COLLATE NOCASE OR phonetic LIKE {ph} COLLATE NOCASE OR meanings LIKE {ph} COLLATE NOCASE)"
            ));
            args.push(Box::new(format!("%{}%", q)));
        }
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!("SELECT COUNT(*) FROM vocab_words{}", where_clause);
    let mut stmt = conn.prepare(&sql)?;
    let arg_refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    stmt.query_row(arg_refs.as_slice(), |r| r.get(0)).map_err(Into::into)
}

/// 分页列出生词（虚拟滚动）：状态过滤 + 模糊搜索，返回 (本页条目, 匹配总数)。
///
/// `page` 为 0 基页码，`page_size` 每页条数；二者非法时按 page=0 / size=1 兜底。
pub fn list_words_page(
    conn: &Connection,
    status: Option<&str>,
    query: Option<&str>,
    page: i64,
    page_size: i64,
) -> Result<(Vec<VocabWord>, i64)> {
    let total = count_words(conn, status, query)?;
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
            let ph = format!("?{}", args.len() + 1);
            conditions.push(format!(
                "(word LIKE {ph} COLLATE NOCASE OR phonetic LIKE {ph} COLLATE NOCASE OR meanings LIKE {ph} COLLATE NOCASE)"
            ));
            args.push(Box::new(format!("%{}%", q)));
        }
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let offset = page.max(0) * page_size.max(1);
    let sql = format!(
        "SELECT {} FROM vocab_words{} ORDER BY created_at DESC LIMIT ?{} OFFSET ?{}",
        WORD_COLS,
        where_clause,
        args.len() + 1,
        args.len() + 2
    );
    args.push(Box::new(page_size.max(1)));
    args.push(Box::new(offset));
    let arg_refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt.query_map(arg_refs.as_slice(), row_to_word)?;
    let items = items.collect::<Result<Vec<VocabWord>, _>>()?;
    Ok((items, total))
}

/// 全量生词（备份导出用：不限状态、不分页）
pub fn list_all_words(conn: &Connection) -> Result<Vec<VocabWord>> {
    let sql = format!("SELECT {} FROM vocab_words ORDER BY created_at ASC", WORD_COLS);
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt.query_map([], row_to_word)?;
    items.collect()
}

/// 随机抽取 N 个已掌握词（回炉复习用）：`ORDER BY RANDOM()` 让每次回炉的批次不同，
/// 避免总是复习同一批已掌握词。limit 非法时按 1 兜底。
pub fn list_mastered_sample(conn: &Connection, limit: i64) -> Result<Vec<VocabWord>> {
    let sql = format!(
        "SELECT {} FROM vocab_words WHERE status = 'mastered' ORDER BY RANDOM() LIMIT ?1",
        WORD_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt.query_map(rusqlite::params![limit.max(1)], row_to_word)?;
    items.collect()
}

/// 全量复习记录（备份导出用）
pub fn list_all_review_logs(
    conn: &Connection,
) -> Result<Vec<crate::models::VocabReviewLog>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, word_id, review_date, rating, repetition, interval_days, ease_factor, reviewed_at \
         FROM vocab_reviews ORDER BY reviewed_at ASC",
    )?;
    let items = stmt.query_map([], |row| {
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

/// insert_review_log 的业务参数封装（除 conn 外）
#[derive(Debug)]
pub struct InsertReviewLogArgs<'a> {
    pub id: &'a str,
    pub word_id: &'a str,
    pub review_date: &'a str,
    pub rating: i64,
    pub repetition: i64,
    pub interval_days: i64,
    pub ease_factor: f64,
    pub reviewed_at: &'a str,
}

/// 插入一条复习记录
pub fn insert_review_log(conn: &Connection, args: InsertReviewLogArgs<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO vocab_reviews (id, word_id, review_date, rating, repetition, interval_days, ease_factor, reviewed_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![args.id, args.word_id, args.review_date, args.rating, args.repetition, args.interval_days, args.ease_factor, args.reviewed_at],
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
