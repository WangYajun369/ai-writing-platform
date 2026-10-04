//! 版本快照业务服务
//!
//! 封装快照创建、查询、恢复等业务逻辑，
//! 包含恢复后的事件通知。

use crate::commands::chapter::SaveChapterResult;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Snapshot;
use crate::repository::{book_repo, chapter_repo, snapshot_repo};
use crate::service::uow::UnitOfWork;
use crate::utils::now;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// 列出章节的所有快照
pub fn list_snapshots(
    app: &AppHandle,
    db: &AppDb,
    chapter_id: &str,
) -> Result<Vec<Snapshot>, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "snapshots",
        format!("chapter_id={chapter_id}"),
        file!(),
        line!(),
    );
    let snapshots = snapshot_repo::list_by_chapter(uow.conn(), chapter_id)?;
    uow.commit()?;
    Ok(snapshots)
}

/// 创建快照（auto/milestone）
pub fn create_snapshot(
    app: &AppHandle,
    db: &AppDb,
    chapter_id: &str,
    label: &Option<String>,
) -> Result<Snapshot, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "chapters",
        format!("id={chapter_id}, for snapshot content"),
        file!(),
        line!(),
    );
    let (content_html, word_count) = chapter_repo::find_content_and_wc(uow.conn(), chapter_id)?;

    let id = Uuid::new_v4().to_string();
    let ts = now();
    // 带标签 = 里程碑快照（用户手动打点）；无标签 = 自动快照（常规保存时触发）
    let snap_type = if label.is_some() { "milestone" } else { "auto" };

    uow.audit(
        "INSERT",
        "snapshots",
        format!("id={id}, chapter_id={chapter_id}, type={snap_type}"),
        file!(),
        line!(),
    );
    snapshot_repo::insert(
        uow.conn(),
        &id,
        chapter_id,
        &content_html,
        word_count,
        snap_type,
        label,
        &ts,
    )?;
    uow.commit()?;

    Ok(Snapshot {
        id,
        chapter_id: chapter_id.to_string(),
        content_html,
        word_count,
        snapshot_type: snap_type.to_string(),
        label: label.clone(),
        created_at: ts,
    })
}

/// 获取快照内容
pub fn get_snapshot_content(
    app: &AppHandle,
    db: &AppDb,
    snapshot_id: &str,
) -> Result<String, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "snapshots",
        format!("id={snapshot_id}, content_html"),
        file!(),
        line!(),
    );
    let content = snapshot_repo::find_content(uow.conn(), snapshot_id)?;
    uow.commit()?;
    Ok(content)
}

/// 从快照恢复章节内容
pub fn restore_snapshot(
    app: &AppHandle,
    db: &AppDb,
    snapshot_id: &str,
) -> Result<SaveChapterResult, AppError> {
    // 恢复内容与书籍字数重算放入同一事务，避免部分提交导致字数不一致
    let pooled = db.pool.get()?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;

    uow.audit("SELECT", "snapshots", format!("id={snapshot_id}, restore content"), file!(), line!());
    let (chapter_id, content_html, wc) = snapshot_repo::find_full(uow.conn(), snapshot_id)?;

    // save 前先取当前章节归属书籍与旧字数（用于 delta 计算）
    uow.audit("SELECT", "chapters", format!("id={chapter_id}, find_book_and_wc"), file!(), line!());
    let (book_id, old_wc) = chapter_repo::find_book_and_wc(uow.conn(), &chapter_id)?;

    let ts = now();
    uow.audit("UPDATE", "chapters", format!("id={chapter_id}, restore from snapshot"), file!(), line!());
    // 快照 wc 为该版本创建时的字数：恢复后章节字数回到版本值，再按差值 delta 更新书籍聚合
    chapter_repo::save_content(uow.conn(), &chapter_id, &content_html, wc, &ts)?;

    // 按差值增量更新书籍总字数（O(1) delta 更新，避免全量 SUM 扫描所有章节）
    let delta = wc.saturating_sub(old_wc);
    uow.audit("UPDATE", "books", format!("id={book_id}, apply_word_count_delta={delta}"), file!(), line!());
    book_repo::apply_word_count_delta(uow.conn(), &book_id, delta, &ts)?;

    let book_wc = book_repo::word_count_by_book(uow.conn(), &book_id)?;

    uow.audit("COMMIT", "transaction", "restore_snapshot committed", file!(), line!());
    uow.commit()
        .map_err(|e| AppError::Business(format!("提交事务失败: {}", e)))?;

    // 通知主窗口刷新编辑器内容
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("history-snapshot-restored", &chapter_id);
    }

    Ok(SaveChapterResult {
        word_count: wc,
        book_word_count: book_wc,
    })
}

/// 删除快照
pub fn delete_snapshot(app: &AppHandle, db: &AppDb, snapshot_id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit("DELETE", "snapshots", format!("id={snapshot_id}"), file!(), line!());
    snapshot_repo::delete(uow.conn(), snapshot_id)?;
    uow.commit()?;
    Ok(())
}
