//! 个人日程迁移 IPC 命令

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::MigrateResult;
use crate::service::migrate_service;

/// 执行个人日程 → 任务卡迁移（幂等）
#[tauri::command]
pub fn migrate_schedules(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<MigrateResult, AppError> {
    migrate_service::migrate_schedules(&app, &state)
}
