//! 任务卡模块 key-value / 提醒偏好 IPC 命令

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::service::task_meta_service;

/// 读取任意 key
#[tauri::command]
pub fn task_meta_get(
    app: AppHandle,
    state: State<AppDb>,
    key: String,
) -> Result<Option<String>, AppError> {
    task_meta_service::get_meta(&app, &state, &key)
}

/// 写入任意 key
#[tauri::command]
pub fn task_meta_set(
    app: AppHandle,
    state: State<AppDb>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    task_meta_service::set_meta(&app, &state, &key, &value)
}

/// 读取提醒偏好（JSON 字符串）
#[tauri::command]
pub fn reminder_prefs_get(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<Option<String>, AppError> {
    task_meta_service::get_reminder_prefs(&app, &state)
}

/// 保存提醒偏好（JSON 字符串整体覆盖）
#[tauri::command]
pub fn reminder_prefs_set(
    app: AppHandle,
    state: State<AppDb>,
    json: String,
) -> Result<(), AppError> {
    task_meta_service::set_reminder_prefs(&app, &state, &json)
}
