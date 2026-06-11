//! 版本快照业务服务
//!
//! 封装快照创建、查询、恢复等业务逻辑，
//! 包含恢复后的事件通知。

use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Snapshot;
use crate::commands::chapter::SaveChapterResult;
use crate::commands::window::emit_sql_log;
use crate::utils::now;
use crate::repository::{snapshot_repo, chapter_repo, book_repo};

/// 列出章节的所有快照
pub fn list_snapshots(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<Vec<Snapshot>, AppError> {
    emit_sql_log(app, "SELECT", "snapshots", &format!("chapter_id={chapter_id}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(snapshot_repo::list_by_chapter(&conn, chapter_id)?)
}

/// 创建快照（auto/milestone）
pub fn create_snapshot(
    app: &AppHandle,
    db: &AppDb,
    chapter_id: &str,
    label: &Option<String>,
) -> Result<Snapshot, AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, for snapshot content"), file!(), line!());
    let (content_html, word_count) = chapter_repo::find_content_and_wc(&conn, chapter_id)?;

    let id = Uuid::new_v4().to_string();
    let ts = now();
    let snap_type = if label.is_some() { "milestone" } else { "auto" };

    emit_sql_log(app, "INSERT", "snapshots",
        &format!("id={id}, chapter_id={chapter_id}, type={snap_type}"), file!(), line!());
    snapshot_repo::insert(&conn, &id, chapter_id, &content_html, word_count, snap_type, label, &ts)?;

    Ok(Snapshot {
        id,
        chapter_id: chapter_id.to_string(),
        content_html,
        word_count,
        snapshot_type: snap_type.to_string(),
        label: label.clone(),
        created_at: ts,
    })
}

/// 获取快照内容
pub fn get_snapshot_content(app: &AppHandle, db: &AppDb, snapshot_id: &str) -> Result<String, AppError> {
    emit_sql_log(app, "SELECT", "snapshots", &format!("id={snapshot_id}, content_html"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(snapshot_repo::find_content(&conn, snapshot_id)?)
}

/// 从快照恢复章节内容
pub fn restore_snapshot(app: &AppHandle, db: &AppDb, snapshot_id: &str) -> Result<SaveChapterResult, AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "SELECT", "snapshots", &format!("id={snapshot_id}, restore content"), file!(), line!());
    let (chapter_id, content_html, wc) = snapshot_repo::find_full(&conn, snapshot_id)?;

    let ts = now();
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, restore from snapshot"), file!(), line!());
    chapter_repo::save_content(&conn, &chapter_id, &content_html, wc, &ts)?;

    book_repo::update_word_count_by_chapter(&conn, &chapter_id, &ts)?;

    let book_wc = book_repo::word_count_by_chapter(&conn, &chapter_id)?;

    // 通知主窗口刷新编辑器内容
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("history-snapshot-restored", &chapter_id);
    }

    Ok(SaveChapterResult { word_count: wc, book_word_count: book_wc })
}

/// 删除快照
pub fn delete_snapshot(app: &AppHandle, db: &AppDb, snapshot_id: &str) -> Result<(), AppError> {
    emit_sql_log(app, "DELETE", "snapshots", &format!("id={snapshot_id}"), file!(), line!());
    let conn = db.pool.get()?;
    snapshot_repo::delete(&conn, snapshot_id)?;
    Ok(())
}