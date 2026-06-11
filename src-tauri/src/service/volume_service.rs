//! 卷业务服务
//!
//! 封装卷的 CRUD 操作，处理软删除时章节解绑等业务规则。

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Volume;
use crate::commands::window::emit_sql_log;
use crate::utils::now;
use crate::repository::volume_repo;

/// 列出书籍的未删除卷
pub fn list_volumes(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<Volume>, AppError> {
    emit_sql_log(app, "SELECT", "volumes", &format!("book_id={book_id}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(volume_repo::list_by_book(&conn, book_id)?)
}

/// 列出已删除的卷
pub fn list_deleted_volumes(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<Volume>, AppError> {
    emit_sql_log(app, "SELECT", "volumes", &format!("book_id={book_id}, deleted"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(volume_repo::list_deleted_by_book(&conn, book_id)?)
}

/// 创建新卷
pub fn create_volume(app: &AppHandle, db: &AppDb, book_id: &str, title: &str, sort_order: i64) -> Result<Volume, AppError> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    emit_sql_log(app, "INSERT", "volumes", &format!("id={id}, title={title}, book_id={book_id}"), file!(), line!());
    let conn = db.pool.get()?;
    volume_repo::insert(&conn, &id, book_id, title, sort_order, &ts)?;
    Ok(Volume {
        id,
        book_id: book_id.to_string(),
        title: title.to_string(),
        sort_order,
        created_at: ts,
        deleted_at: None,
    })
}

/// 更新卷标题
pub fn update_volume(app: &AppHandle, db: &AppDb, id: &str, title: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "volumes", &format!("id={id}, title={title}"), file!(), line!());
    let conn = db.pool.get()?;
    volume_repo::update_title(&conn, id, title)?;
    Ok(())
}

/// 软删除卷
pub fn delete_volume(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "volumes", &format!("id={id}, soft delete"), file!(), line!());
    volume_repo::soft_delete(&conn, id, &ts)?;
    emit_sql_log(app, "UPDATE", "chapters", &format!("set volume_id=NULL where volume_id={id}"), file!(), line!());
    Ok(())
}

/// 恢复已删除的卷
pub fn restore_volume(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "volumes", &format!("id={id}, restore"), file!(), line!());
    let conn = db.pool.get()?;
    volume_repo::restore(&conn, id)?;
    Ok(())
}

/// 硬删除卷（事务包装）：先解除关联章节的 volume_id，再删除卷
///
/// 必须先 UPDATE chapters SET volume_id=NULL，否则 DELETE volumes 触发
/// ON DELETE SET NULL → chapters_fts_au 对大文本重新分词 → SQL logic error。
pub fn hard_delete_volume(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    emit_sql_log(app, "BEGIN", "transaction", "hard_delete_volume", file!(), line!());
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;

    // 先将所有关联章节的 volume_id 置空（避免后续 DELETE 触发 ON DELETE SET NULL → FTS 分词）
    emit_sql_log(app, "UPDATE", "chapters", &format!("clear volume_id for volume={id}"), file!(), line!());
    tx.execute(
        "UPDATE chapters SET volume_id=NULL WHERE volume_id=?1",
        rusqlite::params![id],
    ).map_err(|e| AppError::Business(format!("清除卷关联章节失败: {}", e)))?;

    // 再硬删除卷
    emit_sql_log(app, "DELETE", "volumes", &format!("id={id}, hard delete"), file!(), line!());
    volume_repo::hard_delete(&tx, id)?;

    emit_sql_log(app, "COMMIT", "transaction", "hard_delete_volume committed", file!(), line!());
    tx.commit().map_err(|e| AppError::Business(format!("提交事务失败: {}", e)))?;
    Ok(())
}

/// 重新排序卷
pub fn reorder_volumes(app: &AppHandle, db: &AppDb, ids: &[String]) -> Result<(), AppError> {
    emit_sql_log(app, "UPDATE", "volumes", &format!("reorder {} volumes", ids.len()), file!(), line!());
    let conn = db.pool.get()?;
    Ok(volume_repo::reorder(&conn, ids)?)
}