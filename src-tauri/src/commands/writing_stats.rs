//! 写作统计 IPC 命令
//!
//! 为编辑器状态栏提供日更目标 / 今日字数 / 连续天数 / 字数曲线数据。

use crate::db::AppDb;
use crate::error::AppError;
use crate::service::writing_stats_service;
use tauri::{AppHandle, State};

/// 单日写作量（曲线数据点）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWords {
    pub date: String,
    pub words: i64,
}

/// 写作统计聚合结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingStats {
    pub daily_target: i64,
    pub today_words: i64,
    pub streak_days: i64,
    pub last_days: Vec<DailyWords>,
}

/// 查询书籍写作统计
#[tauri::command]
pub async fn get_writing_stats(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
) -> Result<WritingStats, AppError> {
    writing_stats_service::get_writing_stats(&app, &db, &book_id)
}
