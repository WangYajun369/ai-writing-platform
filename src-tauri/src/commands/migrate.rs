//! 个人日程迁移 IPC 命令
//!
//! 将旧「个人日程」数据幂等迁移为任务卡项目数据，重复执行不会重复导入。
//! 对应 tauri-bridge.ts 的 `taskCardApi.migrateSchedules`，由任务卡设置页触发。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::MigrateResult;
use crate::service::migrate_service;
use tauri::{AppHandle, State};

/// 执行个人日程 → 任务卡迁移（幂等）
#[tauri::command]
pub fn migrate_schedules(app: AppHandle, state: State<AppDb>) -> Result<MigrateResult, AppError> {
    migrate_service::migrate_schedules(&app, &state)
}
