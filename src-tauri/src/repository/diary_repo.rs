//! 日记数据访问层
//!
//! 提供 diaries 表的 CRUD SQL 操作。每篇日记以 `diary_date`（YYYY-MM-DD）
//! 为业务主键，同一天只会存在一篇日记。

use crate::models::{Diary, DiaryMeta};
use rusqlite::{params, Connection, OptionalExtension, Result};

/// 解析数据库中的 keywords JSON 字符串为 Vec<String>
pub fn parse_keywords(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}

/// 列出日期区间 [start, end) 内的所有日记摘要，按日期升序
pub fn list_in_range(conn: &Connection, start: &str, end: &str) -> Result<Vec<DiaryMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, diary_date, word_count, keywords, created_at, updated_at \
         FROM diaries WHERE diary_date >= ?1 AND diary_date < ?2 ORDER BY diary_date ASC",
    )?;
    let items = stmt.query_map(params![start, end], |row| {
        Ok(DiaryMeta {
            id: row.get(0)?,
            diary_date: row.get(1)?,
            word_count: row.get(2)?,
            keywords: parse_keywords(row.get(3)?),
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 列出全部日记摘要（不含正文），按日期升序（书页式「看日记」浏览用）
pub fn list_all(conn: &Connection) -> Result<Vec<DiaryMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, diary_date, word_count, keywords, created_at, updated_at \
         FROM diaries ORDER BY diary_date ASC",
    )?;
    let items = stmt.query_map([], |row| {
        Ok(DiaryMeta {
            id: row.get(0)?,
            diary_date: row.get(1)?,
            word_count: row.get(2)?,
            keywords: parse_keywords(row.get(3)?),
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 按日期获取日记全文，不存在返回 None
pub fn find_by_date(conn: &Connection, date: &str) -> Result<Option<Diary>> {
    let result = conn
        .query_row(
            "SELECT id, diary_date, content_html, word_count, keywords, created_at, updated_at \
             FROM diaries WHERE diary_date = ?1",
            params![date],
            |row| {
                Ok(Diary {
                    id: row.get(0)?,
                    diary_date: row.get(1)?,
                    content_html: row.get(2)?,
                    word_count: row.get(3)?,
                    keywords: parse_keywords(row.get(4)?),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(result)
}

/// 保存日记：已存在则更新（保留 created_at），否则插入新记录
pub fn upsert(
    conn: &Connection,
    id: &str,
    date: &str,
    content_html: &str,
    word_count: i64,
    keywords_json: &str,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE diaries SET content_html = ?1, word_count = ?2, keywords = ?3, updated_at = ?4 WHERE diary_date = ?5",
        params![content_html, word_count, keywords_json, ts, date],
    )?;
    // 先 UPDATE：影响行数为 0 说明该日期尚不存在，回退为 INSERT（幂等 upsert）
    if conn.changes() == 0 {
        conn.execute(
            "INSERT INTO diaries (id, diary_date, content_html, word_count, keywords, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, date, content_html, word_count, keywords_json, ts],
        )?;
    }
    Ok(())
}

/// 按日期删除日记（不存在时静默成功）
pub fn delete_by_date(conn: &Connection, date: &str) -> Result<()> {
    conn.execute("DELETE FROM diaries WHERE diary_date = ?1", params![date])?;
    Ok(())
}

/// 日记全文检索（FTS5）：返回 (id, diary_date, word_count, keywords_json, content_html)
pub fn search_fts5(
    conn: &Connection,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<(String, String, i64, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.diary_date, d.word_count, d.keywords, d.content_html \
         FROM diaries d \
         INNER JOIN diaries_fts fts ON d.rowid = fts.rowid \
         WHERE diaries_fts MATCH ?1 \
         ORDER BY rank \
         LIMIT ?2",
    )?;
    let items = stmt.query_map(params![fts_query, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    items.collect()
}

/// 日记搜索降级（LIKE）：返回 (id, diary_date, word_count, keywords_json, content_html)
pub fn search_like(
    conn: &Connection,
    pattern: &str,
    limit: usize,
) -> Result<Vec<(String, String, i64, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, diary_date, word_count, keywords, content_html \
         FROM diaries \
         WHERE content_html LIKE ?1 OR keywords LIKE ?1 \
         ORDER BY diary_date DESC \
         LIMIT ?2",
    )?;
    let items = stmt.query_map(params![pattern, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    items.collect()
}

/// 日记聚合：返回 (累计天数, 累计字数)
pub fn aggregate_totals(conn: &Connection) -> Result<(i64, i64)> {
    let row = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(word_count), 0) FROM diaries",
        [],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;
    Ok(row)
}

/// 全部日记日期（升序），用于连续天数计算
pub fn all_dates(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT diary_date FROM diaries ORDER BY diary_date ASC")?;
    let items = stmt.query_map([], |row| row.get::<_, String>(0))?;
    items.collect()
}

/// 最近 N 个月（from `since` 月起）按月聚合：(month, words, days)
pub fn monthly_words(conn: &Connection, since: &str) -> Result<Vec<(String, i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT substr(diary_date, 1, 7) AS m, COALESCE(SUM(word_count), 0), COUNT(*) \
         FROM diaries \
         WHERE diary_date >= ?1 \
         GROUP BY m \
         ORDER BY m ASC",
    )?;
    let items = stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    items.collect()
}
