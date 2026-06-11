//! 书籍业务服务
//!
//! 封装书籍的 CRUD 操作逻辑，负责从连接池获取连接、
//! 记录 SQL 审计日志，并调用 Repository 层执行实际操作。

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Book;
use crate::commands::window::emit_sql_log;
use crate::utils::{now, validate_len, MAX_TITLE_LEN, MAX_AUTHOR_LEN, MAX_DESCRIPTION_LEN};
use crate::repository::book_repo;

/// 更新书籍参数（强类型 DTO，替代 serde_json::Value）
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBookParams {
    pub title: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub cover_image: Option<String>,
    pub outline: Option<String>,
    pub daily_target: Option<i64>,
    pub tags: Option<Vec<String>>,
}

/// 列出所有未删除的书籍
pub fn list_books(app: &AppHandle, db: &AppDb) -> Result<Vec<Book>, AppError> {
    emit_sql_log(app, "SELECT", "books", "", file!(), line!());
    let conn = db.pool.get()?;
    Ok(book_repo::list_all(&conn)?)
}

/// 根据 ID 获取单本书
pub fn get_book(app: &AppHandle, db: &AppDb, id: &str) -> Result<Book, AppError> {
    emit_sql_log(app, "SELECT", "books", &format!("id={id}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(book_repo::find_by_id(&conn, id)?)
}

/// 列出回收站中的书籍
pub fn list_deleted_books(app: &AppHandle, db: &AppDb) -> Result<Vec<Book>, AppError> {
    emit_sql_log(app, "SELECT", "books", "deleted_at IS NOT NULL", file!(), line!());
    let conn = db.pool.get()?;
    Ok(book_repo::list_deleted(&conn)?)
}

/// 创建新书
pub fn create_book(
    app: &AppHandle,
    db: &AppDb,
    title: &str,
    author: &str,
    description: &str,
    daily_target: i64,
    tags: &[String],
) -> Result<Book, AppError> {
    validate_len("书名", title, MAX_TITLE_LEN)?;
    validate_len("作者", author, MAX_AUTHOR_LEN)?;
    validate_len("简介", description, MAX_DESCRIPTION_LEN)?;

    let id = Uuid::new_v4().to_string();
    let ts = now();
    let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());

    emit_sql_log(app, "INSERT", "books", &format!("id={id}, title={title}"), file!(), line!());
    let conn = db.pool.get()?;
    book_repo::insert(&conn, &id, title, author, description, daily_target, &tags_json, &ts)?;

    Ok(Book {
        id,
        title: title.to_string(),
        author: author.to_string(),
        description: description.to_string(),
        cover_image: None,
        word_count: 0,
        daily_target,
        today_count: 0,
        db_path: String::new(),
        tags: tags.to_vec(),
        created_at: ts.clone(),
        updated_at: ts,
        deleted_at: None,
        outline: String::new(),
    })
}

/// 更新书籍字段（部分更新），使用强类型 UpdateBookParams
pub fn update_book(app: &AppHandle, db: &AppDb, id: &str, params: UpdateBookParams) -> Result<Book, AppError> {
    let ts = now();
    {
        let conn = db.pool.get()?;

        let mut set_clauses: Vec<String> = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        let mut push_str = |col: &str, val: String| {
            set_clauses.push(format!("{}=?{}", col, set_clauses.len() + 1));
            param_values.push(Box::new(val));
        };

        if let Some(v) = params.title { push_str("title", v); }
        if let Some(v) = params.author { push_str("author", v); }
        if let Some(v) = params.description { push_str("description", v); }
        if let Some(v) = params.cover_image { push_str("cover_image", v); }
        if let Some(v) = params.outline { push_str("outline", v); }
        if let Some(v) = params.daily_target {
            set_clauses.push(format!("daily_target=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(v));
        }
        if let Some(ref v) = params.tags {
            let tags_json = serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string());
            set_clauses.push(format!("tags=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(tags_json));
        }

        if !set_clauses.is_empty() {
            let ts_idx = set_clauses.len() + 1;
            set_clauses.push(format!("updated_at=?{}", ts_idx));
            param_values.push(Box::new(ts.clone()));

            let sql = format!(
                "UPDATE books SET {} WHERE id=?{}",
                set_clauses.join(", "),
                ts_idx + 1
            );
            param_values.push(Box::new(id.to_string()));

            emit_sql_log(app, "UPDATE", "books", &format!("id={id}, fields={}", set_clauses.len() - 1), file!(), line!());
            let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
            conn.execute(&sql, params_refs.as_slice())?;
        }
    }
    get_book(app, db, id)
}

/// 设置/更新书籍封面
pub fn set_book_cover(app: &AppHandle, db: &AppDb, id: &str, source_path: &str) -> Result<Book, AppError> {
    if source_path.trim().is_empty() {
        let ts = now();
        {
            let conn = db.pool.get()?;
            emit_sql_log(app, "UPDATE", "books", &format!("id={id}, clear cover_image"), file!(), line!());
            book_repo::clear_cover(&conn, id, &ts)?;
        }
        return get_book(app, db, id);
    }

    let data_url = crate::commands::image::process_image_data(source_path, 800, 85)?;
    let ts = now();
    {
        let conn = db.pool.get()?;
        emit_sql_log(app, "UPDATE", "books", &format!("id={id}, set cover_image"), file!(), line!());
        book_repo::update_cover(&conn, id, &data_url, &ts)?;
    }
    get_book(app, db, id)
}

/// 直接保存 Base64 data URL 作为封面（前端已处理完裁剪/压缩）
pub fn set_book_cover_data(app: &AppHandle, db: &AppDb, id: &str, data_url: &str) -> Result<Book, AppError> {
    if data_url.trim().is_empty() {
        let ts = now();
        {
            let conn = db.pool.get()?;
            emit_sql_log(app, "UPDATE", "books", &format!("id={id}, clear cover_image"), file!(), line!());
            book_repo::clear_cover(&conn, id, &ts)?;
        }
        return get_book(app, db, id);
    }

    // 校验 data URL 格式
    if !data_url.starts_with("data:image/") {
        return Err(AppError::Business("无效的图片 data URL 格式".into()));
    }

    let ts = now();
    {
        let conn = db.pool.get()?;
        emit_sql_log(app, "UPDATE", "books", &format!("id={id}, set cover_image from data URL"), file!(), line!());
        book_repo::update_cover(&conn, id, data_url, &ts)?;
    }
    get_book(app, db, id)
}

/// 软删除书籍
pub fn delete_book(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "books", &format!("id={id}, soft delete"), file!(), line!());
    Ok(book_repo::soft_delete(&conn, id, &ts)?)
}

/// 恢复已删除的书籍
pub fn restore_book(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "UPDATE", "books", &format!("id={id}, restore"), file!(), line!());
    let affected = book_repo::restore(&conn, id, &now())?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该作品或未被删除".into()));
    }
    Ok(())
}

/// 硬删除书籍及其关联数据
pub fn hard_delete_book(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "DELETE", "books", &format!("id={id}, hard delete"), file!(), line!());
    book_repo::hard_delete(&conn, id)?;

    emit_sql_log(app, "DELETE", "embeddings", "cleanup orphan chapter embeddings", file!(), line!());
    book_repo::cleanup_orphan_chapter_embeddings(&conn)?;
    emit_sql_log(app, "DELETE", "embeddings", "cleanup orphan world_card embeddings", file!(), line!());
    book_repo::cleanup_orphan_world_card_embeddings(&conn)?;
    Ok(())
}

/// 清空回收站
pub fn clear_book_trash(app: &AppHandle, db: &AppDb) -> Result<u32, AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "SELECT", "books", "COUNT deleted", file!(), line!());
    let count = book_repo::count_deleted(&conn)?;
    emit_sql_log(app, "DELETE", "books", &format!("clear trash, count={count}"), file!(), line!());
    book_repo::clear_trash(&conn)?;

    emit_sql_log(app, "DELETE", "embeddings", "cleanup orphan chapter embeddings", file!(), line!());
    let _ = book_repo::cleanup_orphan_chapter_embeddings(&conn);
    emit_sql_log(app, "DELETE", "embeddings", "cleanup orphan world_card embeddings", file!(), line!());
    let _ = book_repo::cleanup_orphan_world_card_embeddings(&conn);
    Ok(count)
}