//! 章节业务服务
//!
//! 封装章节的完整业务逻辑，涵盖 CRUD、内容保存、排序、移动、总结、大纲等操作。
//!
//! ## 核心职责
//!
//! - **CRUD 操作**：创建、查询、更名、软删除、硬删除、恢复
//! - **内容管理**：保存 HTML 正文，关联字数统计与 FTS5 全文索引同步
//! - **字数聚合**：章节字数变更时自动更新所属书籍的聚合字数
//! - **排序与移动**：章节拖拽排序、跨卷移动
//! - **总结管理**：章节 AI 总结的保存、查询、清除
//! - **大纲管理**：章节大纲的保存
//!
//! ## 设计原则
//!
//! - 所有数据库操作均通过 `emit_sql_log!` 宏产生日志，便于调试与审计
//! - 字数相关操作采用分段式步骤（保存 → 更新聚合 → 回读），每步独立错误处理
//! - 硬删除使用事务保证数据一致性（获取关联信息 → 删除 → 重算 → 提交）

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Chapter;
use crate::commands::window::emit_sql_log;
use crate::commands::chapter::{SaveChapterResult, RestoreChapterResult, ChapterSummaryInfo};
use crate::utils::{now, validate_len, MAX_TITLE_LEN, MAX_CHAPTER_CONTENT_LEN};
use crate::repository::{chapter_repo, book_repo, volume_repo};

// ============================================================================
// 查询操作
// ============================================================================

/// 列出指定书籍下所有未删除的章节
///
/// # Arguments
/// * `app` - Tauri 应用句柄，用于日志发射
/// * `db` - 数据库连接池
/// * `book_id` - 所属书籍 ID
///
/// # Returns
/// 按 `sort_order` 排序的章节列表，已逻辑删除的章节不包含在内
pub fn list_chapters(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<Chapter>, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("book_id={book_id}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::list_by_book(&conn, book_id)?)
}

/// 获取章节的 HTML 正文内容
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_id` - 章节 ID
///
/// # Returns
/// 章节的 `content_html` 字段值，若内容为空则返回空字符串
pub fn get_chapter_content(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<String, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, content_html"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::find_content(&conn, chapter_id)?)
}

// ============================================================================
// 创建与保存
// ============================================================================

/// 创建新章节
///
/// 使用 UUID v4 生成唯一 ID，初始化默认为"草稿"状态、空内容、0 字数。
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `book_id` - 所属书籍 ID
/// * `volume_id` - 所属卷 ID，`None` 表示根目录章节
/// * `title` - 章节标题，受 `MAX_TITLE_LEN` 约束
/// * `sort_order` - 排序序号
///
/// # Errors
/// 标题超长时返回校验错误
pub fn create_chapter(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    volume_id: &Option<String>,
    title: &str,
    sort_order: i64,
) -> Result<Chapter, AppError> {
    validate_len("章节标题", title, MAX_TITLE_LEN)?;

    let id = Uuid::new_v4().to_string();
    let ts = now();
    emit_sql_log(app, "INSERT", "chapters", &format!("id={id}, title={title}, book_id={book_id}"), file!(), line!());
    let conn = db.pool.get()?;
    chapter_repo::insert(&conn, &id, book_id, volume_id, title, sort_order, &ts)?;

    // 构造并返回内存中的 Chapter 对象，避免额外数据库查询
    Ok(Chapter {
        id,
        book_id: book_id.to_string(),
        volume_id: volume_id.clone(),
        title: title.to_string(),
        content_html: Some(String::new()),
        word_count: 0,
        status: "draft".to_string(),
        sort_order,
        created_at: ts.clone(),
        updated_at: ts,
        deleted_at: None,
        summary: None,
        summary_at: None,
        outline: String::new(),
    })
}

/// 保存章节 HTML 内容，并自动级联更新所属书籍的聚合字数
///
/// # 执行流程
///
/// 1. **保存内容**：将 `content_html` 写入 `chapters` 表，FTS5 触发器自动同步全文索引
/// 2. **更新书籍字数**：调用 `book_repo::update_word_count_by_chapter` 重算并更新 `books.word_count`
/// 3. **回读书籍字数**：重新查询最终字数，确保返回值准确
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_id` - 章节 ID
/// * `content_html` - 章节 HTML 正文，受 `MAX_CHAPTER_CONTENT_LEN` 约束
/// * `word_count` - 当前章节字数
///
/// # Returns
/// `SaveChapterResult`，包含章节字数和更新后的全书字数
///
/// # Errors
/// 内容超长或数据库操作失败时返回 `AppError::Business`
pub fn save_chapter(
    app: &AppHandle,
    db: &AppDb,
    chapter_id: &str,
    content_html: &str,
    word_count: i64,
) -> Result<SaveChapterResult, AppError> {
    let ts = now();
    validate_len("章节内容", content_html, MAX_CHAPTER_CONTENT_LEN)?;

    let conn = db.pool.get()?;
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, save content_html, wc={word_count}"), file!(), line!());

    // Step 1: 保存内容到 chapters 表（写入 content_html 和 word_count，触发 FTS5 同步）
    chapter_repo::save_content(&conn, chapter_id, content_html, word_count, &ts)
        .map_err(|e| AppError::Business(format!("保存内容失败 [step1-save_content]: {}", e)))?;

    // Step 2: 级联更新书籍总字数（基于所有未删除章节的字数求和）
    book_repo::update_word_count_by_chapter(&conn, chapter_id, &ts)
        .map_err(|e| AppError::Business(format!("保存失败 [step2-update_book_wc]: {}", e)))?;

    // Step 3: 回读更新后的书籍字数，确保调用方拿到最新值
    let book_wc = book_repo::word_count_by_chapter(&conn, chapter_id)
        .map_err(|e| AppError::Business(format!("保存失败 [step3-read_book_wc]: {}", e)))?;

    Ok(SaveChapterResult { word_count, book_word_count: book_wc })
}

// ============================================================================
// 状态与名称更新
// ============================================================================

/// 更新章节状态
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_id` - 章节 ID
/// * `status` - 新状态值（如 `"draft"`、`"completed"` 等）
pub fn update_chapter_status(app: &AppHandle, db: &AppDb, chapter_id: &str, status: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, status={status}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::update_status(&conn, chapter_id, status, &now())?)
}

/// 重命名章节标题
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_id` - 章节 ID
/// * `title` - 新标题
pub fn rename_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str, title: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, rename to {title}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::rename(&conn, chapter_id, title, &now())?)
}

// ============================================================================
// 删除与恢复
// ============================================================================

/// 列出指定书籍下所有已软删除的章节（回收站视图）
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `book_id` - 所属书籍 ID
pub fn list_deleted_chapters(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<Chapter>, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("book_id={book_id}, deleted"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::list_deleted_by_book(&conn, book_id)?)
}

/// 软删除章节：设置 `deleted_at` 时间戳并将字数从书籍聚合中扣除
///
/// 章节数据保留在数据库中，可通过 [`restore_chapter`] 恢复。
///
/// # Returns
/// 更新后的全书总字数
pub fn delete_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<i64, AppError> {
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, soft delete"), file!(), line!());

    // 标记章节为已删除（设置 deleted_at 时间戳）
    chapter_repo::soft_delete(&conn, chapter_id, &ts)?;

    // 软删除后需将章节字数从书籍总字数中扣除
    book_repo::update_word_count_by_chapter(&conn, chapter_id, &ts)?;
    let book_wc = book_repo::word_count_by_chapter(&conn, chapter_id)?;
    Ok(book_wc)
}

/// 恢复已删除的章节
///
/// 恢复时会检测章节原属卷是否仍存在：
/// - 若原卷存在 → 恢复到原卷下
/// - 若原卷已被删除 → 恢复到书籍根目录（`volume_id = None`）
///
/// 恢复后自动将章节字数重新计入书籍聚合。
///
/// # Returns
/// `RestoreChapterResult`，包含恢复后所在卷 ID 和更新后的全书字数
pub fn restore_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<RestoreChapterResult, AppError> {
    let conn = db.pool.get()?;
    let ts = now();

    // 查询章节当前关联的卷 ID（即使已软删除仍保留此字段）
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, check volume_id"), file!(), line!());
    let current_vid = chapter_repo::find_volume_id(&conn, chapter_id)?;

    // 确认原卷是否仍处于活跃状态（未被删除）
    let effective_volume_id = if let Some(ref vid) = current_vid {
        emit_sql_log(app, "SELECT", "volumes", &format!("id={vid}, check exists"), file!(), line!());
        if volume_repo::exists_active(&conn, vid)? {
            Some(vid.clone()) // 原卷存在，恢复到原卷
        } else {
            None // 原卷已删除，恢复到根目录
        }
    } else {
        None // 原本就在根目录
    };

    // 清除 deleted_at 并将章节恢复到有效卷
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, restore"), file!(), line!());
    chapter_repo::restore(&conn, chapter_id, &effective_volume_id, &ts)?;

    // 将恢复的章节字数重新计入书籍聚合
    book_repo::update_word_count_by_chapter(&conn, chapter_id, &ts)?;
    let book_wc = book_repo::word_count_by_chapter(&conn, chapter_id)?;

    Ok(RestoreChapterResult { volume_id: effective_volume_id, book_word_count: book_wc })
}

/// 硬删除章节：从数据库中彻底移除章节记录
///
/// # 事务执行流程
///
/// 1. **获取 `book_id`**：删除前先查询关联的书籍 ID，便于后续重算
/// 2. **删除章节**：`DELETE` 触发 `chapters_fts_ad` 触发器，使用 `DELETE FROM chapters_fts` 清理索引
/// 3. **重算书籍字数**：基于剩余章节重新计算 `books.word_count`
/// 4. **回读确认**：查询最终字数并提交事务
///
/// # FTS5 安全性
///
/// DELETE 触发器使用 `DELETE FROM chapters_fts WHERE rowid = old.rowid` 直接移除索引，
/// 不经过分词器，避免因文本过大导致的 SQL logic error。
///
/// # Returns
/// 硬删除后更新过的全书总字数
pub fn hard_delete_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<i64, AppError> {
    let mut conn = db.pool.get()?;
    let ts = now();

    emit_sql_log(app, "BEGIN", "transaction", "hard_delete_chapter", file!(), line!());
    let tx = conn.transaction()?;

    // 事务内先获取 book_id，避免硬删除后无法回溯关联书籍
    // 若章节已被级联删除或不存在，视为已完成，直接返回 0
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, get book_id"), file!(), line!());
    let book_id: String = match tx.query_row(
        "SELECT book_id FROM chapters WHERE id=?1",
        rusqlite::params![chapter_id],
        |row| row.get(0),
    ) {
        Ok(id) => id,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            emit_sql_log(app, "COMMIT", "transaction", "hard_delete_chapter skipped (chapter not found)", file!(), line!());
            tx.commit().map_err(|e| AppError::Business(format!("提交事务失败: {}", e)))?;
            return Ok(0);
        }
        Err(e) => return Err(e.into()),
    };

    // DELETE 触发 chapters_fts_ad 触发器 → 使用 DELETE 直接清理 FTS5 索引
    emit_sql_log(app, "DELETE", "chapters", &format!("id={chapter_id}, hard delete"), file!(), line!());
    chapter_repo::hard_delete(&tx, chapter_id)?;

    // 硬删除后书籍字数不再包含此章节，需完全重算
    emit_sql_log(app, "UPDATE", "books", &format!("recalc word_count for book_id={book_id}"), file!(), line!());
    book_repo::recalc_word_count(&tx, &book_id, &ts)?;

    // 使用 book_id 查询（章节已不存在，无法通过 chapter_id 反查）
    let book_wc = book_repo::word_count_by_book(&tx, &book_id)?;

    emit_sql_log(app, "COMMIT", "transaction", "hard_delete_chapter committed", file!(), line!());
    tx.commit().map_err(|e| AppError::Business(format!("提交事务失败: {}", e)))?;
    Ok(book_wc)
}

// ============================================================================
// 排序与移动
// ============================================================================

/// 按给定顺序批量更新章节的 `sort_order`
///
/// `chapter_ids` 的顺序即对应新的排序位置：
/// `chapter_ids[0]` → `sort_order = 0`，`chapter_ids[1]` → `sort_order = 1`，以此类推。
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_ids` - 按目标顺序排列的章节 ID 列表
pub fn reorder_chapters(app: &AppHandle, db: &AppDb, chapter_ids: &[String]) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("reorder {} chapters", chapter_ids.len()), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::reorder(&conn, chapter_ids)?)
}

/// 将章节移动到指定卷（或根目录）
///
/// 移动后自动计算目标卷/根目录下的最大 `sort_order`，
/// 将章节置于末尾位置。
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_id` - 要移动的章节 ID
/// * `volume_id` - 目标卷 ID，`None` 表示移动到书籍根目录
pub fn move_chapter_to_volume(
    app: &AppHandle,
    db: &AppDb,
    chapter_id: &str,
    volume_id: &Option<String>,
) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let ts = now();

    // 查询目标卷/根目录下当前最大排序值（排除自身）
    emit_sql_log(app, "SELECT", "chapters", "MAX(sort_order)", file!(), line!());
    let max_order = chapter_repo::max_sort_in_volume(&conn, volume_id, chapter_id)?;
    let new_sort = max_order + 1; // 追加到末尾

    emit_sql_log(app, "UPDATE", "chapters",
        &format!("id={chapter_id}, move to volume_id={volume_id:?}, sort={new_sort}"), file!(), line!());
    Ok(chapter_repo::move_to_volume(&conn, chapter_id, volume_id, new_sort, &ts)?)
}

// ============================================================================
// 总结管理
// ============================================================================

/// 保存章节的 AI 总结
///
/// 同时记录 `updated_at` 和 `summary_at` 时间戳，用于前端展示"最近总结时间"。
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_id` - 章节 ID
/// * `summary` - 总结文本
pub fn save_chapter_summary(app: &AppHandle, db: &AppDb, chapter_id: &str, summary: &str) -> Result<(), AppError> {
    let ts = now();
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, save summary ({} chars)", summary.len()), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::save_summary(&conn, chapter_id, summary, &ts)?)
}

/// 清除章节的 AI 总结
///
/// 将 `summary` 和 `summary_at` 字段置空。
pub fn clear_chapter_summary(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, clear summary"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::clear_summary(&conn, chapter_id)?)
}

/// 获取章节总结信息
///
/// # Returns
/// `ChapterSummaryInfo`，包含 `summary`（总结文本）和 `summary_at`（总结时间）
pub fn get_chapter_summary(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<ChapterSummaryInfo, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, summary"), file!(), line!());
    let conn = db.pool.get()?;
    let (summary, summary_at) = chapter_repo::find_summary_info(&conn, chapter_id)?;
    Ok(ChapterSummaryInfo { summary, summary_at })
}

// ============================================================================
// 大纲管理
// ============================================================================

/// 保存章节大纲
///
/// 大纲文本存储于 `chapters.outline` 字段，用于辅助写作时的结构指引。
///
/// # Arguments
/// * `app` - Tauri 应用句柄
/// * `db` - 数据库连接池
/// * `chapter_id` - 章节 ID
/// * `outline` - 大纲文本
pub fn save_chapter_outline(app: &AppHandle, db: &AppDb, chapter_id: &str, outline: &str) -> Result<(), AppError> {
    let ts = now();
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, save outline ({} chars)", outline.len()), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::save_outline(&conn, chapter_id, outline, &ts)?)
}