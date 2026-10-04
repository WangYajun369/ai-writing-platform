//! 卷业务服务
//!
//! 封装卷的 CRUD 操作，处理软删除时章节解绑等业务规则。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Volume;
use crate::repository::{chapter_repo, volume_repo};
use crate::service::uow::UnitOfWork;
use crate::utils::now;
use tauri::AppHandle;
use uuid::Uuid;

/// 列出书籍的未删除卷
pub fn list_volumes(app: &AppHandle, db: &AppDb, book_id: &str) -> Result<Vec<Volume>, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit("SELECT", "volumes", format!("book_id={book_id}"), file!(), line!());
    let volumes = volume_repo::list_by_book(uow.conn(), book_id)?;
    uow.commit()?;
    Ok(volumes)
}

/// 列出已删除的卷
pub fn list_deleted_volumes(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
) -> Result<Vec<Volume>, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "volumes",
        format!("book_id={book_id}, deleted"),
        file!(),
        line!(),
    );
    let volumes = volume_repo::list_deleted_by_book(uow.conn(), book_id)?;
    uow.commit()?;
    Ok(volumes)
}

/// 创建新卷
pub fn create_volume(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    title: &str,
    sort_order: i64,
) -> Result<Volume, AppError> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "INSERT",
        "volumes",
        format!("id={id}, title={title}, book_id={book_id}"),
        file!(),
        line!(),
    );
    volume_repo::insert(uow.conn(), &id, book_id, title, sort_order, &ts)?;
    uow.commit()?;
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
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit("UPDATE", "volumes", format!("id={id}, title={title}"), file!(), line!());
    volume_repo::update_title(uow.conn(), id, title)?;
    uow.commit()?;
    Ok(())
}

/// 软删除卷
pub fn delete_volume(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let ts = now();
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit("UPDATE", "volumes", format!("id={id}, soft delete"), file!(), line!());
    volume_repo::soft_delete(uow.conn(), id, &ts)?;
    // 章节解绑已在 volume_repo::soft_delete 内部的事务中执行；此日志为该次 UPDATE 的审计镜像
    uow.audit(
        "UPDATE",
        "chapters",
        format!("set volume_id=NULL where volume_id={id}"),
        file!(),
        line!(),
    );
    uow.commit()?;
    Ok(())
}

/// 恢复已删除的卷
pub fn restore_volume(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit("UPDATE", "volumes", format!("id={id}, restore"), file!(), line!());
    volume_repo::restore(uow.conn(), id)?;
    uow.commit()?;
    Ok(())
}

/// 硬删除卷（事务包装）：先解除关联章节的 volume_id，再删除卷
///
/// 必须先解除关联章节，否则 DELETE volumes 触发
/// ON DELETE SET NULL → chapters_fts_au 对大文本重新分词 → SQL logic error。
pub fn hard_delete_volume(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let pooled = db.pool.get()?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    // 先将所有关联章节的 volume_id 置空（避免后续 DELETE 触发 ON DELETE SET NULL → FTS 分词）
    chapter_repo::clear_volume_id(uow.conn(), id)
        .map_err(|e| AppError::Business(format!("清除卷关联章节失败: {}", e)))?;
    uow.audit("UPDATE", "chapters", format!("clear volume_id for volume={id}"), file!(), line!());
    // 再硬删除卷
    volume_repo::hard_delete(uow.conn(), id)?;
    uow.audit("DELETE", "volumes", format!("id={id}, hard delete"), file!(), line!());
    uow.commit()?;
    Ok(())
}

/// 重新排序卷
pub fn reorder_volumes(app: &AppHandle, db: &AppDb, ids: &[String]) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "UPDATE",
        "volumes",
        format!("reorder {} volumes", ids.len()),
        file!(),
        line!(),
    );
    volume_repo::reorder(uow.conn(), ids)?;
    uow.commit()?;
    Ok(())
}
