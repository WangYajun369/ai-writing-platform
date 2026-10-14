//! app_config 表持久化(纯 SQL,不依赖 Tauri State/AppHandle)
//!
//! 与 `app_config` 表(section-key-value,带 ConfigVersion)互操作:
//! - [`upsert`] — 写入或更新一段配置(以 section 为主键)
//! - [`load`] — 读取一段配置(返回完整 `ConfigRecord`,含 version / updated_at)
//! - [`delete`] — 删除一段配置(供调试 / 重置场景使用)
//! - [`list_meta`] — 列出所有段的元信息(供 `get_config_meta` IPC 命令使用)
//!
//! ## 敏感段加密落库(v1.9 安全加固)
//!
//! `ai` / `tts` 两段含 API Key,落库前用 AES-256-GCM 加密(`enc1:` + base64 前缀),
//! 解密密钥复用备份密钥体系(`commands/io/crypto.rs`,由启动时 `init_backup_key`
//! 初始化)。`preferences` / `ai_tool_categories` 不含密钥,保持明文。
//! 读取时按前缀自动识别:带 `enc1:` 解密,无前缀按明文(兼容历史数据,下次写回加密)。
//! 加解密失败返回 `E_CONFIG_CRYPTO`,由命令层回退默认值并走可观测错误通道。
//!
//! 三层加载入口在 [`super::commands`] 层完成:默认值 → 持久化值 → env 覆盖。

use anyhow::Context;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rusqlite::{params, Connection};
use serde_json::Value;

use super::model::{ConfigRecord, ConfigSection};
use crate::commands::io::crypto;
use crate::error::{AppError, ErrCode};

/// 敏感配置段密文前缀（v1 格式：`enc1:` + base64(STANDARD, nonce||ciphertext||tag)）。
const ENC_PREFIX: &str = "enc1:";

/// 需要加密落库的配置段（含 API Key 等敏感字段）。
///
/// 仅 `ai` / `tts` 加密；`preferences` / `ai_tool_categories` 不含密钥，保持明文
/// 以便调试控制台直接回放与人工排查。
fn is_encrypted_section(section: ConfigSection) -> bool {
    matches!(section, ConfigSection::Ai | ConfigSection::Tts)
}

/// 把配置载荷编码为待落库字符串：敏感段加密（`enc1:` 前缀），其余明文 JSON。
fn encode_value(section: ConfigSection, value: &Value) -> Result<String, AppError> {
    let json = serde_json::to_string(value).map_err(AppError::Serde)?;
    if !is_encrypted_section(section) {
        return Ok(json);
    }
    let cipher = crypto::encrypt_bytes(json.as_bytes())
        .map_err(|e| AppError::business(ErrCode::ConfigCrypto, format!("配置加密失败：{}", e)))?;
    Ok(format!("{}{}", ENC_PREFIX, STANDARD.encode(cipher)))
}

/// 把落库字符串解码为配置载荷。
///
/// - 敏感段且带 `enc1:` 前缀 → base64 解码 + 解密（失败返回 `E_CONFIG_CRYPTO`）
/// - 敏感段但无前缀（历史明文数据）→ 按明文解析（隐式迁移：下次写回即加密）
/// - 非敏感段 → 明文解析
///
/// 明文路径保留旧的宽容语义（非法 JSON 归一为 null），避免单个坏段阻断读取。
fn decode_value(section: ConfigSection, raw: &str) -> Result<Value, AppError> {
    if is_encrypted_section(section) {
        if let Some(b64) = raw.strip_prefix(ENC_PREFIX) {
            let cipher = STANDARD.decode(b64.trim()).map_err(|e| {
                AppError::business(
                    ErrCode::ConfigCrypto,
                    format!("密文 base64 解码失败：{}", e),
                )
            })?;
            let plain = crypto::decrypt_bytes(&cipher).map_err(|e| {
                AppError::business(ErrCode::ConfigCrypto, format!("配置解密失败：{}", e))
            })?;
            let text = String::from_utf8(plain).map_err(|e| {
                AppError::business(
                    ErrCode::ConfigCrypto,
                    format!("解密结果不是合法 UTF-8：{}", e),
                )
            })?;
            return serde_json::from_str(&text).map_err(|e| {
                AppError::business(
                    ErrCode::ConfigCrypto,
                    format!("解密后配置 JSON 解析失败：{}", e),
                )
            });
        }
    }
    Ok(serde_json::from_str(raw).unwrap_or(Value::Null))
}

/// 写入或更新一段配置(以 section 为主键,version 由调用方传入)
///
/// 调用方应在 `set_config` 命令层传入当前 [`super::CONFIG_VERSION`]。
pub fn upsert(
    conn: &Connection,
    section: ConfigSection,
    value: &Value,
    version: u32,
) -> Result<(), AppError> {
    let value_str = encode_value(section, value)?;
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

    let raw = stmt
        .query_row(params![section.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map(Some)
        .or_else(|e| {
            if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
                Ok(None)
            } else {
                Err(AppError::Db(e))
            }
        })?;

    match raw {
        None => Ok(None),
        Some((section_str, value_str, version, updated_at)) => {
            let value = decode_value(section, &value_str)?;
            Ok(Some(ConfigRecord {
                section: section_str,
                value,
                version: version as u32,
                updated_at,
            }))
        }
    }
}

/// 读取全部配置段(含 value,供备份导出使用)。
///
/// 与 [`list_meta`] 的区别:这里会读出 value(载荷较大),仅备份导出场景调用。
pub fn load_all(conn: &Connection) -> Result<Vec<ConfigRecord>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT section, value, version, updated_at
             FROM app_config ORDER BY section",
        )
        .map_err(AppError::Db)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(AppError::Db)?;
    let mut out = Vec::new();
    for row in rows {
        let (section_str, value_str, version, updated_at) = row.map_err(AppError::Db)?;
        // 已知段按段规则解码（敏感段解密）；未知段按明文解析，向前兼容新增段
        let value = match section_str.parse::<ConfigSection>() {
            Ok(section) => decode_value(section, &value_str)?,
            Err(_) => serde_json::from_str(&value_str).unwrap_or(Value::Null),
        };
        out.push(ConfigRecord {
            section: section_str,
            value,
            version: version as u32,
            updated_at,
        });
    }
    Ok(out)
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
        // 敏感段（ai/tts）加密落库依赖全局密钥，测试无 AppHandle，
        // 故先安装固定测试密钥（幂等）。
        crate::commands::io::crypto::install_test_key();
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

    /// 读取某段的原始落库字符串（绕过解密，用于断言密文形态）
    fn raw_value(conn: &Connection, section: ConfigSection) -> String {
        conn.query_row(
            "SELECT value FROM app_config WHERE section = ?",
            params![section.as_str()],
            |r| r.get::<_, String>(0),
        )
        .unwrap()
    }

    #[test]
    fn sensitive_section_persists_as_ciphertext() {
        let conn = setup();
        upsert(
            &conn,
            ConfigSection::Tts,
            &json!({"apiKey": "sk-secret", "speaker": "vivi"}),
            1,
        )
        .unwrap();

        let raw = raw_value(&conn, ConfigSection::Tts);
        assert!(raw.starts_with(ENC_PREFIX), "敏感段应以 enc1: 前缀落库");
        assert!(
            !raw.contains("sk-secret"),
            "明文 API Key 不应出现在落库字符串中"
        );
        // 解密读回后应还原为原始结构
        let record = load(&conn, ConfigSection::Tts).unwrap().unwrap();
        assert_eq!(record.value["apiKey"], "sk-secret");
        assert_eq!(record.value["speaker"], "vivi");
    }

    #[test]
    fn non_sensitive_section_stays_plaintext() {
        let conn = setup();
        upsert(
            &conn,
            ConfigSection::Preferences,
            &json!({"theme": "dark"}),
            1,
        )
        .unwrap();
        let raw = raw_value(&conn, ConfigSection::Preferences);
        assert!(!raw.starts_with(ENC_PREFIX), "非敏感段应保持明文");
        assert!(raw.contains("dark"));
    }

    #[test]
    fn legacy_plaintext_sensitive_section_is_readable() {
        // 模拟历史数据：敏感段直接以明文 JSON 落库（无 enc1: 前缀）
        let conn = setup();
        conn.execute(
            "INSERT INTO app_config (section, value, version, updated_at) VALUES (?, ?, ?, ?)",
            params![
                ConfigSection::Tts.as_str(),
                r#"{"apiKey":"legacy-plain","speaker":"vivi"}"#,
                1,
                "2026-01-01T00:00:00+08:00"
            ],
        )
        .unwrap();

        // 读路径应兼容明文
        let record = load(&conn, ConfigSection::Tts).unwrap().unwrap();
        assert_eq!(record.value["apiKey"], "legacy-plain");

        // 写回一次即隐式迁移为密文
        upsert(&conn, ConfigSection::Tts, &record.value, 1).unwrap();
        assert!(raw_value(&conn, ConfigSection::Tts).starts_with(ENC_PREFIX));
    }

    #[test]
    fn corrupt_ciphertext_returns_config_crypto_error() {
        let conn = setup();
        conn.execute(
            "INSERT INTO app_config (section, value, version, updated_at) VALUES (?, ?, ?, ?)",
            params![
                ConfigSection::Ai.as_str(),
                "enc1:not-valid-base64!!",
                1,
                "2026-01-01T00:00:00+08:00"
            ],
        )
        .unwrap();

        let err = load(&conn, ConfigSection::Ai).unwrap_err();
        assert!(
            err.to_string().contains("E_CONFIG_CRYPTO"),
            "解密失败应返回 E_CONFIG_CRYPTO，实际: {}",
            err
        );
    }

    #[test]
    fn load_all_decrypts_known_sections_and_keeps_unknown_plaintext() {
        let conn = setup();
        upsert(&conn, ConfigSection::Tts, &json!({"apiKey": "sk-1"}), 1).unwrap();
        upsert(
            &conn,
            ConfigSection::Preferences,
            &json!({"theme": "dark"}),
            1,
        )
        .unwrap();
        // 未知段（向前兼容场景）：明文落库
        conn.execute(
            "INSERT INTO app_config (section, value, version, updated_at) VALUES (?, ?, ?, ?)",
            params![
                "future_section",
                r#"{"a":1}"#,
                1,
                "2026-01-01T00:00:00+08:00"
            ],
        )
        .unwrap();

        let all = load_all(&conn).unwrap();
        let tts = all.iter().find(|r| r.section == "tts").unwrap();
        assert_eq!(tts.value["apiKey"], "sk-1", "已知敏感段应解密读回");
        let future = all.iter().find(|r| r.section == "future_section").unwrap();
        assert_eq!(future.value["a"], 1, "未知段按明文解析");
    }
}
