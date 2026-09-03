//! 任务数据访问层（任务卡模块）
//!
//! 提供 tasks 表的 CRUD SQL 与 row → TaskCard 解析（tags 由 service 聚合填充）。
//! 事务性批量写（拖拽重排、标签整体替换等）在 service 层以 `conn.transaction()`
//! 包裹，repo 仅提供聚焦的单条 SQL 操作。

use rusqlite::{Connection, params, Result};
use crate::models::TaskCard;

/// 完整 SELECT 列名（不含 tags；tags 由 service 聚合）。用于无 JOIN 的单表查询。
pub const TASK_SELECT: &str = "id,project_id,title,description,status,priority,plan_start_time,due_time,planned_today,completed_time,note,remind_at,remind_type,sort_order,deleted_at,created_at,updated_at";

/// 带 `t.` 前缀的列名版本，用于 JOIN projects 的查询，避免列名歧义。
pub const TASK_SELECT_T: &str = "t.id,t.project_id,t.title,t.description,t.status,t.priority,t.plan_start_time,t.due_time,t.planned_today,t.completed_time,t.note,t.remind_at,t.remind_type,t.sort_order,t.deleted_at,t.created_at,t.updated_at";

/// 从 rusqlite Row 解析 TaskCard（按列名取值，tags 初始为空）
pub fn parse_task(row: &rusqlite::Row) -> Result<TaskCard> {
    Ok(TaskCard {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        status: row.get("status")?,
        priority: row.get("priority")?,
        plan_start_time: row.get("plan_start_time")?,
        due_time: row.get("due_time")?,
        planned_today: row.get::<_, i64>("planned_today")? != 0,
        completed_time: row.get("completed_time")?,
        note: row.get("note")?,
        remind_at: row.get("remind_at")?,
        remind_type: row.get("remind_type")?,
        sort_order: row.get("sort_order")?,
        deleted_at: row.get("deleted_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        tags: Vec::new(),
    })
}

/// 回收站行：任务 + 所属项目名（LEFT JOIN，项目软删后仍可显示）
pub struct DeletedTaskRow {
    pub task: TaskCard,
    pub project_name: Option<String>,
}

/// 列出某项目下全部未删除任务（三列一次取回），列内按 sort_order 稳定排序
pub fn list_by_project(conn: &Connection, project_id: &str) -> Result<Vec<TaskCard>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT} FROM tasks \
         WHERE project_id=?1 AND deleted_at IS NULL \
         ORDER BY status, sort_order ASC, created_at ASC"
    ))?;
    let rows = stmt.query_map(params![project_id], |row| parse_task(row))?;
    rows.collect()
}

/// 列出全部未删除任务（跨项目，所属项目必须未删除），供今日任务/搜索聚合
pub fn list_all(conn: &Connection) -> Result<Vec<TaskCard>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT_T} FROM tasks t \
         JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL \
         WHERE t.deleted_at IS NULL \
         ORDER BY t.status, t.sort_order ASC, t.created_at ASC"
    ))?;
    let rows = stmt.query_map([], |row| parse_task(row))?;
    rows.collect()
}

/// 按 id 查询任务（不过滤删除状态，供恢复校验）
pub fn find_by_id(conn: &Connection, id: &str) -> Result<TaskCard> {
    conn.query_row(
        &format!("SELECT {TASK_SELECT} FROM tasks WHERE id=?1"),
        params![id],
        |row| parse_task(row),
    )
}

/// 按 id 查询未删除任务
pub fn find_active(conn: &Connection, id: &str) -> Result<TaskCard> {
    conn.query_row(
        &format!("SELECT {TASK_SELECT} FROM tasks WHERE id=?1 AND deleted_at IS NULL"),
        params![id],
        |row| parse_task(row),
    )
}

/// 列出回收站中的任务（含所属项目名，按删除时间倒序）
pub fn list_deleted(conn: &Connection) -> Result<Vec<DeletedTaskRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_SELECT_T}, p.name AS project_name FROM tasks t \
         LEFT JOIN projects p ON p.id=t.project_id \
         WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC"
    ))?;
    let rows = stmt.query_map([], |row| {
        let task = parse_task(row)?;
        let project_name: Option<String> = row.get("project_name")?;
        Ok(DeletedTaskRow { task, project_name })
    })?;
    rows.collect()
}

/// 插入任务
#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    id: &str,
    project_id: &str,
    title: &str,
    description: &str,
    status: &str,
    priority: &str,
    plan_start_time: Option<&str>,
    due_time: Option<&str>,
    planned_today: i64,
    note: &str,
    sort_order: i64,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO tasks (id,project_id,title,description,status,priority,plan_start_time,due_time,planned_today,note,remind_at,remind_type,sort_order,deleted_at,created_at,updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,'',?11,NULL,?12,?12)",
        params![id, project_id, title, description, status, priority, plan_start_time, due_time, planned_today, note, sort_order, ts],
    )?;
    Ok(())
}

/// 软删除任务
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE tasks SET deleted_at=?1, updated_at=?1 WHERE id=?2 AND deleted_at IS NULL",
        params![ts, id],
    )
}

/// 恢复任务，返回影响行数
pub fn restore(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE tasks SET deleted_at=NULL, updated_at=?1 WHERE id=?2 AND deleted_at IS NOT NULL",
        params![ts, id],
    )
}

/// 硬删除任务（task_tags 由外键级联删除）
pub fn hard_delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM tasks WHERE id=?1", params![id])?;
    Ok(())
}

/// 统计回收站中的任务数量
pub fn count_deleted(conn: &Connection) -> Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE deleted_at IS NOT NULL",
        [],
        |row| row.get(0),
    )
}

/// 清空任务回收站
pub fn clear_trash(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL", [])?;
    Ok(())
}

/// 更新任务单行 sort_order（用于列内重排 / 追加到列尾）
pub fn set_sort_order(conn: &Connection, id: &str, sort_order: i64, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET sort_order=?1, updated_at=?2 WHERE id=?3",
        params![sort_order, ts, id],
    )?;
    Ok(())
}

/// 更新任务状态，并按需设置/清空完成时间（拖拽与勾选完成共用）
pub fn update_status(
    conn: &Connection,
    id: &str,
    status: &str,
    completed_time: Option<&str>,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET status=?1, completed_time=?2, updated_at=?3 WHERE id=?4",
        params![status, completed_time, ts, id],
    )?;
    Ok(())
}

/// 更新任务提醒字段（remind_at / remind_type；remind_at 传 None 表示清除）
pub fn update_remind(
    conn: &Connection,
    id: &str,
    remind_at: Option<&str>,
    remind_type: &str,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE tasks SET remind_at=?1, remind_type=?2, updated_at=?3 WHERE id=?4",
        params![remind_at, remind_type, ts, id],
    )?;
    Ok(())
}

/// 取某项目某状态列末尾的下一个 sort_order（追加到列尾）
pub fn next_sort_order(conn: &Connection, project_id: &str, status: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks \
         WHERE project_id=?1 AND status=?2 AND deleted_at IS NULL",
        params![project_id, status],
        |row| row.get(0),
    )
}

/// 批量查询任务→标签映射，返回 (task_id, Tag) 扁平列表（task_ids 为空返回空）
pub fn tags_of_tasks(
    conn: &Connection,
    task_ids: &[String],
) -> Result<Vec<(String, crate::models::Tag)>> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<&str> = vec!["?"; task_ids.len()];
    let sql = format!(
        "SELECT tt.task_id, t.id, t.name, t.color, t.status, t.created_at, t.updated_at \
         FROM task_tags tt JOIN tags t ON t.id=tt.tag_id \
         WHERE tt.task_id IN ({}) ORDER BY t.name ASC",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(task_ids.iter()), |row| {
        let task_id: String = row.get("task_id")?;
        let tag = crate::models::Tag {
            id: row.get("id")?,
            name: row.get("name")?,
            color: row.get("color")?,
            status: row.get("status")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        };
        Ok((task_id, tag))
    })?;
    rows.collect()
}

/// 删除某任务的全部标签关联（service 事务内配合批量添加）
pub fn clear_task_tags(conn: &Connection, task_id: &str) -> Result<()> {
    conn.execute("DELETE FROM task_tags WHERE task_id=?1", params![task_id])?;
    Ok(())
}

/// 添加单条任务-标签关联（幂等）
pub fn add_task_tag(conn: &Connection, task_id: &str, tag_id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO task_tags (task_id, tag_id, created_at) VALUES (?1,?2,?3)",
        params![task_id, tag_id, ts],
    )?;
    Ok(())
}

/// 项目任务统计（实时聚合）：返回 (total, todo, doing, done, overdue)
pub fn project_counts(
    conn: &Connection,
    project_id: &str,
    now_local: &str,
) -> Result<(i64, i64, i64, i64, i64)> {
    conn.query_row(
        "SELECT \
            COUNT(*) AS total, \
            COALESCE(SUM(CASE WHEN status='todo' THEN 1 ELSE 0 END),0) AS todo, \
            COALESCE(SUM(CASE WHEN status='doing' THEN 1 ELSE 0 END),0) AS doing, \
            COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),0) AS done, \
            COALESCE(SUM(CASE WHEN status!='done' AND due_time IS NOT NULL AND due_time<?1 THEN 1 ELSE 0 END),0) AS overdue \
         FROM tasks WHERE project_id=?2 AND deleted_at IS NULL",
        params![now_local, project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )
}

/// 今日任务概览计数（跨项目，所属项目未删）：
/// 返回 (未完成欠账数, 今日已完成数, 逾期未完成数)
/// 欠账 = 未完成 且（今天到期 | 计划今日 | 已逾期）
pub fn today_overview_counts(
    conn: &Connection,
    today: &str,
    now_local: &str,
) -> Result<(i64, i64, i64)> {
    conn.query_row(
        "SELECT \
            COALESCE(SUM(CASE WHEN t.status!='done' AND (substr(t.due_time,1,10)=?1 OR t.planned_today=1 OR (t.due_time IS NOT NULL AND t.due_time<?2)) THEN 1 ELSE 0 END),0) AS undone_due, \
            COALESCE(SUM(CASE WHEN t.status='done' AND substr(t.completed_time,1,10)=?1 THEN 1 ELSE 0 END),0) AS done_today, \
            COALESCE(SUM(CASE WHEN t.status!='done' AND t.due_time IS NOT NULL AND t.due_time<?2 THEN 1 ELSE 0 END),0) AS overdue \
         FROM tasks t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL \
         WHERE t.deleted_at IS NULL",
        params![today, now_local],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
}

/// "计划今日"滚动清理（PRD 7.4）：由前端在自然日切换（本地 00:00 后首次激活）
/// 时调用，将所有"计划今日且未完成"的任务取消标记，返回影响行数。
/// 之所以全量清理：滚动动作只在跨天后的首次激活执行一次，此刻所有
/// planned_today=1 的未完成任务均来自昨天或更早。
pub fn roll_planned_today(conn: &Connection, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE tasks SET planned_today=0, updated_at=?1 \
         WHERE planned_today=1 AND status!='done' AND deleted_at IS NULL",
        params![ts],
    )
}
