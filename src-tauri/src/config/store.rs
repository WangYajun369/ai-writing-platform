//! app_config 表持久化(纯 SQL,不依赖 Tauri State/AppHandle)
//!
//! 与 `app_config` 表(section-key-value,带 ConfigVersion)互操作:
//! - [`upsert`] — 写入或更新一段配置(以 section 为主键)
//! - [`load`] — 读取一段配置(返回完整 `ConfigRecord`,含 version / updated_at)
//! - [`delete`] — 删除一段配置(供调试 / 重置场景使用)
//! - [`list_meta`] — 列出所有段的元信息(供 `get_config_meta` IPC 命令使用)
//!
//! 三层加载入口在 [`super::commands`] 层完成:默认值 → 持久化值 → env 覆盖。

use anyhow::Context;
use rusqlite::{params, Connection};
use serde_json::Value;

use super::model::{ConfigRecord, ConfigSection};
use crate::error::AppError;

/// 写入或更新一段配置(以 section 为主键,version 由调用方传入)
///
/// 调用方应在 `set_config` 命令层传入当前 [`super::CONFIG_VERSION`]。
pub fn upsert(
    conn: &Connection,
    section: ConfigSection,
    value: &Value,
    version: u32,
) -> Result<(), AppError> {
    let value_str = serde_json::to_string(value).map_err(AppError::Serde)?;
    let updated_at = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO app_config (section, value, version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(section) DO UPDATE SET
            value = excluded.value,
            version = excluded.version,
            updated_at = excluded.updated_at",
        params![section.as_str(), value_str, version, updated_at],
    )
    .map_err(AppError::Db)?;
    Ok(())
}

/// 读取一段配置的完整记录(含 version / updated_at)。
///
/// 返回 `Ok(None)` 表示该段未持久化(调用方应 fallback 到默认值)。
pub fn load(conn: &Connection, section: ConfigSection) -> Result<Option<ConfigRecord>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT section, value, version, updated_at
             FROM app_config WHERE section = ?",
        )
        .map_err(AppError::Db)?;

    stmt.query_row(params![section.as_str()], |r| {
        let value_str: String = r.get(1)?;
        let value: Value = serde_json::from_str(&value_str).unwrap_or(Value::Null);
        Ok(ConfigRecord {
            section: r.get(0)?,
            value,
            version: r.get::<_, i64>(2)? as u32,
            updated_at: r.get(3)?,
        })
    })
    .map(Some)
    .or_else(|e| {
        if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
            Ok(None)
        } else {
            Err(AppError::Db(e))
        }
    })
}

/// 删除一段配置(供调试 / 重置场景使用)。返回是否实际删除。
pub fn delete(conn: &Connection, section: ConfigSection) -> Result<bool, AppError> {
    let affected = conn
        .execute(
            "DELETE FROM app_config WHERE section = ?",
            params![section.as_str()],
        )
        .map_err(AppError::Db)?;
    Ok(affected > 0)
}

/// 列出所有段的元信息(不读取 value,避免大载荷传输)。
pub fn list_meta(conn: &Connection) -> Result<Vec<super::model::ConfigSectionMeta>, AppError> {
    let mut stmt = conn
        .prepare("SELECT section, version, updated_at FROM app_config ORDER BY section")
        .map_err(AppError::Db)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(super::model::ConfigSectionMeta {
                section: r.get(0)?,
                version: r.get::<_, i64>(1)? as u32,
                updated_at: r.get(2)?,
            })
        })
        .map_err(AppError::Db)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(AppError::Db)?);
    }
    Ok(out)
}

/// 版本守卫:启动时读取所有段版本,若某段高于当前支持版本则返回错误。
///
/// 与 `db::SCHEMA_VERSION` 守卫语义一致:旧版本应用读新版本配置只是丢字段,
/// 但为防止降级误写新版本配置,这里仍然拒绝启动(对齐 DB 守卫风格)。
pub fn check_versions(conn: &Connection) -> Result<(), AppError> {
    let mut stmt = conn
        .prepare("SELECT section, version FROM app_config WHERE version > ?")
        .map_err(AppError::Db)?;
    let offenders: Vec<(String, u32)> = stmt
        .query_map(params![super::CONFIG_VERSION as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
        })
        .map_err(AppError::Db)?
        .filter_map(|r| r.ok())
        .collect();
    if offenders.is_empty() {
        return Ok(());
    }
    let detail = offenders
        .iter()
        .map(|(s, v)| format!("{} v{}", s, v))
        .collect::<Vec<_>>()
        .join(", ");
    Err(AppError::business(
        crate::error::ErrCode::ConfigVersion,
        format!(
            "以下配置段版本高于应用支持 v{}:{}",
            super::CONFIG_VERSION,
            detail
        ),
    ))
}

/// 应用 app_config 表 DDL(幂等)
pub fn apply_ddl(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
            CREATE TABLE IF NOT EXISTS app_config (
                section    TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                version    INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );
        "#,
    )
    .context("应用 app_config DDL 失败")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        apply_ddl(&conn).unwrap();
        conn
    }

    #[test]
    fn upsert_and_load_round_trip() {
        let conn = setup();
        let value = json!({"apiKey": "sk-test", "speaker": "vivi"});
        upsert(&conn, ConfigSection::Tts, &value, 1).unwrap();

        let record = load(&conn, ConfigSection::Tts).unwrap().expect("应能加载");
        assert_eq!(record.section, "tts");
        assert_eq!(record.version, 1);
        assert_eq!(record.value["apiKey"], "sk-test");
        assert!(record.updated_at.starts_with("20"));
    }

    #[test]
    fn load_returns_none_when_absent() {
        let conn = setup();
        let record = load(&conn, ConfigSection::Ai).unwrap();
        assert!(record.is_none(), "未持久化的段应返回 None");
    }

    #[test]
    fn upsert_overwrites_existing() {
        let conn = setup();
        let v1 = json!({"apiKey": "sk-1"});
        let v2 = json!({"apiKey": "sk-2"});
        upsert(&conn, ConfigSection::Tts, &v1, 1).unwrap();
        upsert(&conn, ConfigSection::Tts, &v2, 1).unwrap();

        let record = load(&conn, ConfigSection::Tts).unwrap().unwrap();
        assert_eq!(record.value["apiKey"], "sk-2");
    }

    #[test]
    fn delete_removes_section() {
        let conn = setup();
        upsert(&conn, ConfigSection::Ai, &json!({"x": 1}), 1).unwrap();
        assert!(delete(&conn, ConfigSection::Ai).unwrap());
        assert!(load(&conn, ConfigSection::Ai).unwrap().is_none());
        // 二次删除返回 false
        assert!(!delete(&conn, ConfigSection::Ai).unwrap());
    }

    #[test]
    fn list_meta_returns_all_sections() {
        let conn = setup();
        upsert(&conn, ConfigSection::Ai, &json!({}), 1).unwrap();
        upsert(&conn, ConfigSection::Tts, &json!({}), 1).unwrap();
        let metas = list_meta(&conn).unwrap();
        assert_eq!(metas.len(), 2);
    }

    #[test]
    fn check_versions_passes_when_at_or_below_current() {
        let conn = setup();
        upsert(&conn, ConfigSection::Ai, &json!({}), 1).unwrap();
        upsert(&conn, ConfigSection::Tts, &json!({}), 0).unwrap(); // 0 = 旧版
        check_versions(&conn).unwrap();
    }

    #[test]
    fn check_versions_rejects_high_version() {
        let conn = setup();
        upsert(
            &conn,
            ConfigSection::Ai,
            &json!({}),
            super::super::CONFIG_VERSION + 1,
        )
        .unwrap();
        let err = check_versions(&conn);
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(msg.contains("E_CONFIG_VERSION"), "msg = {}", msg);
    }
}
