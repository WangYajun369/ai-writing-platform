//! 章节业务服务
//!
//! 封装章节 CRUD、内容保存、排序、移动、总结等业务逻辑，
//! 包含字数聚合业务规则。

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Chapter;
use crate::commands::window::emit_sql_log;
use crate::commands::chapter::{SaveChapterResult, RestoreChapterResult, ChapterSummaryInfo};
use crate::utils::{now, validate_len, MAX_TITLE_LEN, MAX_CHAPTER_CONTENT_LEN};
use crate::repository::{chapter_repo, book_repo, volume_repo};

/// 列出书籍的未删除章节
pub fn list_chapters(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<Chapter>, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("book_id={book_id}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::list_by_book(&conn, book_id)?)
}

/// 获取章节内容
pub fn get_chapter_content(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<String, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, content_html"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::find_content(&conn, chapter_id)?)
}

/// 创建新章节
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

/// 保存章节内容并更新书籍字数
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

    // Step 1: 保存内容到 chapters 表（触发 FTS5 同步）
    chapter_repo::save_content(&conn, chapter_id, content_html, word_count, &ts)
        .map_err(|e| AppError::Business(format!("保存内容失败 [step1-save_content]: {}", e)))?;

    // Step 2: 更新书籍总字数
    book_repo::update_word_count_by_chapter(&conn, chapter_id, &ts)
        .map_err(|e| AppError::Business(format!("保存失败 [step2-update_book_wc]: {}", e)))?;

    // Step 3: 读取更新后的字数
    let book_wc = book_repo::word_count_by_chapter(&conn, chapter_id)
        .map_err(|e| AppError::Business(format!("保存失败 [step3-read_book_wc]: {}", e)))?;

    Ok(SaveChapterResult { word_count, book_word_count: book_wc })
}

/// 更新章节状态
pub fn update_chapter_status(app: &AppHandle, db: &AppDb, chapter_id: &str, status: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, status={status}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::update_status(&conn, chapter_id, status, &now())?)
}

/// 重命名章节
pub fn rename_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str, title: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, rename to {title}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::rename(&conn, chapter_id, title, &now())?)
}

/// 列出已删除章节
pub fn list_deleted_chapters(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<Chapter>, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("book_id={book_id}, deleted"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::list_deleted_by_book(&conn, book_id)?)
}

/// 软删除章节并更新字数
pub fn delete_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, soft delete"), file!(), line!());
    chapter_repo::soft_delete(&conn, chapter_id, &ts)?;

    book_repo::update_word_count_by_chapter(&conn, chapter_id, &ts)?;
    Ok(())
}

/// 恢复章节：检测原卷是否存在，若已删除则恢复到根目录
pub fn restore_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<RestoreChapterResult, AppError> {
    let conn = db.pool.get()?;
    let ts = now();

    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, check volume_id"), file!(), line!());
    let current_vid = chapter_repo::find_volume_id(&conn, chapter_id)?;

    let effective_volume_id = if let Some(ref vid) = current_vid {
        emit_sql_log(app, "SELECT", "volumes", &format!("id={vid}, check exists"), file!(), line!());
        if volume_repo::exists_active(&conn, vid)? {
            Some(vid.clone())
        } else {
            None
        }
    } else {
        None
    };

    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, restore"), file!(), line!());
    chapter_repo::restore(&conn, chapter_id, &effective_volume_id, &ts)?;

    book_repo::update_word_count_by_chapter(&conn, chapter_id, &ts)?;

    Ok(RestoreChapterResult { volume_id: effective_volume_id })
}

/// 硬删除章节
pub fn hard_delete_chapter(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let ts = now();

    // 先获取 book_id，避免硬删除后无法回溯
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, get book_id before hard delete"), file!(), line!());
    let book_id: String = conn.query_row(
        "SELECT book_id FROM chapters WHERE id=?1",
        rusqlite::params![chapter_id],
        |row| row.get(0),
    )?;

    emit_sql_log(app, "DELETE", "chapters", &format!("id={chapter_id}, hard delete"), file!(), line!());
    chapter_repo::hard_delete(&conn, chapter_id)?;

    emit_sql_log(app, "UPDATE", "books", &format!("recalc word_count for book_id={book_id}"), file!(), line!());
    book_repo::recalc_word_count(&conn, &book_id, &ts)?;
    Ok(())
}

/// 重新排序章节
pub fn reorder_chapters(app: &AppHandle, db: &AppDb, chapter_ids: &[String]) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("reorder {} chapters", chapter_ids.len()), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::reorder(&conn, chapter_ids)?)
}

/// 移动章节到指定卷
pub fn move_chapter_to_volume(
    app: &AppHandle,
    db: &AppDb,
    chapter_id: &str,
    volume_id: &Option<String>,
) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let ts = now();

    emit_sql_log(app, "SELECT", "chapters", "MAX(sort_order)", file!(), line!());
    let max_order = chapter_repo::max_sort_in_volume(&conn, volume_id, chapter_id)?;
    let new_sort = max_order + 1;

    emit_sql_log(app, "UPDATE", "chapters",
        &format!("id={chapter_id}, move to volume_id={volume_id:?}, sort={new_sort}"), file!(), line!());
    Ok(chapter_repo::move_to_volume(&conn, chapter_id, volume_id, new_sort, &ts)?)
}

/// 保存章节总结
pub fn save_chapter_summary(app: &AppHandle, db: &AppDb, chapter_id: &str, summary: &str) -> Result<(), AppError> {
    let ts = now();
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, save summary ({} chars)", summary.len()), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::save_summary(&conn, chapter_id, summary, &ts)?)
}

/// 清除章节总结
pub fn clear_chapter_summary(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, clear summary"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::clear_summary(&conn, chapter_id)?)
}

/// 获取章节总结
pub fn get_chapter_summary(app: &AppHandle, db: &AppDb, chapter_id: &str) -> Result<ChapterSummaryInfo, AppError> {
    emit_sql_log(app, "SELECT", "chapters", &format!("id={chapter_id}, summary"), file!(), line!());
    let conn = db.pool.get()?;
    let (summary, summary_at) = chapter_repo::find_summary_info(&conn, chapter_id)?;
    Ok(ChapterSummaryInfo { summary, summary_at })
}

/// 保存章节大纲
pub fn save_chapter_outline(app: &AppHandle, db: &AppDb, chapter_id: &str, outline: &str) -> Result<(), AppError> {
    let ts = now();
    emit_sql_log(app, "UPDATE", "chapters", &format!("id={chapter_id}, save outline ({} chars)", outline.len()), file!(), line!());
    let conn = db.pool.get()?;
    Ok(chapter_repo::save_outline(&conn, chapter_id, outline, &ts)?)
}