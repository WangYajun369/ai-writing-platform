//! 任务卡提醒 IPC 命令
//!
//! 提醒扫描由 lib.rs 后台循环每分钟驱动（reminder_service::run_once）；
//! 本命令仅为手动触发入口。对应 tauri-bridge.ts 的 `taskCardApi.reminderCheck`。

use crate::db::AppDb;
use crate::error::AppError;
use crate::service::reminder_service;
use tauri::{AppHandle, State};

/// 手动触发一次到期/逾期提醒扫描（调试 & 设置页「立即检查」）
#[tauri::command]
pub fn reminder_check(app: AppHandle, _state: State<AppDb>) -> Result<usize, AppError> {
    // service 内部经 app.state 获取数据库连接，故此处 State 参数未直接使用
    reminder_service::check_now(&app)
}
