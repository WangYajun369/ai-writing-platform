//! 日程数据访问层
//!
//! 提供 schedules 表的 CRUD。每条日程归属某一天（schedule_date），
//! 同一日期下可有多条日程，按创建时间升序排列。

use rusqlite::{params, Connection, Result};
use crate::models::Schedule;

/// 列出某日期下的全部日程，按创建时间升序
pub fn list_by_date(conn: &Connection, date: &str) -> Result<Vec<Schedule>> {
    let mut stmt = conn.prepare(
        "SELECT id, schedule_date, content, done, created_at, updated_at \
         FROM schedules WHERE schedule_date = ?1 ORDER BY created_at ASC",
    )?;
    let items = stmt.query_map(params![date], |row| {
        Ok(Schedule {
            id: row.get(0)?,
            schedule_date: row.get(1)?,
            content: row.get(2)?,
            done: row.get::<_, i64>(3)? != 0,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 列出某月（prefix 形如 `YYYY-MM`）下的全部日程，按日期 + 创建时间升序
pub fn list_by_month(conn: &Connection, prefix: &str) -> Result<Vec<Schedule>> {
    let mut stmt = conn.prepare(
        "SELECT id, schedule_date, content, done, created_at, updated_at \
         FROM schedules WHERE schedule_date LIKE ?1 || '%' \
         ORDER BY schedule_date ASC, created_at ASC",
    )?;
    let items = stmt.query_map(params![prefix], |row| {
        Ok(Schedule {
            id: row.get(0)?,
            schedule_date: row.get(1)?,
            content: row.get(2)?,
            done: row.get::<_, i64>(3)? != 0,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    items.collect()
}

/// 保存日程：id 已存在则更新，否则插入新记录；返回保存后的完整记录
pub fn save(
    conn: &Connection,
    id: &str,
    date: &str,
    content: &str,
    done: i64,
    ts: &str,
) -> Result<Schedule> {
    conn.execute(
        "UPDATE schedules SET content = ?1, done = ?2, updated_at = ?3 WHERE id = ?4",
        params![content, done, ts, id],
    )?;
    if conn.changes() == 0 {
        conn.execute(
            "INSERT INTO schedules (id, schedule_date, content, done, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, date, content, done, ts],
        )?;
    }
    conn.query_row(
        "SELECT id, schedule_date, content, done, created_at, updated_at \
         FROM schedules WHERE id = ?1",
        params![id],
        |row| {
            Ok(Schedule {
                id: row.get(0)?,
                schedule_date: row.get(1)?,
                content: row.get(2)?,
                done: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
}

/// 按 id 删除日程（不存在时静默成功）
pub fn delete_by_id(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM schedules WHERE id = ?1", params![id])?;
    Ok(())
}
