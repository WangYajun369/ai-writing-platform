//! 格式导出服务（TXT / MD / HTML）
//!
//! 将书籍所有章节以指定格式导出为单一文件所需的数据加载收口于此。
//! commands 层仅负责文件 IO 与格式渲染，DB 读取 + 审计由本服务承担。

use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{book_repo, chapter_repo};
use crate::service::uow::UnitOfWork;
use tauri::AppHandle;

/// 导出单书所需的全部数据：书名、作者、章节列表（带卷标题）。
///
/// 通过 UnitOfWork 统一收口两条 SELECT 的审计日志。
pub fn load_book_export_data(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
) -> Result<(String, String, Vec<chapter_repo::ChapterExportRow>), AppError> {
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));

    uow.audit(
        "SELECT",
        "books",
        format!("id={}, export info", book_id),
        file!(),
        line!(),
    );
    let (title, author) = book_repo::find_title_author(uow.conn(), book_id)?;

    uow.audit(
        "SELECT",
        "chapters",
        format!("book_id={}, export chapters (with volume)", book_id),
        file!(),
        line!(),
    );
    let rows = chapter_repo::list_export_with_volume(uow.conn(), book_id)?;

    uow.commit()?;
    Ok((title, author, rows))
}
