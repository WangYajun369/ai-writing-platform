//! 世界观卡片业务服务
//!
//! 封装世界观卡片的 CRUD 与 FTS5/LIKE 全文搜索。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::WorldCard;
use crate::repository::{embedding_repo, world_card_repo};
use crate::service::uow::UnitOfWork;
use crate::utils::{
    escape_fts5_query, like_pattern, now, validate_len, DynamicUpdate, MAX_TAGS_COUNT, MAX_TAG_LEN,
    MAX_TITLE_LEN, SEARCH_DEFAULT_LIMIT,
};
use tauri::AppHandle;
use uuid::Uuid;

/// 更新世界观卡片参数（强类型 DTO，替代 serde_json::Value）
/// 世界观卡片部分更新参数：None 表示不修改该字段；tags 传 Some 时为全量替换
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorldCardParams {
    pub title: Option<String>,
    pub content: Option<String>,
    pub content_html: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// 列出书籍的所有世界观卡片
pub fn list_world_cards(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
) -> Result<Vec<WorldCard>, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "world_cards",
        format!("book_id={book_id}"),
        file!(),
        line!(),
    );
    let cards = world_card_repo::list_by_book(uow.conn(), book_id)?;
    uow.commit()?;
    Ok(cards)
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
            tags.len(),
            MAX_TAGS_COUNT
        )));
    }
    for (i, tag) in tags.iter().enumerate() {
        if tag.chars().count() > MAX_TAG_LEN {
            return Err(AppError::Validation(format!(
                "第 {} 个标签长度超过上限（{} > {}）",
                i + 1,
                tag.chars().count(),
                MAX_TAG_LEN
            )));
        }
    }

    let id = Uuid::new_v4().to_string();
    let ts = now();
    let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "INSERT",
        "world_cards",
        format!("id={id}, title={title}, type={card_type}"),
        file!(),
        line!(),
    );
    world_card_repo::insert(
        uow.conn(),
        &id,
        book_id,
        card_type,
        title,
        content,
        content_html,
        &tags_json,
        &ts,
    )?;
    uow.commit()?;

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
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let ts = now();
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "UPDATE",
        "world_cards",
        format!("id={id}, typed partial update"),
        file!(),
        line!(),
    );

    // 标签校验（DynamicUpdate 收集前完成，失败提前返回）
    if let Some(ref v) = params.tags {
        if v.len() > MAX_TAGS_COUNT {
            return Err(AppError::Validation(format!(
                "标签数量超过上限（{} > {}），请删减后重试",
                v.len(),
                MAX_TAGS_COUNT
            )));
        }
        for (i, tag) in v.iter().enumerate() {
            if tag.chars().count() > MAX_TAG_LEN {
                return Err(AppError::Validation(format!(
                    "第 {} 个标签长度超过上限（{} > {}）",
                    i + 1,
                    tag.chars().count(),
                    MAX_TAG_LEN
                )));
            }
        }
    }

    // 字段收集统一走 DynamicUpdate 构建器（Phase 4 问题 17 去重）
    let mut upd = DynamicUpdate::new("world_cards");
    if let Some(v) = params.title {
        upd.push("title", v);
    }
    if let Some(v) = params.content {
        upd.push("content", v);
    }
    if let Some(v) = params.content_html {
        upd.push("content_html", v);
    }
    if let Some(v) = params.tags {
        upd.push_json("tags", v);
    }

    if let Some((sql, values)) = upd.build(id, &ts) {
        crate::repository::execute_update(uow.conn(), &sql, values)?;
    }
    uow.commit()?;

    Ok(world_card_repo::find_by_id(&pooled, id)?)
}

/// 删除世界观卡片
pub fn delete_world_card(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "DELETE",
        "world_cards",
        format!("id={id}"),
        file!(),
        line!(),
    );
    world_card_repo::delete(uow.conn(), id)?;
    // embeddings 无外键，显式清理该卡片的向量嵌入（含 chunks_vec 镜像行）
    uow.audit(
        "DELETE",
        "embeddings",
        format!("source=world_card/{id}"),
        file!(),
        line!(),
    );
    embedding_repo::delete_by_source(uow.conn(), "world_card", id)?;
    uow.commit()?;
    Ok(())
}

/// 搜索世界观卡片（FTS5 优先 + 无命中 LIKE 兜底，与 search_service 策略一致）
///
/// Phase 4 问题 18 统一：limit 使用共享常量 `SEARCH_DEFAULT_LIMIT`（不再硬编码 20），
/// 降级语义对齐 `search_service` —— FTS5 有结果直接返回；无结果再尝试 LIKE 兜底。
pub fn search_world_cards(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    query: &str,
) -> Result<Vec<WorldCard>, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    let fts_query = escape_fts5_query(query);

    if !fts_query.is_empty() {
        uow.audit(
            "SELECT",
            "world_cards_fts",
            format!("book_id={book_id}, FTS5 MATCH '{query}'"),
            file!(),
            line!(),
        );
        let hits =
            world_card_repo::search_fts5(uow.conn(), book_id, &fts_query, SEARCH_DEFAULT_LIMIT)?;
        if !hits.is_empty() {
            uow.commit()?;
            return Ok(hits);
        }
        crate::app_log!(
            "[search] world_cards FTS5 无命中，降级 LIKE: book_id={book_id} query={query}"
        );
    }

    uow.audit(
        "SELECT",
        "world_cards",
        format!("book_id={book_id}, LIKE fallback"),
        file!(),
        line!(),
    );
    let pattern = like_pattern(query, 100);
    let results =
        world_card_repo::search_like(uow.conn(), book_id, &pattern, SEARCH_DEFAULT_LIMIT)?;
    uow.commit()?;
    Ok(results)
}
