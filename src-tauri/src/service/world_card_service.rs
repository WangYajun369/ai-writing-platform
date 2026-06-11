//! 世界观卡片业务服务
//!
//! 封装世界观卡片的 CRUD 与 FTS5/LIKE 全文搜索。

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::WorldCard;
use crate::commands::window::emit_sql_log;
use crate::utils::{now, escape_fts5_query, like_pattern, validate_len, MAX_TITLE_LEN, MAX_TAG_LEN, MAX_TAGS_COUNT};
use crate::repository::world_card_repo;

/// 更新世界观卡片参数（强类型 DTO，替代 serde_json::Value）
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorldCardParams {
    pub title: Option<String>,
    pub content: Option<String>,
    pub content_html: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// 列出书籍的所有世界观卡片
pub fn list_world_cards(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<WorldCard>, AppError> {
    emit_sql_log(app, "SELECT", "world_cards", &format!("book_id={book_id}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(world_card_repo::list_by_book(&conn, book_id)?)
}

/// 创建世界观卡片
pub fn create_world_card(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    card_type: &str,
    title: &str,
    content: &str,
    content_html: &str,
    tags: &[String],
) -> Result<WorldCard, AppError> {
    validate_len("卡片标题", title, MAX_TITLE_LEN)?;

    // 校验标签
    if tags.len() > MAX_TAGS_COUNT {
        return Err(AppError::Validation(format!(
            "标签数量超过上限（{} > {}），请删减后重试",
            tags.len(), MAX_TAGS_COUNT
        )));
    }
    for (i, tag) in tags.iter().enumerate() {
        if tag.chars().count() > MAX_TAG_LEN {
            return Err(AppError::Validation(format!(
                "第 {} 个标签长度超过上限（{} > {}）",
                i + 1, tag.chars().count(), MAX_TAG_LEN
            )));
        }
    }

    let id = Uuid::new_v4().to_string();
    let ts = now();
    let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());
    emit_sql_log(app, "INSERT", "world_cards", &format!("id={id}, title={title}, type={card_type}"), file!(), line!());
    let conn = db.pool.get()?;
    world_card_repo::insert(&conn, &id, book_id, card_type, title, content, content_html, &tags_json, &ts)?;

    Ok(WorldCard {
        id,
        book_id: book_id.to_string(),
        card_type: card_type.to_string(),
        title: title.to_string(),
        content: content.to_string(),
        content_html: content_html.to_string(),
        tags: tags.to_vec(),
        vectorized: false,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

/// 更新世界观卡片（使用强类型 DTO）
pub fn update_world_card(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    params: UpdateWorldCardParams,
) -> Result<WorldCard, AppError> {
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "world_cards", &format!("id={id}, typed partial update"), file!(), line!());

    let mut set_clauses: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(v) = params.title {
        set_clauses.push(format!("title=?{}", set_clauses.len() + 1));
        param_values.push(Box::new(v));
    }
    if let Some(v) = params.content {
        set_clauses.push(format!("content=?{}", set_clauses.len() + 1));
        param_values.push(Box::new(v));
    }
    if let Some(v) = params.content_html {
        set_clauses.push(format!("content_html=?{}", set_clauses.len() + 1));
        param_values.push(Box::new(v));
    }
    if let Some(ref v) = params.tags {
        if v.len() > MAX_TAGS_COUNT {
            return Err(AppError::Validation(format!(
                "标签数量超过上限（{} > {}），请删减后重试",
                v.len(), MAX_TAGS_COUNT
            )));
        }
        for (i, tag) in v.iter().enumerate() {
            if tag.chars().count() > MAX_TAG_LEN {
                return Err(AppError::Validation(format!(
                    "第 {} 个标签长度超过上限（{} > {}）",
                    i + 1, tag.chars().count(), MAX_TAG_LEN
                )));
            }
        }
        let tags_json = serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string());
        set_clauses.push(format!("tags=?{}", set_clauses.len() + 1));
        param_values.push(Box::new(tags_json));
    }

    if !set_clauses.is_empty() {
        let ts_idx = set_clauses.len() + 1;
        set_clauses.push(format!("updated_at=?{}", ts_idx));
        param_values.push(Box::new(ts.clone()));

        let sql = format!(
            "UPDATE world_cards SET {} WHERE id=?{}",
            set_clauses.join(", "),
            ts_idx + 1
        );
        param_values.push(Box::new(id.to_string()));

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, params_refs.as_slice())?;
    }

    emit_sql_log(app, "SELECT", "world_cards", &format!("id={id}, re-query after update"), file!(), line!());
    Ok(world_card_repo::find_by_id(&conn, id)?)
}

/// 删除世界观卡片
pub fn delete_world_card(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    emit_sql_log(app, "DELETE", "world_cards", &format!("id={id}"), file!(), line!());
    let conn = db.pool.get()?;
    world_card_repo::delete(&conn, id)?;
    Ok(())
}

/// 搜索世界观卡片（FTS5 + LIKE 降级）
pub fn search_world_cards(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    query: &str,
) -> Result<Vec<WorldCard>, AppError> {
    let conn = db.pool.get()?;
    let fts_query = escape_fts5_query(query);

    if !fts_query.is_empty() {
        emit_sql_log(app, "SELECT", "world_cards_fts",
            &format!("book_id={book_id}, FTS5 MATCH '{query}'"), file!(), line!());
        return Ok(world_card_repo::search_fts5(&conn, book_id, &fts_query, 20)?);
    }

    emit_sql_log(app, "SELECT", "world_cards",
        &format!("book_id={book_id}, LIKE fallback"), file!(), line!());
    let pattern = like_pattern(query, 100);
    Ok(world_card_repo::search_like(&conn, book_id, &pattern, 20)?)
}