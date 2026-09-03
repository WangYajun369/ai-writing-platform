//! 任务 IPC 命令（任务卡模块）
//!
//! 业务逻辑集中在 `service::task_service`。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{TaskCard, TodayOverview};
use crate::service::task_service;

/// 列出某项目全部任务（含标签）
#[tauri::command]
pub fn task_list(
    app: AppHandle,
    state: State<AppDb>,
    project_id: String,
) -> Result<Vec<TaskCard>, AppError> {
    task_service::list_tasks(&app, &state, &project_id)
}

/// 列出全部未删除任务（跨项目，今日页聚合用）
#[tauri::command]
pub fn task_list_all(app: AppHandle, state: State<AppDb>) -> Result<Vec<TaskCard>, AppError> {
    task_service::list_all_tasks(&app, &state)
}

/// 获取单个任务（含标签）
#[tauri::command]
pub fn task_get(app: AppHandle, state: State<AppDb>, id: String) -> Result<TaskCard, AppError> {
    task_service::get_task(&app, &state, &id)
}

/// 创建任务
#[tauri::command]
pub fn task_create(
    app: AppHandle,
    state: State<AppDb>,
    args: task_service::CreateTaskParams,
) -> Result<TaskCard, AppError> {
    task_service::create_task(&app, &state, args)
}

/// 更新任务（部分更新；标签传 Some 时整体替换）
#[tauri::command]
pub fn task_update(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    args: task_service::UpdateTaskParams,
) -> Result<TaskCard, AppError> {
    task_service::update_task(&app, &state, &id, args)
}

/// 状态切换 / 勾选完成 / 重新打开（移动到目标列尾）。
/// `completion_summary`：勾选完成时前端携带的富文本总结（HTML，可为空串；None = 不改动）。
#[tauri::command]
pub fn task_set_status(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    status: String,
    completion_summary: Option<String>,
) -> Result<TaskCard, AppError> {
    task_service::set_task_status(
        &app,
        &state,
        &id,
        &status,
        completion_summary.as_deref(),
    )
}

/// 看板拖拽：跨列改状态 + 按目标列顺序重排
#[tauri::command]
pub fn task_drag(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    to_status: String,
    ordered_ids: Vec<String>,
) -> Result<(), AppError> {
    task_service::drag_task(&app, &state, &id, &to_status, ordered_ids)
}

/// 复制任务（状态置待办，排到待办列尾）
#[tauri::command]
pub fn task_copy(app: AppHandle, state: State<AppDb>, id: String) -> Result<TaskCard, AppError> {
    task_service::copy_task(&app, &state, &id)
}

/// 移动任务到其他项目
#[tauri::command]
pub fn task_move_to_project(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    to_project_id: String,
) -> Result<TaskCard, AppError> {
    task_service::move_task_to_project(&app, &state, &id, &to_project_id)
}

/// 软删除任务
#[tauri::command]
pub fn task_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    task_service::delete_task(&app, &state, &id)
}

/// 恢复任务（所属项目需未删除）
#[tauri::command]
pub fn task_restore(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    task_service::restore_task(&app, &state, &id)
}

/// 彻底删除任务
#[tauri::command]
pub fn task_hard_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    task_service::hard_delete_task(&app, &state, &id)
}

/// 列出回收站中的任务（含所属项目名）
#[tauri::command]
pub fn task_list_deleted(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<Vec<task_service::DeletedTaskItem>, AppError> {
    task_service::list_deleted_tasks(&app, &state)
}

/// 清空任务回收站
#[tauri::command]
pub fn task_clear_trash(app: AppHandle, state: State<AppDb>) -> Result<u32, AppError> {
    task_service::clear_task_trash(&app, &state)
}

/// 回收站自动清理（手动触发）：硬删除删除时间超过 30 天的项目与任务
#[tauri::command]
pub fn task_purge_expired_trash(app: AppHandle, state: State<AppDb>) -> Result<u32, AppError> {
    task_service::purge_expired_trash(&app, &state)
}

/// 「计划今日」滚动清理（自然日切换后由前端触发）
#[tauri::command]
pub fn task_roll_planned_today(app: AppHandle, state: State<AppDb>) -> Result<u32, AppError> {
    task_service::roll_planned_today(&app, &state)
}

/// 今日任务概览（角标/顶部统计）
#[tauri::command]
pub fn task_today_overview(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<TodayOverview, AppError> {
    task_service::get_today_overview(&app, &state)
}
