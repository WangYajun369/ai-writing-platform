//! 项目数据访问层（任务卡模块）
//!
//! 提供 projects 表的 CRUD SQL 与 row → Project 解析。
//! 项目软删除时连带其下任务一并软删（由 service 在同一事务内调用）。

use rusqlite::{Connection, params, Result};
use crate::models::Project;

/// 完整 SELECT 列名
pub const PROJECT_SELECT: &str = "id,name,description,color,icon,status,plan_start_date,plan_end_date,pinned,sort_order,deleted_at,created_at,updated_at";

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
        let rows = stmt.query_map(params![status.unwrap()], |row| parse_project(row))?;
        rows.collect()
    } else {
        let rows = stmt.query_map([], |row| parse_project(row))?;
        rows.collect()
    }
}

/// 按 id 查询项目（不过滤删除状态，供详情与软删恢复校验）
pub fn find_by_id(conn: &Connection, id: &str) -> Result<Project> {
    conn.query_row(
        &format!("SELECT {PROJECT_SELECT} FROM projects WHERE id=?1"),
        params![id],
        |row| parse_project(row),
    )
}

/// 按 id 查询未删除的项目（详情页使用，已删项目报错由 service 转换）
pub fn find_active(conn: &Connection, id: &str) -> Result<Project> {
    conn.query_row(
        &format!("SELECT {PROJECT_SELECT} FROM projects WHERE id=?1 AND deleted_at IS NULL"),
        params![id],
        |row| parse_project(row),
    )
}

/// 列出回收站中的项目（按删除时间倒序）
pub fn list_deleted(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROJECT_SELECT} FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    ))?;
    let rows = stmt.query_map([], |row| parse_project(row))?;
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
    conn.execute(
        "INSERT INTO projects (id,name,description,color,icon,status,plan_start_date,plan_end_date,pinned,sort_order,deleted_at,created_at,updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,NULL,?10,?10)",
        params![id, name, description, color, icon, status, plan_start_date, plan_end_date, pinned, ts],
    )?;
    Ok(())
}

/// 软删除项目（标记 deleted_at）
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE projects SET deleted_at=?1, updated_at=?1 WHERE id=?2 AND deleted_at IS NULL",
        params![ts, id],
    )
}

/// 连带软删除某项目下全部未删除任务（service 事务内调用）
pub fn soft_delete_tasks(conn: &Connection, project_id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE tasks SET deleted_at=?1, updated_at=?1 WHERE project_id=?2 AND deleted_at IS NULL",
        params![ts, project_id],
    )
}

/// 恢复项目（清除 deleted_at），返回影响行数
pub fn restore(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE projects SET deleted_at=NULL, updated_at=?1 WHERE id=?2 AND deleted_at IS NOT NULL",
        params![ts, id],
    )
}

/// 连带恢复某项目下全部已删除任务（service 事务内调用）
pub fn restore_tasks(conn: &Connection, project_id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE tasks SET deleted_at=NULL, updated_at=?1 WHERE project_id=?2 AND deleted_at IS NOT NULL",
        params![ts, project_id],
    )
}

/// 硬删除项目（ON DELETE CASCADE 会级联删除其下任务与任务标签关联）
pub fn hard_delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM projects WHERE id=?1", params![id])?;
    Ok(())
}

/// 统计回收站中的项目数量
pub fn count_deleted(conn: &Connection) -> Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE deleted_at IS NOT NULL",
        [],
        |row| row.get(0),
    )
}

/// 清空项目回收站（级联删除其下任务）
pub fn clear_trash(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM projects WHERE deleted_at IS NOT NULL", [])?;
    Ok(())
}
