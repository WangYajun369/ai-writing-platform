//! 操作日志 / 执行记录服务（任务卡 P2）
//!
//! 提供尽力而为（never-blocking）的记录函数：日志失败不影响主业务操作。
//! 调用点遍布任务 / 子任务 / 附件 / 迁移等写操作，动作以 action 字符串分类，
//! summary 为人类可读的中文描述，前端按 action 映射图标与颜色。

use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{activity_log_repo, task_repo};
use crate::service::uow::UnitOfWork;
use crate::utils::now;
use tauri::AppHandle;
use uuid::Uuid;

/// 尽力而为地记录一条任务动作（自动补齐 project_id 冗余字段）。
/// 任何失败均被吞掉（记录日志本身不应阻断主流程）。
///
/// **注意**：此函数用 `db` 新连接，**不在调用方事务内**。如果调用方
/// 正在事务中（如 `delete_task`），日志写入与主操作不在同一事务，
/// 可能出现「主操作成功但日志失败丢失」的不一致。需要事务一致性时
/// 改用 [`try_task_log_with_conn`]。
pub fn try_task_log(db: &AppDb, task_id: &str, action: &str, summary: &str) {
    let Ok(conn) = db.pool.get() else { return };
    // 冗余 project_id 查询失败（任务已被删除）时仍会写入日志，项目归属字段置空即可
    let project_id = task_repo::project_id_of_active(&conn, task_id).ok().flatten();
    let _ = insert_quiet(&conn, Some(task_id), project_id.as_deref(), action, summary);
}

/// 在调用方已有的事务连接上记录日志（v1.9 新增）。
///
/// 与 [`try_task_log`] 的区别：
/// - 接收 `&Connection` 而非 `&AppDb`，与主操作共用同一事务；
/// - `project_id` 由调用方预先传入（避免主操作软删除后查不到）；
/// - 失败返回 `Err` 而非吞掉，让调用方用 `?` 决定是否回滚整个事务。
///
/// **语义变化**：从 `try_task_log` 的「尽力而为（never-blocking）」
/// 变为「强一致（strong-consistency）」——日志失败则主操作也回滚，
/// 保证「删除即留痕」原子性。调用方需明确接受此语义。
pub fn try_task_log_with_conn(
    conn: &rusqlite::Connection,
    task_id: &str,
    project_id: Option<&str>,
    action: &str,
    summary: &str,
) -> Result<(), AppError> {
    insert_quiet(conn, Some(task_id), project_id, action, summary)
        .map_err(AppError::from)
}

/// 底层写入：生成 UUID 并委托 repository；底层错误原样返回，由调用方决定是否吞掉
fn insert_quiet(
    conn: &rusqlite::Connection,
    task_id: Option<&str>,
    project_id: Option<&str>,
    action: &str,
    summary: &str,
) -> Result<(), rusqlite::Error> {
    let id = Uuid::new_v4().to_string();
    activity_log_repo::insert(conn, &id, task_id, project_id, action, summary, &now())
}

// ── 只读查询（供 commands 层委派） ──

/// 某任务的动态时间线（最新在前）
pub fn list_by_task(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
    limit: i64,
) -> Result<Vec<crate::models::ActivityLog>, AppError> {
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "task_activity_logs",
        format!("task_id={}, limit={}", task_id, limit),
        file!(),
        line!(),
    );
    let logs = activity_log_repo::list_by_task(uow.conn(), task_id, limit)?;
    uow.commit()?;
    Ok(logs)
}

/// 某项目的动态时间线（最新在前）
pub fn list_by_project(
    app: &AppHandle,
    db: &AppDb,
    project_id: &str,
    limit: i64,
) -> Result<Vec<crate::models::ActivityLog>, AppError> {
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "task_activity_logs",
        format!("project_id={}, limit={}", project_id, limit),
        file!(),
        line!(),
    );
    let logs = activity_log_repo::list_by_project(uow.conn(), project_id, limit)?;
    uow.commit()?;
    Ok(logs)
}
