//! 日记管理 IPC 命令
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理。

use tauri::{AppHandle, State};
use serde::Deserialize;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Diary, DiaryMeta};
use crate::service::diary_service;

/// 保存日记参数
#[derive(Deserialize)]
pub struct SaveDiaryParams {
    /// 日记日期 YYYY-MM-DD
    #[serde(rename = "diaryDate")]
    pub diary_date: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    /// 关键字列表
    pub keywords: Vec<String>,
}

/// 列出指定年月的日记摘要（不含正文），按日期升序
#[tauri::command]
pub async fn list_month_diaries(
    app: AppHandle,
    db: State<'_, AppDb>,
    year: i64,
    month: i64,
) -> Result<Vec<DiaryMeta>, AppError> {
    diary_service::list_month(&app, &db, year, month)
}

/// 列出全部日记摘要（不含正文），按日期升序（书页式「看日记」浏览用）
#[tauri::command]
pub async fn list_all_diaries(
    app: AppHandle,
    db: State<'_, AppDb>,
) -> Result<Vec<DiaryMeta>, AppError> {
    diary_service::list_all(&app, &db)
}

/// 按日期获取日记全文，不存在时返回 null
#[tauri::command]
pub async fn get_diary(
    app: AppHandle,
    db: State<'_, AppDb>,
    date: String,
) -> Result<Option<Diary>, AppError> {
    diary_service::get_by_date(&app, &db, &date)
}

/// 保存日记（该日期已存在则覆盖，否则新建）
#[tauri::command]
pub async fn save_diary(
    app: AppHandle,
    db: State<'_, AppDb>,
    params: SaveDiaryParams,
) -> Result<Diary, AppError> {
    diary_service::save_diary(
        &app,
        &db,
        &params.diary_date,
        &params.content_html,
        params.word_count,
        &params.keywords,
    )
}

/// 按日期删除日记
#[tauri::command]
pub async fn delete_diary(
    app: AppHandle,
    db: State<'_, AppDb>,
    date: String,
) -> Result<(), AppError> {
    diary_service::delete_diary(&app, &db, &date)
}
