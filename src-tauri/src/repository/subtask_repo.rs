//! 子任务数据访问层（任务卡 P2）
//!
//! 提供 task_subtasks 表的 CRUD SQL 与 row → TaskSubtask 解析。
//! 子任务随任务级联删除（ON DELETE CASCADE），不做软删除/回收站。

use crate::models::TaskSubtask;
use rusqlite::{params, Connection, Result};

/// 完整 SELECT 列名
pub const SUBTASK_SELECT: &str = "id,task_id,title,done,sort_order,created_at,updated_at";

/// 从 rusqlite Row 解析 TaskSubtask（按列名取值）
pub fn parse_subtask(row: &rusqlite::Row) -> Result<TaskSubtask> {
    Ok(TaskSubtask {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        title: row.get("title")?,
        done: row.get::<_, i64>("done")? != 0,
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 列出某任务全部子任务（未完成在前，均按 sort_order 排序）
pub fn list_by_task(conn: &Connection, task_id: &str) -> Result<Vec<TaskSubtask>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUBTASK_SELECT} FROM task_subtasks \
         WHERE task_id=?1 ORDER BY done ASC, sort_order ASC, created_at ASC"
    ))?;
    let rows = stmt.query_map(params![task_id], |row| parse_subtask(row))?;
    rows.collect()
}

/// 按 id 查询子任务
pub fn find_by_id(conn: &Connection, id: &str) -> Result<TaskSubtask> {
    conn.query_row(
        &format!("SELECT {SUBTASK_SELECT} FROM task_subtasks WHERE id=?1"),
        params![id],
        |row| parse_subtask(row),
    )
}

/// 插入子任务
pub fn insert(
    conn: &Connection,
    id: &str,
    task_id: &str,
    title: &str,
    sort_order: i64,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO task_subtasks (id,task_id,title,done,sort_order,created_at,updated_at) \
         VALUES (?1,?2,?3,0,?4,?5,?5)",
        params![id, task_id, title, sort_order, ts],
    )?;
    Ok(())
}

/// 更新标题
pub fn rename(conn: &Connection, id: &str, title: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE task_subtasks SET title=?1, updated_at=?2 WHERE id=?3",
        params![title, ts, id],
    )
}

/// 勾选/取消完成
pub fn set_done(conn: &Connection, id: &str, done: bool, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE task_subtasks SET done=?1, updated_at=?2 WHERE id=?3",
        params![if done { 1 } else { 0 }, ts, id],
    )
}

/// 更新单行 sort_order（service 事务内批量重排）
pub fn set_sort_order(conn: &Connection, id: &str, sort_order: i64, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE task_subtasks SET sort_order=?1, updated_at=?2 WHERE id=?3",
        params![sort_order, ts, id],
    )
}

/// 硬删除子任务
pub fn delete(conn: &Connection, id: &str) -> Result<usize> {
    conn.execute("DELETE FROM task_subtasks WHERE id=?1", params![id])
}

/// 取某任务下末尾下一个 sort_order（追加到底部，已完成区之后也不影响手动重排）
pub fn next_sort_order(conn: &Connection, task_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM task_subtasks WHERE task_id=?1",
        params![task_id],
        |row| row.get(0),
    )
}
