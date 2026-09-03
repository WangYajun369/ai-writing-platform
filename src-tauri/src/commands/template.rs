//! 任务模板 IPC 命令（任务卡 P2）
//!
//! 模板管理 + 一键套用创建任务，业务逻辑集中在 `service::template_service`。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{TaskCard, TaskTemplate};
use crate::service::template_service;

/// 列出全部模板
#[tauri::command]
pub fn template_list(app: AppHandle, state: State<AppDb>) -> Result<Vec<TaskTemplate>, AppError> {
    template_service::list_templates(&app, &state)
}

/// 创建模板
#[tauri::command]
pub fn template_create(
    app: AppHandle,
    state: State<AppDb>,
    args: template_service::CreateTemplateParams,
) -> Result<TaskTemplate, AppError> {
    template_service::create_template(&app, &state, args)
}

/// 更新模板（全可选局部更新）
#[tauri::command]
pub fn template_update(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    args: template_service::UpdateTemplateParams,
) -> Result<TaskTemplate, AppError> {
    template_service::update_template(&app, &state, &id, args)
}

/// 删除模板
#[tauri::command]
pub fn template_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    template_service::delete_template(&app, &state, &id)
}

/// 一键套用模板创建任务
#[tauri::command]
pub fn task_create_from_template(
    app: AppHandle,
    state: State<AppDb>,
    template_id: String,
    project_id: String,
    due_time: Option<String>,
) -> Result<TaskCard, AppError> {
    template_service::create_task_from_template(&app, &state, &template_id, &project_id, due_time)
}
