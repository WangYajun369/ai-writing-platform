//! 项目数据访问层（任务卡模块）
//!
//! 提供 projects 表的 CRUD SQL 与 row → Project 解析。
//! 项目软删除时连带其下任务一并软删（由 service 在同一事务内调用）。

use crate::models::Project;
use crate::repository::soft_delete::{self, Table};
use rusqlite::{params, Connection, OptionalExtension, Result};

/// 完整 SELECT 列名
pub const PROJECT_SELECT: &str = "id,name,description,color,icon,status,plan_start_date,plan_end_date,pinned,sort_order,deleted_at,created_at,updated_at";

/// `projects` 表的软删除 marker（v1.9 架构优化 #2）
pub struct ProjectTable;
impl Table for ProjectTable {
    const NAME: &'static str = "projects";
}

/// 未删除项目总数（默认颜色轮询等场景）
pub fn count_active(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    )
}

/// 按名称查找未删除项目 id（迁移默认项目复用等场景），不存在返回 None
pub fn find_id_by_name(conn: &Connection, name: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM projects WHERE name=?1 AND deleted_at IS NULL LIMIT 1",
        params![name],
        |r| r.get(0),
    )
    .optional()
}

/// 从 rusqlite Row 解析 Project（按列名取值）
pub fn parse_project(row: &rusqlite::Row) -> Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        color: row.get("color")?,
        icon: row.get("icon")?,
        status: row.get("status")?,
        plan_start_date: row.get("plan_start_date")?,
        plan_end_date: row.get("plan_end_date")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        sort_order: row.get("sort_order")?,
        deleted_at: row.get("deleted_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 列出未删除项目；status 为 Some 时按状态过滤。
/// 默认排序：置顶 → 进行中(active)优先 → 最近更新时间倒序（PRD 9.1.3）
pub fn list(conn: &Connection, status: Option<&str>) -> Result<Vec<Project>> {
    let (sql, cond) = match status {
        Some(_) => (
            format!(
                "SELECT {PROJECT_SELECT} FROM projects WHERE deleted_at IS NULL AND status=?1 \
                 ORDER BY pinned DESC, CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, updated_at DESC"
            ),
            true,
        ),
        None => (
            format!(
                "SELECT {PROJECT_SELECT} FROM projects WHERE deleted_at IS NULL \
                 ORDER BY pinned DESC, CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, updated_at DESC"
            ),
            false,
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    if cond {
        let rows = stmt.query_map(params![status.unwrap()], parse_project)?;
        rows.collect()
    } else {
        let rows = stmt.query_map([], parse_project)?;
        rows.collect()
    }
}

/// 按 id 查询项目（不过滤删除状态，供详情与软删恢复校验）
pub fn find_by_id(conn: &Connection, id: &str) -> Result<Project> {
    conn.query_row(
        &format!("SELECT {PROJECT_SELECT} FROM projects WHERE id=?1"),
        params![id],
        parse_project,
    )
}

/// 按 id 查询未删除的项目（详情页使用，已删项目报错由 service 转换）
pub fn find_active(conn: &Connection, id: &str) -> Result<Project> {
    conn.query_row(
        &format!("SELECT {PROJECT_SELECT} FROM projects WHERE id=?1 AND deleted_at IS NULL"),
        params![id],
        parse_project,
    )
}

/// 列出回收站中的项目（按删除时间倒序）
pub fn list_deleted(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROJECT_SELECT} FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    ))?;
    let rows = stmt.query_map([], parse_project)?;
    rows.collect()
}

/// 插入新项目
#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    color: &str,
    icon: &str,
    status: &str,
    plan_start_date: Option<&str>,
    plan_end_date: Option<&str>,
    pinned: i64,
    ts: &str,
) -> Result<()> {
    // sort_order 固定初始 0、deleted_at 置 NULL；created_at/updated_at 共用同一时间戳
    conn.execute(
        "INSERT INTO projects (id,name,description,color,icon,status,plan_start_date,plan_end_date,pinned,sort_order,deleted_at,created_at,updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,NULL,?10,?10)",
        params![id, name, description, color, icon, status, plan_start_date, plan_end_date, pinned, ts],
    )?;
    Ok(())
}

/// 软删除项目（标记 deleted_at）
///
/// 委派到 `soft_delete::soft_delete::<ProjectTable>`（v1.9 架构优化 #2）
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    soft_delete::soft_delete::<ProjectTable>(conn, id, ts)
}

/// 连带软删除某项目下全部未删除任务（service 事务内调用）
pub fn soft_delete_tasks(conn: &Connection, project_id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE tasks SET deleted_at=?1, updated_at=?1 WHERE project_id=?2 AND deleted_at IS NULL",
        params![ts, project_id],
    )
}

/// 恢复项目（清除 deleted_at），返回影响行数
///
/// 委派到 `soft_delete::restore::<ProjectTable>`（v1.9 架构优化 #2）
pub fn restore(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    soft_delete::restore::<ProjectTable>(conn, id, ts)
}

/// 连带恢复「随项目一并删除」的任务（deleted_at 与项目删除时间戳一致者）。
/// 项目删除前已单独进回收站的任务保持原状，由用户自行决定是否恢复。
pub fn restore_tasks(
    conn: &Connection,
    project_id: &str,
    project_deleted_at: &str,
    ts: &str,
) -> Result<usize> {
    conn.execute(
        "UPDATE tasks SET deleted_at=NULL, updated_at=?1 \
         WHERE project_id=?2 AND deleted_at IS NOT NULL AND deleted_at=?3",
        params![ts, project_id, project_deleted_at],
    )
}

/// 硬删除项目（ON DELETE CASCADE 级联删除其下任务与任务标签关联；
/// 仅限回收站中的项目，返回影响行数）
///
/// 委派到 `soft_delete::hard_delete_trashed::<ProjectTable>`（v1.9 架构优化 #2）
pub fn hard_delete(conn: &Connection, id: &str) -> Result<usize> {
    soft_delete::hard_delete_trashed::<ProjectTable>(conn, id)
}

/// 统计回收站中的项目数量
///
/// 委派到 `soft_delete::count_deleted::<ProjectTable>`（v1.9 架构优化 #2）
pub fn count_deleted(conn: &Connection) -> Result<u32> {
    soft_delete::count_deleted::<ProjectTable>(conn)
}

/// 清空项目回收站（级联删除其下任务）
///
/// 委派到 `soft_delete::clear_trash::<ProjectTable>`（v1.9 架构优化 #2）
pub fn clear_trash(conn: &Connection) -> Result<()> {
    soft_delete::clear_trash::<ProjectTable>(conn)
}

/// 回收站自动清理：硬删除删除时间早于 cutoff 的项目（PRD 9.12.2 保留 30 天）。
/// 其下任务 / 附件 / 里程碑 / 操作日志由外键级联删除。
/// deleted_at 为 UTC RFC3339 字符串（与 cutoff 同格式，可字典序比较）。
///
/// 委派到 `soft_delete::purge_expired::<ProjectTable>`（v1.9 架构优化 #2）
pub fn purge_expired(conn: &Connection, cutoff: &str) -> Result<usize> {
    soft_delete::purge_expired::<ProjectTable>(conn, cutoff)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小 projects + tasks 表（与 db/mod.rs DDL 等价，仅保留本测试用到的列）
    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                status     TEXT NOT NULL DEFAULT 'active',
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE tasks (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title      TEXT NOT NULL,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn insert_task(conn: &Connection, id: &str, pid: &str, deleted_at: Option<&str>) {
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, deleted_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![id, pid, id, deleted_at],
        )
        .unwrap();
    }

    fn task_deleted(conn: &Connection, id: &str) -> bool {
        conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM tasks WHERE id=?1",
            params![id],
            |r| r.get::<_, bool>(0),
        )
        .unwrap()
    }

    /// P1-3 回归：级联恢复只还原「随项目同一时刻删除」的任务——
    /// 先于项目单独删除的任务（deleted_at 不同）必须仍留在回收站。
    #[test]
    fn restore_tasks_only_cascades_same_batch() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO projects (id, name, deleted_at, created_at, updated_at)
             VALUES ('p1', '项目', '2026-09-28T10:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        // 随项目同一时刻软删（应恢复）
        insert_task(&conn, "t1", "p1", Some("2026-09-28T10:00:00Z"));
        insert_task(&conn, "t2", "p1", Some("2026-09-28T10:00:00Z"));
        // 更早单独删除的任务（不应恢复）
        insert_task(&conn, "t3", "p1", Some("2026-09-01T08:00:00Z"));
        // 未删除的活跃任务（restore_tasks 不应误伤）
        insert_task(&conn, "t4", "p1", None);

        let n = restore_tasks(&conn, "p1", "2026-09-28T10:00:00Z", "2026-09-29T00:00:00Z").unwrap();
        assert_eq!(n, 2, "只应恢复随项目同批删除的 2 条");
        assert!(!task_deleted(&conn, "t1"));
        assert!(!task_deleted(&conn, "t2"));
        assert!(task_deleted(&conn, "t3"), "更早单独删除的任务应保持软删");
        assert!(!task_deleted(&conn, "t4"), "活跃任务不受影响");
    }

    /// P0-1 回归：hard_delete 只作用于回收站中的项目（活跃项目不可硬删）
    #[test]
    fn hard_delete_only_touches_trashed() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO projects (id, name, deleted_at, created_at, updated_at)
             VALUES ('live', '活跃', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, deleted_at, created_at, updated_at)
             VALUES ('dead', '已删', '2026-09-28T10:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        let n = hard_delete(&conn, "live").unwrap();
        assert_eq!(n, 0, "活跃项目硬删应影响 0 行");
        let n = hard_delete(&conn, "dead").unwrap();
        assert_eq!(n, 1, "回收站项目硬删应影响 1 行");
        let count: u32 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "只剩活跃项目");
    }
}
