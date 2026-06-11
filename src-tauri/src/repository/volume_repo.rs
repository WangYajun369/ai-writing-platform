//! 卷数据访问层
//!
//! 提供 volumes 表的 CRUD SQL 操作。

use rusqlite::{Connection, params, Result};
use crate::models::Volume;

/// 列出指定书籍的所有未删除卷，按 sort_order 升序
pub fn list_by_book(conn: &Connection, book_id: &str) -> Result<Vec<Volume>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at,deleted_at FROM volumes WHERE book_id=?1 AND deleted_at IS NULL ORDER BY sort_order"
    )?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 列出指定书籍所有已软删除的卷，按删除时间倒序
pub fn list_deleted_by_book(conn: &Connection, book_id: &str) -> Result<Vec<Volume>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at,deleted_at FROM volumes WHERE book_id=?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    )?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 判断指定卷是否存在且未被删除
pub fn exists_active(conn: &Connection, id: &str) -> Result<bool> {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM volumes WHERE id=?1 AND deleted_at IS NULL",
        params![id],
        |row| row.get(0),
    )
}

/// 插入新卷
pub fn insert(
    conn: &Connection,
    id: &str,
    book_id: &str,
    title: &str,
    sort_order: i64,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO volumes (id,book_id,title,sort_order,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, book_id, title, sort_order, created_at],
    )?;
    Ok(())
}

/// 更新卷标题
pub fn update_title(conn: &Connection, id: &str, title: &str) -> Result<usize> {
    conn.execute("UPDATE volumes SET title=?1 WHERE id=?2", params![title, id])
}

/// 软删除卷（设置 deleted_at），同时解除下属未删除章节的卷关联
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE volumes SET deleted_at=?1 WHERE id=?2",
        params![ts, id],
    )?;
    // 将下属未删除章节的 volume_id 置 NULL
    conn.execute(
        "UPDATE chapters SET volume_id=NULL WHERE volume_id=?1 AND deleted_at IS NULL",
        params![id],
    )?;
    Ok(())
}

/// 恢复已软删除的卷
pub fn restore(conn: &Connection, id: &str) -> Result<usize> {
    conn.execute("UPDATE volumes SET deleted_at=NULL WHERE id=?1", params![id])
}

/// 硬删除卷
pub fn hard_delete(conn: &Connection, id: &str) -> Result<usize> {
    conn.execute("DELETE FROM volumes WHERE id=?1", params![id])
}

/// 列出所有卷（含已删除），用于备份导出
pub fn list_all_include_deleted(conn: &Connection) -> Result<Vec<Volume>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at,deleted_at FROM volumes"
    )?;
    let items = stmt.query_map([], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 重新排序卷（按传入 ID 顺序更新 sort_order）
pub fn reorder(conn: &Connection, ids: &[String]) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE volumes SET sort_order=?1 WHERE id=?2",
            params![i as i64, id],
        )?;
    }
    Ok(())
}
