//! 写作统计数据访问层
//!
//! 维护书籍维度的「按日净增字数」。写入发生在保存章节时
//! （delta = 新字数 − 旧字数，仅累加正增量），查询用于支撑
//! 日更进度条 / 连续天数 / 近 30 日字数曲线。

use rusqlite::{params, Connection, Result};

/// 累加当日净增字数（跨天首写自动建行）
pub fn record_delta(conn: &Connection, book_id: &str, stat_date: &str, delta: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO writing_stats (book_id, stat_date, words) VALUES (?1, ?2, ?3)
         ON CONFLICT(book_id, stat_date) DO UPDATE SET words = words + excluded.words",
        params![book_id, stat_date, delta],
    )?;
    Ok(())
}

/// 查询自某日起（含）的逐日字数，升序返回 `(stat_date, words)`
pub fn list_since(
    conn: &Connection,
    book_id: &str,
    since_date: &str,
) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT stat_date, words FROM writing_stats
         WHERE book_id=?1 AND stat_date >= ?2 ORDER BY stat_date ASC",
    )?;
    let rows = stmt.query_map(params![book_id, since_date], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    rows.collect()
}
