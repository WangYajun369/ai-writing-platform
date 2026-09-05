//! 任务卡模块 key-value 存储（task_meta 表）
//!
//! 用于模块级持久化：日程迁移幂等标记、提醒偏好、提醒触发去重等。

use rusqlite::{params, Connection, Result};

/// 读取指定 key 的值，不存在返回 None
pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM task_meta WHERE key=?1")?;
    let mut rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
    match rows.next() {
        Some(r) => r.map(Some),
        None => Ok(None),
    }
}

/// 写入 key-value（upsert）
pub fn set(conn: &Connection, key: &str, value: &str, ts: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO task_meta (key,value,updated_at) VALUES (?1,?2,?3) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        params![key, value, ts],
    )?;
    Ok(())
}
