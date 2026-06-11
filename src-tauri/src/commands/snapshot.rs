//! 版本快照 IPC 命令
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Snapshot;
use crate::commands::chapter::SaveChapterResult;
use crate::service::snapshot_service;

/// 列出指定章节的所有快照（不含 content_html），按创建时间降序
#[tauri::command]
pub async fn list_snapshots(app: AppHandle, db: State<'_, AppDb>, chapter_id: String) -> Result<Vec<Snapshot>, AppError> {
    snapshot_service::list_snapshots(&app, &db, &chapter_id)
}

/// 创建章节快照（有 label 则为 milestone，否则为 auto）
#[tauri::command]
pub async fn create_snapshot(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
    label: Option<String>,
) -> Result<Snapshot, AppError> {
    snapshot_service::create_snapshot(&app, &db, &chapter_id, &label)
}

/// 获取快照的 content_html
#[tauri::command]
pub async fn get_snapshot_content(app: AppHandle, db: State<'_, AppDb>, snapshot_id: String) -> Result<String, AppError> {
    snapshot_service::get_snapshot_content(&app, &db, &snapshot_id)
}

/// 从快照恢复章节内容
#[tauri::command]
pub async fn restore_snapshot(app: AppHandle, db: State<'_, AppDb>, snapshot_id: String) -> Result<SaveChapterResult, AppError> {
    snapshot_service::restore_snapshot(&app, &db, &snapshot_id)
}

/// 删除指定快照
#[tauri::command]
pub async fn delete_snapshot(app: AppHandle, db: State<'_, AppDb>, snapshot_id: String) -> Result<(), AppError> {
    snapshot_service::delete_snapshot(&app, &db, &snapshot_id)
}
