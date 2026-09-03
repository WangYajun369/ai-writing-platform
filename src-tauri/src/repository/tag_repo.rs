//! 标签数据访问层（任务卡模块）
//!
//! 提供 tags 表的 CRUD SQL 与 row → Tag 解析。
//! 标签无软删除：删除即物理删除，task_tags 由外键级联清理。

use rusqlite::{Connection, params, Result};
use crate::models::Tag;

/// 完整 SELECT 列名
pub const TAG_SELECT: &str = "id,name,color,status,created_at,updated_at";

/// 从 rusqlite Row 解析 Tag
pub fn parse_tag(row: &rusqlite::Row) -> Result<Tag> {
    Ok(Tag {
        id: row.get("id")?,
        name: row.get("name")?,
        color: row.get("color")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 列出全部标签（含停用），按创建时间升序
pub fn list_all(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TAG_SELECT} FROM tags ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map([], |row| parse_tag(row))?;
    rows.collect()
}

/// 按名称精确查询（标签名唯一），不存在返回 None
pub fn find_by_name(conn: &Connection, name: &str) -> Result<Option<Tag>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TAG_SELECT} FROM tags WHERE name=?1"
    ))?;
    let mut rows = stmt.query_map(params![name], |row| parse_tag(row))?;
    match rows.next() {
        Some(r) => r.map(Some),
        None => Ok(None),
    }
}

/// 按 id 查询标签
pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<Tag>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TAG_SELECT} FROM tags WHERE id=?1"
    ))?;
    let mut rows = stmt.query_map(params![id], |row| parse_tag(row))?;
    match rows.next() {
        Some(r) => r.map(Some),
        None => Ok(None),
    }
}

/// 插入标签
pub fn insert(conn: &Connection, id: &str, name: &str, color: &str, ts: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO tags (id,name,color,status,created_at,updated_at) VALUES (?1,?2,?3,'enabled',?4,?4)",
        params![id, name, color, ts],
    )?;
    Ok(())
}

/// 更新标签字段（name/color/status 非空覆盖）
pub fn update(
    conn: &Connection,
    id: &str,
    name: &str,
    color: &str,
    status: &str,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE tags SET name=?1, color=?2, status=?3, updated_at=?4 WHERE id=?5",
        params![name, color, status, ts, id],
    )?;
    Ok(())
}

/// 删除标签（task_tags 关联由外键 ON DELETE CASCADE 级联清理）
pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM tags WHERE id=?1", params![id])?;
    Ok(())
}

/// 统计某标签被多少任务使用（供删除前提示）
pub fn usage_count(conn: &Connection, id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM task_tags WHERE tag_id=?1",
        params![id],
        |row| row.get(0),
    )
}
