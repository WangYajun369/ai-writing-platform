//! 项目 IPC 命令（任务卡模块）
//!
//! 业务逻辑集中在 `service::project_service`。

use serde::Deserialize;
use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Project, ProjectView};
use crate::service::project_service;

fn default_status() -> String {
    "active".into()
}

/// 创建项目参数
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectArgs {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default = "default_status")]
    pub status: String,
    pub plan_start_date: Option<String>,
    pub plan_end_date: Option<String>,
    #[serde(default)]
    pub pinned: bool,
}

/// 列出项目（可按状态过滤），含实时统计
#[tauri::command]
pub fn project_list(
    app: AppHandle,
    state: State<AppDb>,
    status: Option<String>,
) -> Result<Vec<ProjectView>, AppError> {
    project_service::list_projects(&app, &state, status)
}

/// 获取单个项目（含统计）
#[tauri::command]
pub fn project_get(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
) -> Result<ProjectView, AppError> {
    project_service::get_project(&app, &state, &id)
}

/// 创建项目
#[tauri::command]
pub fn project_create(
    app: AppHandle,
    state: State<AppDb>,
    args: CreateProjectArgs,
) -> Result<Project, AppError> {
    project_service::create_project(
        &app,
        &state,
        &args.name,
        &args.description,
        &args.color,
        &args.icon,
        &args.status,
        args.plan_start_date,
        args.plan_end_date,
        args.pinned,
    )
}

/// 更新项目（部分更新）
#[tauri::command]
pub fn project_update(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    args: project_service::UpdateProjectParams,
) -> Result<Project, AppError> {
    project_service::update_project(&app, &state, &id, args)
}

/// 软删除项目（连带任务）
#[tauri::command]
pub fn project_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    project_service::delete_project(&app, &state, &id)
}

/// 恢复项目（连带任务）
#[tauri::command]
pub fn project_restore(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    project_service::restore_project(&app, &state, &id)
}

/// 彻底删除项目（回收站中）
#[tauri::command]
pub fn project_hard_delete(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
) -> Result<(), AppError> {
    project_service::hard_delete_project(&app, &state, &id)
}

/// 列出回收站中的项目
#[tauri::command]
pub fn project_list_deleted(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<Vec<Project>, AppError> {
    project_service::list_deleted_projects(&app, &state)
}

/// 清空项目回收站，返回清理数量
#[tauri::command]
pub fn project_clear_trash(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<u32, AppError> {
    project_service::clear_project_trash(&app, &state)
}
