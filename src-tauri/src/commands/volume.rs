//! 卷管理 IPC 命令
//!
//! 提供书籍卷的增删改查与排序操作，支持软删除 (deleted_at)。

use tauri::{AppHandle, State};
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use crate::db::AppDb;
use crate::models::Volume;
use crate::commands::window::emit_sql_log;

/// 获取当前 UTC 时间
fn now() -> String { Utc::now().to_rfc3339() }

/// 列出指定书籍的所有未删除卷，按 sort_order 升序
#[tauri::command]
pub async fn list_volumes(app: AppHandle, db: State<'_, AppDb>, book_id: String) -> Result<Vec<Volume>, String> {
    emit_sql_log(&app, "SELECT", "volumes", &format!("book_id={}", book_id), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at,deleted_at FROM volumes WHERE book_id=?1 AND deleted_at IS NULL ORDER BY sort_order"
    ).map_err(|e| e.to_string())?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 列出指定书籍所有已软删除的卷，按删除时间倒序
#[tauri::command]
pub async fn list_deleted_volumes(app: AppHandle, db: State<'_, AppDb>, book_id: String) -> Result<Vec<Volume>, String> {
    emit_sql_log(&app, "SELECT", "volumes", &format!("book_id={}, deleted", book_id), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at,deleted_at FROM volumes WHERE book_id=?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    ).map_err(|e| e.to_string())?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 创建新卷，生成 UUID
#[tauri::command]
pub async fn create_volume(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    title: String,
    sort_order: i64,
) -> Result<Volume, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    emit_sql_log(&app, "INSERT", "volumes", &format!("id={}, title={}, book_id={}", id, title, book_id), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "INSERT INTO volumes (id,book_id,title,sort_order,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, book_id, title, sort_order, ts],
    ).map_err(|e| e.to_string())?;
    Ok(Volume { id, book_id, title, sort_order, created_at: ts, deleted_at: None })
}

/// 更新卷标题
#[tauri::command]
pub async fn update_volume(app: AppHandle, db: State<'_, AppDb>, id: String, title: String) -> Result<(), String> {
    emit_sql_log(&app, "UPDATE", "volumes", &format!("id={}, title={}", id, title), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute("UPDATE volumes SET title=?1 WHERE id=?2", params![title, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 软删除卷（设置 deleted_at 时间戳），下属章节 volume_id 置 NULL
#[tauri::command]
pub async fn delete_volume(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let ts = now();
    emit_sql_log(&app, "UPDATE", "volumes", &format!("id={}, soft delete", id), file!(), line!());
    conn.execute(
        "UPDATE volumes SET deleted_at=?1 WHERE id=?2",
        params![ts, id],
    ).map_err(|e| e.to_string())?;
    // 将下属未删除章节的 volume_id 置 NULL（解除关联）
    emit_sql_log(&app, "UPDATE", "chapters", &format!("set volume_id=NULL where volume_id={}", id), file!(), line!());
    conn.execute(
        "UPDATE chapters SET volume_id=NULL WHERE volume_id=?1 AND deleted_at IS NULL",
        params![id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 恢复已软删除的卷（清除 deleted_at）
#[tauri::command]
pub async fn restore_volume(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), String> {
    emit_sql_log(&app, "UPDATE", "volumes", &format!("id={}, restore", id), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "UPDATE volumes SET deleted_at=NULL WHERE id=?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 硬删除卷（真正从数据库删除记录）
#[tauri::command]
pub async fn hard_delete_volume(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), String> {
    emit_sql_log(&app, "DELETE", "volumes", &format!("id={}, hard delete", id), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute("DELETE FROM volumes WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 重新排序卷（按传入 ID 顺序更新 sort_order）
#[tauri::command]
pub async fn reorder_volumes(app: AppHandle, db: State<'_, AppDb>, ids: Vec<String>) -> Result<(), String> {
    emit_sql_log(&app, "UPDATE", "volumes", &format!("reorder {} volumes", ids.len()), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    for (i, id) in ids.iter().enumerate() {
        conn.execute("UPDATE volumes SET sort_order=?1 WHERE id=?2", params![i as i64, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
