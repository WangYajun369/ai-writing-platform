//! 附件 IPC 命令（任务卡 P2）
//!
//! 附件文件实体统一在应用数据目录；「选择并添加」使用系统文件对话框（async 命令
//! 避免主线程阻塞）。业务逻辑集中在 `service::attachment_service`。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Attachment;
use crate::service::attachment_service;

/// 列出某任务的附件
#[tauri::command]
pub fn attachment_list(
    app: AppHandle,
    state: State<AppDb>,
    task_id: String,
) -> Result<Vec<Attachment>, AppError> {
    attachment_service::list_attachments(&app, &state, &task_id)
}

/// 弹出系统文件对话框选择文件并添加为附件；取消返回 None
#[tauri::command]
pub async fn attachment_pick_and_add(
    app: AppHandle,
    state: State<'_, AppDb>,
    task_id: String,
) -> Result<Option<Attachment>, AppError> {
    // async 命令运行在 Tauri 异步线程池（非主线程），可安全调用阻塞式对话框
    attachment_service::pick_and_add(&app, &state, &task_id)
}

/// 用系统默认应用打开附件
#[tauri::command]
pub fn attachment_open(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    attachment_service::open_attachment(&app, &state, &id)
}

/// 删除附件（记录 + 文件）
#[tauri::command]
pub fn attachment_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    attachment_service::delete_attachment(&app, &state, &id)
}

/// 孤儿附件文件清理（回收站每日自动清理调用；手动触发亦可）
#[tauri::command]
pub fn attachment_cleanup_orphans(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<usize, AppError> {
    attachment_service::cleanup_orphan_files(&app, &state)
}
