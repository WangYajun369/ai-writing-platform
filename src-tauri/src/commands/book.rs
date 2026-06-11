//! 书籍管理 IPC 命令
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理业务逻辑。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Book;
use crate::service::book_service;
use crate::service::book_service::UpdateBookParams;

/// 列出所有未删除的书籍，按 updated_at 降序排列
#[tauri::command]
pub async fn list_books(app: AppHandle, db: State<'_, AppDb>) -> Result<Vec<Book>, AppError> {
    book_service::list_books(&app, &db)
}

/// 根据 ID 获取单本书籍详情
#[tauri::command]
pub async fn get_book(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<Book, AppError> {
    book_service::get_book(&app, &db, &id)
}

/// 列出回收站中已删除的书籍
#[tauri::command]
pub async fn list_deleted_books(app: AppHandle, db: State<'_, AppDb>) -> Result<Vec<Book>, AppError> {
    book_service::list_deleted_books(&app, &db)
}

/// 创建新书参数（由前端 JSON 反序列化）
#[derive(serde::Deserialize)]
pub struct CreateBookParams {
    pub title: String,
    pub author: String,
    pub description: String,
    #[serde(rename = "dailyTarget")]
    pub daily_target: i64,
    pub tags: Vec<String>,
}

/// 创建新书，生成 UUID，返回完整 Book 结构
#[tauri::command]
pub async fn create_book(app: AppHandle, db: State<'_, AppDb>, params: CreateBookParams) -> Result<Book, AppError> {
    book_service::create_book(&app, &db, &params.title, &params.author, &params.description, params.daily_target, &params.tags)
}

/// 更新书籍字段（部分更新，使用强类型 UpdateBookParams）
#[tauri::command]
pub async fn update_book(app: AppHandle, db: State<'_, AppDb>, id: String, params: UpdateBookParams) -> Result<Book, AppError> {
    book_service::update_book(&app, &db, &id, params)
}

/// 设置书籍封面：压缩后以 Base64 data URL 形式存储
#[tauri::command]
pub async fn set_book_cover(
    app: AppHandle,
    db: State<'_, AppDb>,
    id: String,
    source_path: String,
) -> Result<Book, AppError> {
    book_service::set_book_cover(&app, &db, &id, &source_path)
}

/// 删除书籍（软删除：标记 deleted_at，放入回收站）
#[tauri::command]
pub async fn delete_book(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), AppError> {
    book_service::delete_book(&app, &db, &id)
}

/// 恢复已删除的书籍（清除 deleted_at）
#[tauri::command]
pub async fn restore_book(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), AppError> {
    book_service::restore_book(&app, &db, &id)
}

/// 彻底删除书籍及其全部关联数据
#[tauri::command]
pub async fn hard_delete_book(app: AppHandle, db: State<'_, AppDb>, id: String) -> Result<(), AppError> {
    book_service::hard_delete_book(&app, &db, &id)
}

/// 一键清空回收站
#[tauri::command]
pub async fn clear_book_trash(app: AppHandle, db: State<'_, AppDb>) -> Result<u32, AppError> {
    book_service::clear_book_trash(&app, &db)
}
