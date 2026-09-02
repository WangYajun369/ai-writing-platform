//! 日程管理 IPC 命令
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理。

use tauri::{AppHandle, State};
use serde::Deserialize;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Schedule;
use crate::service::schedule_service;

/// 保存日程参数
#[derive(Deserialize)]
pub struct SaveScheduleParams {
    pub id: Option<String>,
    /// 日程日期 YYYY-MM-DD
    #[serde(rename = "scheduleDate")]
    pub schedule_date: String,
    pub content: String,
    pub done: bool,
}

/// 列出某日期下的全部日程
#[tauri::command]
pub async fn list_schedules_by_date(
    app: AppHandle,
    db: State<'_, AppDb>,
    date: String,
) -> Result<Vec<Schedule>, AppError> {
    schedule_service::list_by_date(&app, &db, &date)
}

/// 列出某年某月下的全部日程（日历状态点用）
#[tauri::command]
pub async fn list_schedules_by_month(
    app: AppHandle,
    db: State<'_, AppDb>,
    year: i32,
    month: i32,
) -> Result<Vec<Schedule>, AppError> {
    schedule_service::list_by_month(&app, &db, year, month)
}

/// 保存日程（新建或更新）
#[tauri::command]
pub async fn save_schedule(
    app: AppHandle,
    db: State<'_, AppDb>,
    params: SaveScheduleParams,
) -> Result<Schedule, AppError> {
    schedule_service::save_schedule(
        &app,
        &db,
        params.id,
        &params.schedule_date,
        &params.content,
        params.done,
    )
}

/// 按 id 删除日程
#[tauri::command]
pub async fn delete_schedule(
    app: AppHandle,
    db: State<'_, AppDb>,
    id: String,
) -> Result<(), AppError> {
    schedule_service::delete_schedule(&app, &db, &id)
}
