//! 附件数据访问层（任务卡 P2，PRD 12.4）
//!
//! attachments 表存元数据与 local_path；文件实体放应用数据目录。
//! 软删除（deleted=1）保留文件路径，供回收站还原与孤儿清理判断。

use crate::models::Attachment;
use rusqlite::{params, Connection, Result};

/// 完整 SELECT 列名
pub const ATTACHMENT_SELECT: &str =
    "id,task_id,file_name,file_type,file_size,local_path,deleted,deleted_at,created_at";

/// 从 rusqlite Row 解析 Attachment（不出网字段直接丢弃）
pub fn parse_attachment(row: &rusqlite::Row) -> Result<Attachment> {
    Ok(Attachment {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        file_name: row.get("file_name")?,
        file_type: row.get("file_type")?,
        file_size: row.get("file_size")?,
        created_at: row.get("created_at")?,
    })
}

/// 列出某任务未删除的附件（按创建时间倒序）
pub fn list_by_task(conn: &Connection, task_id: &str) -> Result<Vec<Attachment>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ATTACHMENT_SELECT} FROM attachments \
         WHERE task_id=?1 AND deleted=0 ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(params![task_id], |row| parse_attachment(row))?;
    rows.collect()
}

/// 查询未删除附件（返回含 local_path 的完整行解析为 (Attachment, String)）
pub fn find_active(conn: &Connection, id: &str) -> Result<(Attachment, String)> {
    conn.query_row(
        &format!("SELECT {ATTACHMENT_SELECT} FROM attachments WHERE id=?1 AND deleted=0"),
        params![id],
        |row| {
            Ok((
                Attachment {
                    id: row.get("id")?,
                    task_id: row.get("task_id")?,
                    file_name: row.get("file_name")?,
                    file_type: row.get("file_type")?,
                    file_size: row.get("file_size")?,
                    created_at: row.get("created_at")?,
                },
                row.get::<_, String>("local_path")?,
            ))
        },
    )
}

/// 插入附件
pub fn insert(
    conn: &Connection,
    id: &str,
    task_id: &str,
    file_name: &str,
    file_type: &str,
    file_size: i64,
    local_path: &str,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO attachments \
            (id,task_id,file_name,file_type,file_size,local_path,deleted,deleted_at,created_at) \
         VALUES (?1,?2,?3,?4,?5,?6,0,NULL,?7)",
        params![id, task_id, file_name, file_type, file_size, local_path, ts],
    )?;
    Ok(())
}

/// 软删除附件（回收站场景由任务级联清理；此处用于「删除附件」）
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE attachments SET deleted=1, deleted_at=?1 WHERE id=?2 AND deleted=0",
        params![ts, id],
    )
}

/// 取全部附件的 local_path（含软删记录，孤儿文件清理对照用；
/// 软删记录已无恢复入口，其文件同样视为可回收）
pub fn all_paths(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT local_path FROM attachments")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// 取全部记录的 (id, local_path)（启动时路径规范化用）
pub fn all_id_paths(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT id, local_path FROM attachments")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}
