//! 操作日志 IPC 命令（任务卡 P2）
//!
//! 只读查询：任务动态时间线 / 项目动态。写入由各业务服务的埋点完成。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{ActivityLog, ProjectWeeklyStat};
use crate::service::project_stats_service;
use crate::commands::window::emit_sql_log;
use crate::repository::activity_log_repo;

/// 某任务的动态时间线（最新在前；limit 默认 30，最大 200）
#[tauri::command]
pub fn activity_list_task(
    app: AppHandle,
    state: State<AppDb>,
    task_id: String,
    limit: Option<u32>,
) -> Result<Vec<ActivityLog>, AppError> {
    let limit = limit.unwrap_or(30).clamp(1, 200) as i64;
    emit_sql_log(&app, "SELECT", "task_activity_logs", &format!("task_id={task_id}"), file!(), line!());
    let conn = state.pool.get()?;
    Ok(activity_log_repo::list_by_task(&conn, &task_id, limit)?)
}

/// 某项目的动态时间线（最新在前；limit 默认 30，最大 200）
#[tauri::command]
pub fn activity_list_project(
    app: AppHandle,
    state: State<AppDb>,
    project_id: String,
    limit: Option<u32>,
) -> Result<Vec<ActivityLog>, AppError> {
    let limit = limit.unwrap_or(30).clamp(1, 200) as i64;
    emit_sql_log(&app, "SELECT", "task_activity_logs", &format!("project_id={project_id}"), file!(), line!());
    let conn = state.pool.get()?;
    Ok(activity_log_repo::list_by_project(&conn, &project_id, limit)?)
}

/// 项目近 N 周新增 / 完成统计（周报用；默认 8 周，最大 26）
#[tauri::command]
pub fn project_weekly_stats(
    app: AppHandle,
    state: State<AppDb>,
    project_id: String,
    weeks: Option<u32>,
) -> Result<Vec<ProjectWeeklyStat>, AppError> {
    project_stats_service::project_weekly_stats(&app, &state, &project_id, weeks.unwrap_or(8))
}
