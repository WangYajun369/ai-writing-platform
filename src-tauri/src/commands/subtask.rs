//! 子任务 IPC 命令（任务卡 P2）
//!
//! 业务逻辑集中在 `service::subtask_service`。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::TaskSubtask;
use crate::service::subtask_service;
use tauri::{AppHandle, State};

/// 列出某任务全部子任务
#[tauri::command]
pub fn subtask_list(
    app: AppHandle,
    state: State<AppDb>,
    task_id: String,
) -> Result<Vec<TaskSubtask>, AppError> {
    subtask_service::list_subtasks(&app, &state, &task_id)
}

/// 创建子任务
#[tauri::command]
pub fn subtask_create(
    app: AppHandle,
    state: State<AppDb>,
    task_id: String,
    title: String,
) -> Result<TaskSubtask, AppError> {
    subtask_service::create_subtask(&app, &state, &task_id, &title)
}

/// 重命名子任务
#[tauri::command]
pub fn subtask_update(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    title: String,
) -> Result<TaskSubtask, AppError> {
    subtask_service::update_subtask(&app, &state, &id, &title)
}

/// 勾选 / 取消完成
#[tauri::command]
pub fn subtask_set_done(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    done: bool,
) -> Result<TaskSubtask, AppError> {
    subtask_service::set_subtask_done(&app, &state, &id, done)
}

/// 子任务重排（ordered_ids 为完整顺序）
#[tauri::command]
pub fn subtask_reorder(
    app: AppHandle,
    state: State<AppDb>,
    task_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), AppError> {
    subtask_service::reorder_subtasks(&app, &state, &task_id, ordered_ids)
}

/// 删除子任务（硬删）
#[tauri::command]
pub fn subtask_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    subtask_service::delete_subtask(&app, &state, &id)
}
