//! 任务卡提醒 IPC 命令

use crate::db::AppDb;
use crate::error::AppError;
use crate::service::reminder_service;
use tauri::{AppHandle, State};

/// 手动触发一次到期/逾期提醒扫描（调试 & 设置页「立即检查」）
#[tauri::command]
pub fn reminder_check(app: AppHandle, _state: State<AppDb>) -> Result<usize, AppError> {
    reminder_service::check_now(&app)
}
