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
///
/// 同时覆盖两种归属方式：`project_id` 直接匹配 + `task_id` 属于该项目的任务。
/// 因为 `try_task_log` 在任务已软删后查不到 project_id，部分日志只有 task_id。
/// **必须在项目硬删除（CASCADE 删 tasks）之前调用**，否则 task_id 子查询落空。
pub fn delete_by_project(conn: &Connection, project_id: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE \
         project_id=?1 OR task_id IN (SELECT id FROM tasks WHERE project_id=?1)",
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
///
/// 同时覆盖 project_id 直接匹配 和 task_id 属于已删项目任务 的日志。
pub fn delete_logs_of_deleted_projects(conn: &Connection) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE \
         project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL) OR \
         task_id IN (SELECT id FROM tasks WHERE project_id IN \
         (SELECT id FROM projects WHERE deleted_at IS NOT NULL))",
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
///
/// 同时覆盖 project_id 直接匹配 和 task_id 属于已过期项目任务 的日志。
pub fn delete_logs_of_expired_projects(conn: &Connection, cutoff: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_activity_logs WHERE \
         project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?1) OR \
         task_id IN (SELECT id FROM tasks WHERE project_id IN \
         (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?1))",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at TEXT);
             CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, deleted_at TEXT);
             CREATE TABLE task_activity_logs (
                 id TEXT PRIMARY KEY, task_id TEXT, project_id TEXT,
                 action TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn delete_by_project_cleans_task_id_only_logs() {
        // 回归测试：try_task_log 在任务软删后查不到 project_id，
        // 部分日志只有 task_id 无 project_id，硬删项目时必须一并清理。
        let conn = setup();
        conn.execute("INSERT INTO projects (id) VALUES ('p1')", []).unwrap();
        conn.execute("INSERT INTO tasks (id, project_id) VALUES ('t1', 'p1')", []).unwrap();
        // L1: project_id 直接匹配
        insert(&conn, "l1", Some("t1"), Some("p1"), "task.created", "", "ts").unwrap();
        // L2: 只有 task_id（模拟任务已软删后 project_id 查不到的场景）
        insert(&conn, "l2", Some("t1"), None, "task.updated", "", "ts").unwrap();
        // L3: 其他项目的日志，不应被删
        conn.execute("INSERT INTO projects (id) VALUES ('p2')", []).unwrap();
        conn.execute("INSERT INTO tasks (id, project_id) VALUES ('t2', 'p2')", []).unwrap();
        insert(&conn, "l3", Some("t2"), Some("p2"), "task.created", "", "ts").unwrap();

        let n = delete_by_project(&conn, "p1").unwrap();
        assert_eq!(n, 2, "应同时清理 project_id 匹配 和 task_id 匹配的日志");

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_activity_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 1, "仅保留其他项目的日志");
    }

    #[test]
    fn delete_logs_of_deleted_projects_covers_task_id_logs() {
        let conn = setup();
        conn.execute("INSERT INTO projects (id, deleted_at) VALUES ('p1', '2026-01-01')", []).unwrap();
        conn.execute("INSERT INTO tasks (id, project_id) VALUES ('t1', 'p1')", []).unwrap();
        // 项目已软删，其下任务的日志（project_id 为 NULL）应被清理
        insert(&conn, "l1", Some("t1"), None, "task.created", "", "ts").unwrap();
        insert(&conn, "l2", Some("t1"), Some("p1"), "task.updated", "", "ts").unwrap();

        let n = delete_logs_of_deleted_projects(&conn).unwrap();
        assert_eq!(n, 2);
    }
}

