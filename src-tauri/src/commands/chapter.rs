//! 章节管理 IPC 命令
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理。

use tauri::{AppHandle, State};
use serde::{Deserialize, Serialize};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Chapter;
use crate::service::chapter_service;

/// 保存章节返回结果（章节字数 + 更新后的全书字数）
#[derive(Serialize)]
pub struct SaveChapterResult {
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    #[serde(rename = "bookWordCount")]
    pub book_word_count: i64,
}

/// 恢复章节返回结果（包含恢复后所在卷 + 更新后的全书字数）
#[derive(Serialize)]
pub struct RestoreChapterResult {
    #[serde(rename = "volumeId")]
    pub volume_id: Option<String>,
    #[serde(rename = "bookWordCount")]
    pub book_word_count: i64,
}

/// 章节总结信息
#[derive(Serialize)]
pub struct ChapterSummaryInfo {
    pub summary: Option<String>,
    #[serde(rename = "summaryAt")]
    pub summary_at: Option<String>,
}

/// 列出指定书籍的所有未删除章节（不含 content_html），按 sort_order 升序
#[tauri::command]
pub async fn list_chapters(app: AppHandle, db: State<'_, AppDb>, book_id: String) -> Result<Vec<Chapter>, AppError> {
    chapter_service::list_chapters(&app, &db, &book_id)
}

/// 获取章节的 content_html 内容
#[tauri::command]
pub async fn get_chapter_content(app: AppHandle, db: State<'_, AppDb>, chapter_id: String) -> Result<String, AppError> {
    chapter_service::get_chapter_content(&app, &db, &chapter_id)
}

/// 创建新章节参数
#[derive(Deserialize)]
pub struct CreateChapterParams {
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "volumeId")]
    pub volume_id: Option<String>,
    pub title: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
}

/// 创建新章节，生成 UUID，初始状态为 draft
#[tauri::command]
pub async fn create_chapter(app: AppHandle, db: State<'_, AppDb>, params: CreateChapterParams) -> Result<Chapter, AppError> {
    chapter_service::create_chapter(&app, &db, &params.book_id, &params.volume_id, &params.title, params.sort_order)
}

/// 保存章节内容（HTML），自动更新书籍总字数并返回
#[tauri::command]
pub async fn save_chapter(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
    content_html: String,
    word_count: i64,
) -> Result<SaveChapterResult, AppError> {
    chapter_service::save_chapter(&app, &db, &chapter_id, &content_html, word_count)
}

/// 更新章节写作状态
#[tauri::command]
pub async fn update_chapter_status(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
    status: String,
) -> Result<(), AppError> {
    chapter_service::update_chapter_status(&app, &db, &chapter_id, &status)
}

/// 重命名章节标题
#[tauri::command]
pub async fn rename_chapter(app: AppHandle, db: State<'_, AppDb>, chapter_id: String, title: String) -> Result<(), AppError> {
    chapter_service::rename_chapter(&app, &db, &chapter_id, &title)
}

/// 列出指定书籍所有已软删除的章节
#[tauri::command]
pub async fn list_deleted_chapters(app: AppHandle, db: State<'_, AppDb>, book_id: String) -> Result<Vec<Chapter>, AppError> {
    chapter_service::list_deleted_chapters(&app, &db, &book_id)
}

/// 软删除章节（设置 deleted_at），同步更新全书字数，返回更新后的书籍信息
#[tauri::command]
pub async fn delete_chapter(app: AppHandle, db: State<'_, AppDb>, chapter_id: String) -> Result<SaveChapterResult, AppError> {
    let book_wc = chapter_service::delete_chapter(&app, &db, &chapter_id)?;
    Ok(SaveChapterResult { word_count: 0, book_word_count: book_wc })
}

/// 恢复已软删除的章节（清除 deleted_at）
#[tauri::command]
pub async fn restore_chapter(app: AppHandle, db: State<'_, AppDb>, chapter_id: String) -> Result<RestoreChapterResult, AppError> {
    chapter_service::restore_chapter(&app, &db, &chapter_id)
}

/// 硬删除章节，返回更新后的书籍字数
#[tauri::command]
pub async fn hard_delete_chapter(app: AppHandle, db: State<'_, AppDb>, chapter_id: String) -> Result<SaveChapterResult, AppError> {
    let book_wc = chapter_service::hard_delete_chapter(&app, &db, &chapter_id)?;
    Ok(SaveChapterResult { word_count: 0, book_word_count: book_wc })
}

/// 重新排序章节
#[tauri::command]
pub async fn reorder_chapters(app: AppHandle, db: State<'_, AppDb>, chapter_ids: Vec<String>) -> Result<(), AppError> {
    chapter_service::reorder_chapters(&app, &db, &chapter_ids)
}

/// 将章节移动到指定卷
#[tauri::command]
pub async fn move_chapter_to_volume(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
    volume_id: Option<String>,
) -> Result<(), AppError> {
    chapter_service::move_chapter_to_volume(&app, &db, &chapter_id, &volume_id)
}

/// 保存章节的 AI 总结内容
#[tauri::command]
pub async fn save_chapter_summary(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
    summary: String,
) -> Result<(), AppError> {
    chapter_service::save_chapter_summary(&app, &db, &chapter_id, &summary)
}

/// 获取章节的总结信息（summary 和 summary_at）
#[tauri::command]
pub async fn get_chapter_summary(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
) -> Result<ChapterSummaryInfo, AppError> {
    chapter_service::get_chapter_summary(&app, &db, &chapter_id)
}

/// 清除章节的 AI 总结内容
#[tauri::command]
pub async fn clear_chapter_summary(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
) -> Result<(), AppError> {
    chapter_service::clear_chapter_summary(&app, &db, &chapter_id)
}

/// 保存章节大纲内容
#[tauri::command]
pub async fn save_chapter_outline(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
    outline: String,
) -> Result<(), AppError> {
    chapter_service::save_chapter_outline(&app, &db, &chapter_id, &outline)
}
