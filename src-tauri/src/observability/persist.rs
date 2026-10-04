//! telemetry_events 表持久化(纯 SQL)
//!
//! 互补内存缓冲:缓冲只保留最近 1000 条,持久化可保留更久(滚动清理)。
//! 不依赖 Tauri State/AppHandle,接收 `&Connection` 写入。

use chrono::Local;
use rusqlite::{params, Connection};
use serde_json::Value;
use uuid::Uuid;

use super::event::{TelemetryEvent, TelemetryKind};
use crate::error::AppError;

/// 写入一条事件(填充 id),返回写入后的完整事件
pub fn insert(conn: &Connection, event: &mut TelemetryEvent) -> Result<(), AppError> {
    let id = Uuid::new_v4().to_string();
    let created_at = Local::now().to_rfc3339();
    let payload_json = event.payload.as_ref().map(Value::to_string);
    conn.execute(
        "INSERT INTO telemetry_events (id, kind, level, timestamp, message, source, file, line, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            event.kind.as_str(),
            event.level,
            event.timestamp,
            event.message,
            event.source,
            event.file,
            event.line.map(|l| l as i64),
            payload_json,
            created_at,
        ],
    )
    .map_err(AppError::Db)?;
    event.id = Some(id);
    Ok(())
}

/// 列出最近 N 条事件(可选 kind 过滤,按 created_at 降序)
pub fn list_recent(
    conn: &Connection,
    kind: Option<TelemetryKind>,
    limit: i64,
) -> Result<Vec<TelemetryEvent>, AppError> {
    let rows: Result<Vec<TelemetryEvent>, AppError> = match kind {
        Some(k) => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, kind, level, timestamp, message, source, file, line, payload, created_at
                     FROM telemetry_events WHERE kind = ?
                     ORDER BY created_at DESC LIMIT ?",
                )
                .map_err(AppError::Db)?;
            let mapped = stmt
                .query_map(params![k.as_str(), limit], row_to_event)
                .map_err(AppError::Db)?;
            mapped.collect::<Result<Vec<_>, _>>().map_err(AppError::Db)
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, kind, level, timestamp, message, source, file, line, payload, created_at
                     FROM telemetry_events ORDER BY created_at DESC LIMIT ?",
                )
                .map_err(AppError::Db)?;
            let mapped = stmt
                .query_map(params![limit], row_to_event)
                .map_err(AppError::Db)?;
            mapped.collect::<Result<Vec<_>, _>>().map_err(AppError::Db)
        }
    };
    rows
}

/// 清空事件(可选 kind 过滤),返回受影响行数
pub fn clear(conn: &Connection, kind: Option<TelemetryKind>) -> Result<usize, AppError> {
    let affected = match kind {
        Some(k) => conn
            .execute(
                "DELETE FROM telemetry_events WHERE kind = ?",
                params![k.as_str()],
            )
            .map_err(AppError::Db)?,
        None => conn
            .execute("DELETE FROM telemetry_events", [])
            .map_err(AppError::Db)?,
    };
    Ok(affected)
}

/// 滚动清理:保留最近 `keep` 条,删除更早的(可选 kind 过滤)
#[cfg_attr(not(test), allow(dead_code))] // 测试中使用，生产环境由调度器按需调用
pub fn trim(conn: &Connection, keep: i64) -> Result<usize, AppError> {
    // 子查询删除:保留最近 keep 条,删除更早的
    let affected = conn
        .execute(
            "DELETE FROM telemetry_events
             WHERE id NOT IN (
                 SELECT id FROM telemetry_events
                 ORDER BY created_at DESC LIMIT ?
             )",
            params![keep],
        )
        .map_err(AppError::Db)?;
    Ok(affected)
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<TelemetryEvent> {
    let kind_str: String = row.get(1)?;
    let kind: TelemetryKind = kind_str.parse().unwrap_or(TelemetryKind::System);
    let payload_str: Option<String> = row.get(8)?;
    let payload = payload_str
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    Ok(TelemetryEvent {
        id: row.get(0)?,
        kind,
        level: row.get(2)?,
        timestamp: row.get(3)?,
        message: row.get(4)?,
        source: row.get(5)?,
        file: row.get(6)?,
        file_name: None,
        line: row.get::<_, Option<i64>>(7)?.map(|l| l as u32),
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE telemetry_events (
                id          TEXT PRIMARY KEY,
                kind        TEXT NOT NULL,
                level       TEXT NOT NULL,
                timestamp   TEXT NOT NULL,
                message     TEXT NOT NULL,
                source      TEXT,
                file        TEXT,
                line        INTEGER,
                payload     TEXT,
                created_at  TEXT NOT NULL
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn insert_and_list_round_trip() {
        let conn = setup();
        let mut e = TelemetryEvent::new(TelemetryKind::Sql, "info", "test sql");
        insert(&conn, &mut e).unwrap();
        assert!(e.id.is_some(), "insert 应填充 id");

        let listed = list_recent(&conn, None, 10).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, TelemetryKind::Sql);
        assert_eq!(listed[0].message, "test sql");
    }

    #[test]
    fn list_filters_by_kind() {
        let conn = setup();
        let mut a = TelemetryEvent::new(TelemetryKind::Sql, "info", "a");
        let mut b = TelemetryEvent::new(TelemetryKind::Error, "error", "b");
        let mut c = TelemetryEvent::new(TelemetryKind::Agent, "info", "c");
        insert(&conn, &mut a).unwrap();
        insert(&conn, &mut b).unwrap();
        insert(&conn, &mut c).unwrap();

        let sqls = list_recent(&conn, Some(TelemetryKind::Sql), 100).unwrap();
        assert_eq!(sqls.len(), 1);
        assert_eq!(sqls[0].kind, TelemetryKind::Sql);

        let errs = list_recent(&conn, Some(TelemetryKind::Error), 100).unwrap();
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].kind, TelemetryKind::Error);

        let all = list_recent(&conn, None, 100).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn clear_removes_events() {
        let conn = setup();
        let mut a = TelemetryEvent::new(TelemetryKind::Sql, "info", "a");
        let mut b = TelemetryEvent::new(TelemetryKind::Error, "error", "b");
        insert(&conn, &mut a).unwrap();
        insert(&conn, &mut b).unwrap();

        let n = clear(&conn, Some(TelemetryKind::Sql)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(list_recent(&conn, None, 100).unwrap().len(), 1);

        let n = clear(&conn, None).unwrap();
        assert_eq!(n, 1);
        assert!(list_recent(&conn, None, 100).unwrap().is_empty());
    }

    #[test]
    fn trim_keeps_only_recent() {
        let conn = setup();
        for i in 0..10 {
            let mut e = TelemetryEvent::new(TelemetryKind::System, "info", format!("e{i}"));
            insert(&conn, &mut e).unwrap();
            // 错开 created_at 以保证 trim 删除最早的
            let created_at = format!("2026-01-{:02}T00:00:00+08:00", i + 1);
            conn.execute(
                "UPDATE telemetry_events SET created_at = ? WHERE id = ?",
                params![created_at, e.id.unwrap()],
            )
            .unwrap();
        }
        let deleted = trim(&conn, 5).unwrap();
        assert_eq!(deleted, 5);
        assert_eq!(list_recent(&conn, None, 100).unwrap().len(), 5);
    }

    #[test]
    fn payload_round_trips_as_json() {
        let conn = setup();
        let mut e = TelemetryEvent::new(TelemetryKind::Error, "error", "boom");
        e.payload = Some(serde_json::json!({"code": "E_TEST", "raw": "boom"}));
        insert(&conn, &mut e).unwrap();

        let listed = list_recent(&conn, Some(TelemetryKind::Error), 1).unwrap();
        let payload = listed[0].payload.as_ref().expect("payload 应有值");
        assert_eq!(payload["code"], "E_TEST");
        assert_eq!(payload["raw"], "boom");
    }
}
