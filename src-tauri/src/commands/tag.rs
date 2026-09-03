//! 标签 IPC 命令（任务卡模块）
//!
//! 业务逻辑集中在 `service::tag_service`。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Tag;
use crate::service::tag_service;

/// 列出全部标签
#[tauri::command]
pub fn tag_list(app: AppHandle, state: State<AppDb>) -> Result<Vec<Tag>, AppError> {
    tag_service::list_tags(&app, &state)
}

/// 创建标签
#[tauri::command]
pub fn tag_create(
    app: AppHandle,
    state: State<AppDb>,
    name: String,
    color: String,
) -> Result<Tag, AppError> {
    tag_service::create_tag(&app, &state, &name, &color)
}

/// 更新标签（名称/颜色/停启用）
#[tauri::command]
pub fn tag_update(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    args: tag_service::UpdateTagParams,
) -> Result<Tag, AppError> {
    tag_service::update_tag(&app, &state, &id, args)
}

/// 删除标签（返回被移除的关联数）
#[tauri::command]
pub fn tag_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<i64, AppError> {
    tag_service::delete_tag(&app, &state, &id)
}
