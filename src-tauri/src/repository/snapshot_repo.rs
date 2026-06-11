//! 快照数据访问层
//!
//! 提供 snapshots 表的 CRUD SQL 操作。

use rusqlite::{Connection, params, Result};
use crate::models::Snapshot;

/// 列出指定章节的所有快照（不含 content_html），按创建时间降序
pub fn list_by_chapter(conn: &Connection, chapter_id: &str) -> Result<Vec<Snapshot>> {
    let mut stmt = conn.prepare(
        "SELECT id,chapter_id,word_count,type,label,created_at FROM snapshots WHERE chapter_id=?1 ORDER BY created_at DESC"
    )?;
    let items = stmt.query_map(params![chapter_id], |row| {
        Ok(Snapshot {
            id: row.get(0)?,
            chapter_id: row.get(1)?,
            content_html: String::new(),
            word_count: row.get(2)?,
            snapshot_type: row.get(3)?,
            label: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 获取快照的 content_html
pub fn find_content(conn: &Connection, snapshot_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT content_html FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| row.get(0),
    )
}

/// 获取快照的完整内容（chapter_id, content_html, word_count）
pub fn find_full(conn: &Connection, snapshot_id: &str) -> Result<(String, String, i64)> {
    conn.query_row(
        "SELECT chapter_id, content_html, word_count FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
}

/// 创建新快照
pub fn insert(
    conn: &Connection,
    id: &str,
    chapter_id: &str,
    content_html: &str,
    word_count: i64,
    snapshot_type: &str,
    label: &Option<String>,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO snapshots (id,chapter_id,content_html,word_count,type,label,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, chapter_id, content_html, word_count, snapshot_type, label, created_at],
    )?;
    Ok(())
}

/// 列出所有快照，用于备份导出
pub fn list_all(conn: &Connection) -> Result<Vec<Snapshot>> {
    let mut stmt = conn.prepare(
        "SELECT id,chapter_id,content_html,word_count,type,label,created_at FROM snapshots"
    )?;
    let items = stmt.query_map([], |row| {
        Ok(Snapshot {
            id: row.get(0)?,
            chapter_id: row.get(1)?,
            content_html: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            word_count: row.get(3)?,
            snapshot_type: row.get(4)?,
            label: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    items.collect()
}

/// 删除快照
pub fn delete(conn: &Connection, snapshot_id: &str) -> Result<usize> {
    conn.execute("DELETE FROM snapshots WHERE id=?1", params![snapshot_id])
}
