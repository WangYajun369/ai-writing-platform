//! 操作日志数据访问层（任务卡 P2）
//!
//! task_activity_logs 表：任务与项目级动作时间线。task_id / project_id
//! 至少一个非空；project_id 冗余冗余便于项目动态与周报统计。

use rusqlite::{Connection, params, Result};
use crate::models::ActivityLog;

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
pub fn list_by_project(conn: &Connection, project_id: &str, limit: i64) -> Result<Vec<ActivityLog>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ACTIVITY_SELECT} FROM task_activity_logs \
         WHERE project_id=?1 ORDER BY created_at DESC, id DESC LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![project_id, limit], |row| parse_log(row))?;
    rows.collect()
}

/// 某项目在时间区间内的完成（action='completed'）日志数量
pub fn count_completed_between(
    conn: &Connection,
    project_id: &str,
    from: &str,
    to: &str,
) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM task_activity_logs \
         WHERE project_id=?1 AND action='completed' AND created_at >= ?2 AND created_at < ?3",
        params![project_id, from, to],
        |row| row.get(0),
    )
}

/// 某项目在时间区间内的新增（action='task.created'）日志数量
pub fn count_created_between(
    conn: &Connection,
    project_id: &str,
    from: &str,
    to: &str,
) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM task_activity_logs \
         WHERE project_id=?1 AND action='task.created' AND created_at >= ?2 AND created_at < ?3",
        params![project_id, from, to],
        |row| row.get(0),
    )
}
