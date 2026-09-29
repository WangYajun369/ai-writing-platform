//! 操作日志数据访问层（任务卡 P2）
//!
//! task_activity_logs 表：任务与项目级动作时间线。task_id / project_id
//! 至少一个非空；project_id 冗余冗余便于项目动态与周报统计。
//!
//! action 为固定枚举字符串（如 task.created / task.completed），由 service 层写入；
//! 时间线统一按 created_at DESC、id DESC 排序，同一时刻的多条记录也能稳定排序。
//!
//! 注意：本表 task_id / project_id **无外键**，硬删除任务/项目时由 service 层
//! 显式调用 delete_by_* 系列函数清理，避免日志孤儿化。

use crate::models::ActivityLog;
use rusqlite::{params, Connection, Result};

/// 完整 SELECT 列名
pub const ACTIVITY_SELECT: &str = "id,task_id,project_id,action,summary,created_at";

/// 从 rusqlite Row 解析 ActivityLog
pub fn parse_log(row: &rusqlite::Row) -> Result<ActivityLog> {
    Ok(ActivityLog {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        project_id: row.get("project_id")?,
        action: row.get("action")?,
        summary: row.get("summary")?,
        created_at: row.get("created_at")?,
    })
}

/// 写入一条操作日志
pub fn insert(
    conn: &Connection,
    id: &str,
    task_id: Option<&str>,
    project_id: Option<&str>,
    action: &str,
    summary: &str,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO task_activity_logs (id,task_id,project_id,action,summary,created_at) \
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, task_id, project_id, action, summary, ts],
    )?;
    Ok(())
}

/// 某任务的动态时间线（时间倒序，最新在前）
pub fn list_by_task(conn: &Connection, task_id: &str, limit: i64) -> Result<Vec<ActivityLog>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACTIVITY_SELECT} FROM task_activity_logs \
         WHERE task_id=?1 ORDER BY created_at DESC, id DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![task_id, limit], |row| parse_log(row))?;
    rows.collect()
}

/// 某项目的动态时间线（时间倒序）
pub fn list_by_project(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> Result<Vec<ActivityLog>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACTIVITY_SELECT} FROM task_activity_logs \
         WHERE project_id=?1 ORDER BY created_at DESC, id DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![project_id, limit], |row| parse_log(row))?;
    rows.collect()
}

/// 某项目自 from（UTC RFC3339）以来的创建/完成日志（action, created_at），
/// 供周报统计在 Rust 侧按本地周分桶（替代逐周串行 COUNT 查询）
pub fn list_weekly_actions_since(
    conn: &Connection,
    project_id: &str,
    from: &str,
) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT action, created_at FROM task_activity_logs \
         WHERE project_id=?1 AND created_at >= ?2 \
         AND action IN ('task.created','task.completed')",
    )?;
    let rows = stmt.query_map(params![project_id, from], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

// ── 孤儿日志清理（表无外键，硬删除路径由 service 显式调用） ──

/// 删除指定任务的全部操作日志（硬删除任务时同事务调用）
pub fn delete_by_task(conn: &Connection, task_id: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE task_id=?1",
        params![task_id],
    )
}

/// 删除指定项目的全部操作日志（硬删除项目时同事务调用）
pub fn delete_by_project(conn: &Connection, project_id: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE project_id=?1",
        params![project_id],
    )
}

/// 删除全部已软删任务的操作日志（清空任务回收站前置调用）
pub fn delete_logs_of_deleted_tasks(conn: &Connection) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE task_id IN \
         (SELECT id FROM tasks WHERE deleted_at IS NOT NULL)",
        [],
    )
}

/// 删除全部已软删项目的操作日志（清空项目回收站前置调用）
pub fn delete_logs_of_deleted_projects(conn: &Connection) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE project_id IN \
         (SELECT id FROM projects WHERE deleted_at IS NOT NULL)",
        [],
    )
}

/// 删除删除时间早于 cutoff 的已软删任务日志（回收站自动清理前置调用）
pub fn delete_logs_of_expired_tasks(conn: &Connection, cutoff: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE task_id IN \
         (SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?1)",
        params![cutoff],
    )
}

/// 删除删除时间早于 cutoff 的已软删项目日志（回收站自动清理前置调用）
pub fn delete_logs_of_expired_projects(conn: &Connection, cutoff: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE project_id IN \
         (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?1)",
        params![cutoff],
    )
}

/// 兜底清理历史遗留孤儿日志（task_id/project_id 指向已不存在的行）
pub fn delete_orphan_logs(conn: &Connection) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE \
         (task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks)) OR \
         (project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects))",
        [],
    )
}

