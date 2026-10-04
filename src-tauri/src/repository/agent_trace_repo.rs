//! Agent 推理轨迹持久化（v1.9）
//!
//! 纯 SQL：每轮 thought / action / observation 写入 agent_traces 表，
//! 调试控制台或前端按 request_id 回放。不依赖 Tauri State / AppHandle。

use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

/// 单条 Agent 轨迹记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTrace {
    pub id: String,
    pub request_id: String,
    pub skill: String,
    pub round: i64,
    /// assistant / tool_call / tool_result / system
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<String>,
    pub tool_result: Option<String>,
    pub created_at: String,
}

/// 写入一条轨迹
pub fn insert_trace(
    conn: &Connection,
    request_id: &str,
    skill: &str,
    round: usize,
    role: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_args: Option<&str>,
    tool_result: Option<&str>,
) -> Result<(), AppError> {
    let id = Uuid::new_v4().to_string();
    let created_at = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_traces (id, request_id, skill, round, role, content, tool_name, tool_args, tool_result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            request_id,
            skill,
            round as i64,
            role,
            content,
            tool_name,
            tool_args,
            tool_result,
            created_at,
        ],
    )
    .map_err(AppError::Db)?;
    Ok(())
}

/// 按 request_id 列出轨迹（按 round + created_at 升序，便于回放）
pub fn list_traces_by_request(
    conn: &Connection,
    request_id: &str,
) -> Result<Vec<AgentTrace>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, request_id, skill, round, role, content, tool_name, tool_args, tool_result, created_at
             FROM agent_traces WHERE request_id = ?
             ORDER BY round ASC, created_at ASC",
        )
        .map_err(AppError::Db)?;
    let rows = stmt
        .query_map(params![request_id], |row| {
            Ok(AgentTrace {
                id: row.get(0)?,
                request_id: row.get(1)?,
                skill: row.get(2)?,
                round: row.get(3)?,
                role: row.get(4)?,
                content: row.get(5)?,
                tool_name: row.get(6)?,
                tool_args: row.get(7)?,
                tool_result: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(AppError::Db)?;
    let mut traces = Vec::new();
    for row in rows {
        traces.push(row.map_err(AppError::Db)?);
    }
    Ok(traces)
}

/// 删除指定 request_id 的全部轨迹（回滚 / 清理用）
pub fn delete_traces_by_request(conn: &Connection, request_id: &str) -> Result<usize, AppError> {
    let affected = conn
        .execute(
            "DELETE FROM agent_traces WHERE request_id = ?",
            params![request_id],
        )
        .map_err(AppError::Db)?;
    Ok(affected)
}

/// 清空全部轨迹（批量清理用，谨慎）
pub fn clear_all_traces(conn: &Connection) -> Result<usize, AppError> {
    let affected = conn
        .execute("DELETE FROM agent_traces", [])
        .map_err(AppError::Db)?;
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE agent_traces (
                id          TEXT PRIMARY KEY,
                request_id  TEXT NOT NULL,
                skill       TEXT NOT NULL,
                round       INTEGER NOT NULL,
                role        TEXT NOT NULL,
                content     TEXT NOT NULL,
                tool_name   TEXT,
                tool_args   TEXT,
                tool_result TEXT,
                created_at  TEXT NOT NULL
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn insert_and_list_traces() {
        let conn = setup();
        insert_trace(
            &conn,
            "req-1",
            "writing",
            0,
            "assistant",
            "正在思考...",
            None,
            None,
            None,
        )
        .unwrap();
        insert_trace(
            &conn,
            "req-1",
            "writing",
            1,
            "tool_call",
            "调用工具",
            Some("read_chapter"),
            Some("{\"id\":\"ch1\"}"),
            None,
        )
        .unwrap();
        insert_trace(
            &conn,
            "req-1",
            "writing",
            1,
            "tool_result",
            "工具结果",
            None,
            None,
            Some("章节内容..."),
        )
        .unwrap();
        let traces = list_traces_by_request(&conn, "req-1").unwrap();
        assert_eq!(traces.len(), 3);
        assert_eq!(traces[0].round, 0);
        assert_eq!(traces[0].role, "assistant");
        assert_eq!(traces[1].tool_name.as_deref(), Some("read_chapter"));
        assert_eq!(traces[2].tool_result.as_deref(), Some("章节内容..."));
    }

    #[test]
    fn list_traces_for_unknown_request_returns_empty() {
        let conn = setup();
        let traces = list_traces_by_request(&conn, "unknown").unwrap();
        assert!(traces.is_empty());
    }

    #[test]
    fn delete_traces_by_request_test() {
        let conn = setup();
        insert_trace(
            &conn,
            "req-1",
            "writing",
            0,
            "assistant",
            "内容",
            None,
            None,
            None,
        )
        .unwrap();
        insert_trace(
            &conn,
            "req-2",
            "research",
            0,
            "assistant",
            "内容",
            None,
            None,
            None,
        )
        .unwrap();
        let deleted = super::delete_traces_by_request(&conn, "req-1").unwrap();
        assert_eq!(deleted, 1);
        assert!(list_traces_by_request(&conn, "req-1").unwrap().is_empty());
        assert_eq!(list_traces_by_request(&conn, "req-2").unwrap().len(), 1);
    }

    #[test]
    fn clear_all_traces_test() {
        let conn = setup();
        insert_trace(
            &conn,
            "req-1",
            "writing",
            0,
            "assistant",
            "内容",
            None,
            None,
            None,
        )
        .unwrap();
        insert_trace(
            &conn,
            "req-2",
            "research",
            0,
            "assistant",
            "内容",
            None,
            None,
            None,
        )
        .unwrap();
        let deleted = super::clear_all_traces(&conn).unwrap();
        assert_eq!(deleted, 2);
        assert!(list_traces_by_request(&conn, "req-1").unwrap().is_empty());
    }
}
