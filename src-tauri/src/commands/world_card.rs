//! 世界观卡片 IPC 命令
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::WorldCard;
use crate::service::world_card_service;
use crate::service::world_card_service::UpdateWorldCardParams;

/// 列出指定书籍的所有世界观卡片，按 updated_at 降序
#[tauri::command]
pub async fn list_world_cards(app: AppHandle, db: State<'_, AppDb>, book_id: String) -> Result<Vec<WorldCard>, AppError> {
    world_card_service::list_world_cards(&app, &db, &book_id)
}

/// 创建世界观卡片参数
#[derive(serde::Deserialize)]
pub struct CreateWorldCardParams {
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "type")]
    pub card_type: String,
    pub title: String,
    pub content: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    pub tags: Vec<String>,
}

/// 创建世界观卡片，初始未向量化
#[tauri::command]
pub async fn create_world_card(app: AppHandle, db: State<'_, AppDb>, params: CreateWorldCardParams) -> Result<WorldCard, AppError> {
    world_card_service::create_world_card(
        &app, &db, &params.book_id, &params.card_type,
        &params.title, &params.content, &params.content_html, &params.tags,
    )
}

/// 更新世界观卡片（部分字段），使用强类型 DTO
#[tauri::command]
pub async fn update_world_card(
    app: AppHandle,
    db: State<'_, AppDb>,
    id: String,
    params: UpdateWorldCardParams,
) -> Result<WorldCard, AppError> {
    world_card_service::update_world_card(&app, &db, &id, params)
}

/// 删除世界观卡片
#[tauri::command]
pub async fn delete_world_card(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), AppError> {
    world_card_service::delete_world_card(&app, &db, &id)
}

/// 按关键词搜索世界观卡片（FTS5 全文搜索，降级为 LIKE）
#[tauri::command]
pub async fn search_world_cards(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
) -> Result<Vec<WorldCard>, AppError> {
    world_card_service::search_world_cards(&app, &db, &book_id, &query)
}
