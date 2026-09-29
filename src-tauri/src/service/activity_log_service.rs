//! 操作日志 / 执行记录服务（任务卡 P2）
//!
//! 提供尽力而为（never-blocking）的记录函数：日志失败不影响主业务操作。
//! 调用点遍布任务 / 子任务 / 附件 / 迁移等写操作，动作以 action 字符串分类，
//! summary 为人类可读的中文描述，前端按 action 映射图标与颜色。

use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{activity_log_repo, task_repo};
use crate::utils::now;
use uuid::Uuid;

/// 尽力而为地记录一条任务动作（自动补齐 project_id 冗余字段）。
/// 任何失败均被吞掉（记录日志本身不应阻断主流程）。
pub fn try_task_log(db: &AppDb, task_id: &str, action: &str, summary: &str) {
    let Ok(conn) = db.pool.get() else { return };
    // 冗余 project_id 查询失败（任务已被删除）时仍会写入日志，项目归属字段置空即可
    let project_id = task_repo::project_id_of_active(&conn, task_id).ok().flatten();
    let _ = insert_quiet(&conn, Some(task_id), project_id.as_deref(), action, summary);
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
    db: &AppDb,
    task_id: &str,
    limit: i64,
) -> Result<Vec<crate::models::ActivityLog>, AppError> {
    let conn = db.pool.get()?;
    Ok(activity_log_repo::list_by_task(&conn, task_id, limit)?)
}

/// 某项目的动态时间线（最新在前）
pub fn list_by_project(
    db: &AppDb,
    project_id: &str,
    limit: i64,
) -> Result<Vec<crate::models::ActivityLog>, AppError> {
    let conn = db.pool.get()?;
    Ok(activity_log_repo::list_by_project(&conn, project_id, limit)?)
}
