//! 卷管理 IPC 命令
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Volume;
use crate::service::volume_service;

/// 列出指定书籍的所有未删除卷，按 sort_order 升序
#[tauri::command]
pub async fn list_volumes(app: AppHandle, db: State<'_, AppDb>, book_id: String) -> Result<Vec<Volume>, AppError> {
    volume_service::list_volumes(&app, &db, &book_id)
}

/// 列出指定书籍所有已软删除的卷，按删除时间倒序
#[tauri::command]
pub async fn list_deleted_volumes(app: AppHandle, db: State<'_, AppDb>, book_id: String) -> Result<Vec<Volume>, AppError> {
    volume_service::list_deleted_volumes(&app, &db, &book_id)
}

/// 创建新卷，生成 UUID
#[tauri::command]
pub async fn create_volume(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    title: String,
    sort_order: i64,
) -> Result<Volume, AppError> {
    volume_service::create_volume(&app, &db, &book_id, &title, sort_order)
}

/// 更新卷标题
#[tauri::command]
pub async fn update_volume(app: AppHandle, db: State<'_, AppDb>, id: String, title: String) -> Result<(), AppError> {
    volume_service::update_volume(&app, &db, &id, &title)
}

/// 软删除卷（设置 deleted_at），下属章节 volume_id 置 NULL
#[tauri::command]
pub async fn delete_volume(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), AppError> {
    volume_service::delete_volume(&app, &db, &id)
}

/// 恢复已软删除的卷（清除 deleted_at）
#[tauri::command]
pub async fn restore_volume(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), AppError> {
    volume_service::restore_volume(&app, &db, &id)
}

/// 硬删除卷
#[tauri::command]
pub async fn hard_delete_volume(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), AppError> {
    volume_service::hard_delete_volume(&app, &db, &id)
}

/// 重新排序卷（按传入 ID 顺序更新 sort_order）
#[tauri::command]
pub async fn reorder_volumes(app: AppHandle, db: State<'_, AppDb>, ids: Vec<String>) -> Result<(), AppError> {
    volume_service::reorder_volumes(&app, &db, &ids)
}
