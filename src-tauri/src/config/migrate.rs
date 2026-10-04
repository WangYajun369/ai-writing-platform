//! ConfigVersion 迁移框架 + 旧 localStorage 一次性迁移
//!
//! ## ConfigVersion 框架(类似 `db::SCHEMA_VERSION`)
//!
//! - 启动时 [`check_versions`](super::store::check_versions) 守卫:某段高于当前
//!   版本则拒绝启动(`E_CONFIG_VERSION`)
//! - 当前全部段配置均以 [`CONFIG_VERSION`](super::CONFIG_VERSION) 写入,无历史版本
//! - 后续字段演进时递增 `CONFIG_VERSION`,并在 [`run_versioned_migrations`] 追加分支
//!
//! ## 旧 localStorage 迁移
//!
//! 前端启动时检测旧 localStorage key,如存在则调用 `migrate_from_local_storage`
//! IPC 命令一次性导入到 `app_config` 表,迁移成功后由前端清理 localStorage key。
//!
//! 迁移逻辑分散在 [`migrate_ai`] / [`migrate_tts`] / [`migrate_preferences`]
//! / [`migrate_ai_tool_categories`] 四个函数,各自处理旧格式到新格式的转换
//! (例如 AI 配置的 `apiKey` → `bigmodelApiKey` + `deepseekApiKey`)。

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::model::ConfigSection;
use super::store;
use crate::error::{AppError, ErrCode};

/// 版本化迁移入口:处理无法用默认值 + JSON merge 表达的结构演进。
///
/// 当前全部段配置均以 v1 写入,无历史版本,故无分发项;后续演进时按
/// `from_version < N` 逐级追加(每级只负责把自己那版的变更做完),
/// 并在 `CONFIG_VERSION` 上递增。
#[allow(dead_code)] // 预留：后续配置版本演进时启用
pub fn run_versioned_migrations(_conn: &Connection, _from_version: u32) -> Result<(), AppError> {
    Ok(())
}

/// 旧 localStorage 数据迁移结果(逐段返回)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationResult {
    pub ai: SectionMigration,
    pub tts: SectionMigration,
    pub preferences: SectionMigration,
    pub ai_tool_categories: SectionMigration,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionMigration {
    /// 是否检测到旧数据并实际写入
    pub migrated: bool,
    /// 迁移跳过原因(无旧数据 / 已迁移 / 解析失败)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 一次性迁移入口:把前端传入的 4 段旧 localStorage 数据写入 `app_config` 表。
///
/// 前端传入的 `payload` 形如:
/// ```json
/// {
///   "ai": { /* 旧 AiConfig JSON */ },
///   "tts": { /* 旧 TtsConfig JSON */ },
///   "preferences": { /* 旧 UserPreferences JSON */ },
///   "aiToolCategories": [ /* 旧 AiToolCategory[] */ ]
/// }
/// ```
///
/// 幂等性:
/// - 若某段在 `app_config` 表已存在(version >= 1),跳过迁移(返回 `migrated=false`)
/// - 若某段在 payload 中不存在,跳过
/// - 若某段载荷解析失败,记录 `reason`,不阻塞其他段迁移
pub fn migrate_from_local_storage(
    conn: &Connection,
    payload: &Value,
) -> Result<LegacyMigrationResult, AppError> {
    let obj = payload
        .as_object()
        .ok_or_else(|| AppError::business(ErrCode::ConfigParse, "迁移载荷必须是 JSON 对象"))?;

    let ai = migrate_ai(conn, obj)?;
    let tts = migrate_tts(conn, obj)?;
    let preferences = migrate_preferences(conn, obj)?;
    let ai_tool_categories = migrate_ai_tool_categories(conn, obj)?;

    Ok(LegacyMigrationResult {
        ai,
        tts,
        preferences,
        ai_tool_categories,
    })
}

/// 迁移 AI 配置段
///
/// 兼容旧格式:
/// - `apiKey` 单字段 → `bigmodelApiKey` + `deepseekApiKey`
/// - 顶层字段(provider/endpoint/...) → 嵌套到 `chat` 子对象
/// - 旧 RAG 字段(apiKey) → `bigmodelApiKey`
fn migrate_ai(
    conn: &Connection,
    payload: &Map<String, Value>,
) -> Result<SectionMigration, AppError> {
    // 已迁移则跳过
    if let Ok(Some(_)) = store::load(conn, ConfigSection::Ai) {
        return Ok(SectionMigration {
            migrated: false,
            reason: Some("ai section already migrated".into()),
        });
    }
    let raw = match payload.get("ai") {
        Some(v) if !v.is_null() => v.clone(),
        _ => {
            return Ok(SectionMigration {
                migrated: false,
                reason: Some("no ai data".into()),
            })
        }
    };
    // 兼容旧格式:无 chat/rag 子对象 → 视为 v0 顶层字段
    let merged = if raw.get("chat").is_none() || raw.get("rag").is_none() {
        migrate_legacy_ai_config(&raw)
    } else {
        // 新格式:校验 chat.apiKey → 拆为 bigmodelApiKey + deepseekApiKey
        let mut value = raw.clone();
        if let Some(chat) = value.get("chat").cloned() {
            if let Some(chat_obj) = chat.as_object() {
                if chat_obj.get("apiKey").is_some()
                    && chat_obj.get("bigmodelApiKey").is_none()
                    && chat_obj.get("deepseekApiKey").is_none()
                {
                    let api_key = chat_obj.get("apiKey").cloned().unwrap_or(Value::Null);
                    let mut new_chat = chat_obj.clone();
                    new_chat.remove("apiKey");
                    new_chat.insert("bigmodelApiKey".into(), api_key.clone());
                    new_chat.insert("deepseekApiKey".into(), api_key);
                    if let Some(v) = value.as_object_mut() {
                        v.insert("chat".into(), Value::Object(new_chat));
                    }
                }
            }
        }
        if let Some(rag) = value.get("rag").cloned() {
            if let Some(rag_obj) = rag.as_object() {
                if rag_obj.get("apiKey").is_some() || rag_obj.get("provider").is_none() {
                    let new_rag = migrate_legacy_rag_config(rag_obj);
                    if let Some(v) = value.as_object_mut() {
                        v.insert("rag".into(), Value::Object(new_rag));
                    }
                }
            }
        }
        value
    };
    store::upsert(conn, ConfigSection::Ai, &merged, super::CONFIG_VERSION)?;
    Ok(SectionMigration {
        migrated: true,
        reason: None,
    })
}

/// v0 旧 AI 配置 → v1 新格式(对齐前端 `migrateLegacyAiConfig`)
fn migrate_legacy_ai_config(raw: &Value) -> Value {
    let old_provider = raw
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("bigmodel");
    let old_api_key = raw.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let endpoint = raw
        .get("endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("https://open.bigmodel.cn/api/paas/v4");
    let model = raw
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("glm-5.1");
    let temperature = raw
        .get("temperature")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.7);
    let max_tokens = raw
        .get("maxTokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(131072);
    let embedding_model = raw
        .get("embeddingModel")
        .and_then(|v| v.as_str())
        .unwrap_or("embedding-3");

    serde_json::json!({
        "chat": {
            "provider": old_provider,
            "endpoint": endpoint,
            "model": model,
            "temperature": temperature,
            "maxTokens": max_tokens,
            "bigmodelApiKey": old_api_key,
            "deepseekApiKey": old_api_key,
            "thinkingEnabled": false,
            "contextWindowSize": 10,
        },
        "rag": {
            "provider": "bigmodel",
            "endpoint": endpoint,
            "embeddingModel": embedding_model,
            "bigmodelApiKey": old_api_key,
        }
    })
}

/// v0 旧 RAG 子对象 → v1 新格式(对齐前端 `migrateRagConfig`)
fn migrate_legacy_rag_config(rag: &Map<String, Value>) -> Map<String, Value> {
    let old_key = rag.get("apiKey").cloned().unwrap_or(Value::Null);
    let provider_str = rag
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("bigmodel");
    let provider = if provider_str == "deepseek" {
        "bigmodel"
    } else {
        provider_str
    };
    let endpoint = rag
        .get("endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("https://open.bigmodel.cn/api/paas/v4");
    let embedding_model = rag
        .get("embeddingModel")
        .and_then(|v| v.as_str())
        .unwrap_or("embedding-3");

    let mut out = Map::new();
    out.insert("provider".into(), Value::String(provider.into()));
    out.insert("endpoint".into(), Value::String(endpoint.into()));
    out.insert(
        "embeddingModel".into(),
        Value::String(embedding_model.into()),
    );
    out.insert("bigmodelApiKey".into(), old_key);
    out
}

/// 迁移 TTS 配置段(无旧格式,直接写入)
fn migrate_tts(
    conn: &Connection,
    payload: &Map<String, Value>,
) -> Result<SectionMigration, AppError> {
    if let Ok(Some(_)) = store::load(conn, ConfigSection::Tts) {
        return Ok(SectionMigration {
            migrated: false,
            reason: Some("tts section already migrated".into()),
        });
    }
    let raw = match payload.get("tts") {
        Some(v) if !v.is_null() => v.clone(),
        _ => {
            return Ok(SectionMigration {
                migrated: false,
                reason: Some("no tts data".into()),
            })
        }
    };
    // 兼容旧版曾用 appId/accessKey 双字段,这里仅保留 apiKey / speaker
    let mut value = raw.clone();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("appId");
        obj.remove("accessKey");
        if obj.get("speaker").is_none() {
            obj.insert(
                "speaker".into(),
                Value::String(super::defaults::DEFAULT_TTS_SPEAKER.into()),
            );
        }
        if obj.get("apiKey").is_none() {
            obj.insert("apiKey".into(), Value::String(String::new()));
        }
    }
    store::upsert(conn, ConfigSection::Tts, &value, super::CONFIG_VERSION)?;
    Ok(SectionMigration {
        migrated: true,
        reason: None,
    })
}

/// 迁移偏好段(无旧格式,直接写入)
fn migrate_preferences(
    conn: &Connection,
    payload: &Map<String, Value>,
) -> Result<SectionMigration, AppError> {
    if let Ok(Some(_)) = store::load(conn, ConfigSection::Preferences) {
        return Ok(SectionMigration {
            migrated: false,
            reason: Some("preferences section already migrated".into()),
        });
    }
    let raw = match payload.get("preferences") {
        Some(v) if !v.is_null() => v.clone(),
        _ => {
            return Ok(SectionMigration {
                migrated: false,
                reason: Some("no preferences data".into()),
            })
        }
    };
    if !raw.is_object() {
        return Ok(SectionMigration {
            migrated: false,
            reason: Some("preferences payload not an object".into()),
        });
    }
    store::upsert(
        conn,
        ConfigSection::Preferences,
        &raw,
        super::CONFIG_VERSION,
    )?;
    Ok(SectionMigration {
        migrated: true,
        reason: None,
    })
}

/// 迁移 AI 工具箱分类段(数组载荷,可能为旧 prompts 数组)
fn migrate_ai_tool_categories(
    conn: &Connection,
    payload: &Map<String, Value>,
) -> Result<SectionMigration, AppError> {
    if let Ok(Some(_)) = store::load(conn, ConfigSection::AiToolCategories) {
        return Ok(SectionMigration {
            migrated: false,
            reason: Some("ai_tool_categories section already migrated".into()),
        });
    }
    let raw = match payload.get("aiToolCategories") {
        Some(v) if !v.is_null() => v.clone(),
        _ => {
            return Ok(SectionMigration {
                migrated: false,
                reason: Some("no ai_tool_categories data".into()),
            })
        }
    };
    // 旧版曾用单层 prompts 数组(`time-write-ai-tool-prompts` key)
    // 前端启动时已检测并迁移到 `aiToolCategories`,后端收到时已是分类数组
    if !raw.is_array() {
        return Ok(SectionMigration {
            migrated: false,
            reason: Some("ai_tool_categories payload not an array".into()),
        });
    }
    store::upsert(
        conn,
        ConfigSection::AiToolCategories,
        &raw,
        super::CONFIG_VERSION,
    )?;
    Ok(SectionMigration {
        migrated: true,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::apply_ddl(&conn).unwrap();
        conn
    }

    #[test]
    fn migrate_v0_ai_config_to_v1() {
        let v0 = json!({
            "provider": "bigmodel",
            "apiKey": "sk-legacy",
            "endpoint": "https://open.bigmodel.cn/api/paas/v4",
            "model": "glm-5.1",
            "temperature": 0.6,
            "maxTokens": 4096,
            "embeddingModel": "embedding-3"
        });
        let migrated = migrate_legacy_ai_config(&v0);
        assert_eq!(migrated["chat"]["provider"], "bigmodel");
        assert_eq!(migrated["chat"]["bigmodelApiKey"], "sk-legacy");
        assert_eq!(migrated["chat"]["deepseekApiKey"], "sk-legacy");
        assert_eq!(migrated["chat"]["contextWindowSize"], 10);
        assert_eq!(migrated["rag"]["provider"], "bigmodel");
        assert_eq!(migrated["rag"]["bigmodelApiKey"], "sk-legacy");
    }

    #[test]
    fn migrate_v0_rag_with_legacy_apikey() {
        let mut rag = Map::new();
        rag.insert("apiKey".into(), json!("sk-old"));
        rag.insert("endpoint".into(), json!("https://example.com"));
        let migrated = migrate_legacy_rag_config(&rag);
        assert!(migrated.get("apiKey").is_none(), "旧 apiKey 应被移除");
        assert_eq!(migrated.get("bigmodelApiKey").unwrap(), &json!("sk-old"));
        assert_eq!(migrated.get("provider").unwrap(), &json!("bigmodel"));
    }

    #[test]
    fn migrate_from_local_storage_full_payload() {
        let conn = setup();
        let payload = json!({
            "ai": {
                "chat": {
                    "provider": "deepseek",
                    "endpoint": "https://api.deepseek.com",
                    "model": "deepseek-v4-flash",
                    "temperature": 0.7,
                    "maxTokens": 131072,
                    "apiKey": "sk-test",
                    "thinkingEnabled": true,
                    "contextWindowSize": 10
                },
                "rag": {
                    "provider": "bigmodel",
                    "endpoint": "https://open.bigmodel.cn/api/paas/v4",
                    "embeddingModel": "embedding-3",
                    "apiKey": "sk-rag"
                }
            },
            "tts": {
                "apiKey": "tts-key",
                "speaker": "zh_female_vv_uranus_bigtts",
                "appId": "should-be-removed"
            },
            "preferences": {
                "theme": "dark",
                "fontSize": 18
            },
            "aiToolCategories": [
                {"id": "c1", "name": "Test", "color": "#fff", "tools": []}
            ]
        });
        let result = migrate_from_local_storage(&conn, &payload).unwrap();
        assert!(result.ai.migrated);
        assert!(result.tts.migrated);
        assert!(result.preferences.migrated);
        assert!(result.ai_tool_categories.migrated);

        // AI 段:apiKey 应被拆为 bigmodelApiKey + deepseekApiKey
        let ai = store::load(&conn, ConfigSection::Ai).unwrap().unwrap();
        assert_eq!(ai.value["chat"]["bigmodelApiKey"], "sk-test");
        assert_eq!(ai.value["chat"]["deepseekApiKey"], "sk-test");
        assert!(ai.value["chat"].get("apiKey").is_none());
        // RAG:apiKey → bigmodelApiKey
        assert_eq!(ai.value["rag"]["bigmodelApiKey"], "sk-rag");
        assert!(ai.value["rag"].get("apiKey").is_none());

        // TTS:appId 应被移除
        let tts = store::load(&conn, ConfigSection::Tts).unwrap().unwrap();
        assert!(tts.value.get("appId").is_none());
        assert_eq!(tts.value["apiKey"], "tts-key");

        // Preferences:原样写入
        let prefs = store::load(&conn, ConfigSection::Preferences)
            .unwrap()
            .unwrap();
        assert_eq!(prefs.value["theme"], "dark");
        assert_eq!(prefs.value["fontSize"], 18);

        // AI 工具箱分类:原样写入
        let cats = store::load(&conn, ConfigSection::AiToolCategories)
            .unwrap()
            .unwrap();
        assert_eq!(cats.value[0]["name"], "Test");
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = setup();
        let payload = json!({
            "ai": {
                "chat": {"provider": "deepseek", "apiKey": "sk-1"},
                "rag": {"provider": "bigmodel"}
            },
            "tts": {"apiKey": "k"}
        });
        let r1 = migrate_from_local_storage(&conn, &payload).unwrap();
        assert!(r1.ai.migrated);
        assert!(r1.tts.migrated);
        assert!(!r1.preferences.migrated);
        assert!(!r1.ai_tool_categories.migrated);

        // 二次迁移:已迁移的段跳过
        let r2 = migrate_from_local_storage(&conn, &payload).unwrap();
        assert!(!r2.ai.migrated);
        assert!(!r2.tts.migrated);
    }

    #[test]
    fn migrate_v0_top_level_ai_config() {
        let conn = setup();
        let payload = json!({
            "ai": {
                "provider": "bigmodel",
                "apiKey": "sk-v0",
                "endpoint": "https://open.bigmodel.cn/api/paas/v4",
                "model": "glm-5.1",
                "temperature": 0.6,
                "maxTokens": 4096,
                "embeddingModel": "embedding-3"
            }
        });
        let result = migrate_from_local_storage(&conn, &payload).unwrap();
        assert!(result.ai.migrated);

        let ai = store::load(&conn, ConfigSection::Ai).unwrap().unwrap();
        assert_eq!(ai.value["chat"]["provider"], "bigmodel");
        assert_eq!(ai.value["chat"]["bigmodelApiKey"], "sk-v0");
        assert_eq!(ai.value["chat"]["deepseekApiKey"], "sk-v0");
        assert_eq!(ai.value["chat"]["thinkingEnabled"], false);
        assert_eq!(ai.value["rag"]["embeddingModel"], "embedding-3");
    }

    #[test]
    fn migrate_tts_fills_speaker_default_when_missing() {
        let conn = setup();
        let payload = json!({"tts": {"apiKey": "k"}});
        let result = migrate_from_local_storage(&conn, &payload).unwrap();
        assert!(result.tts.migrated);
        let tts = store::load(&conn, ConfigSection::Tts).unwrap().unwrap();
        assert_eq!(
            tts.value["speaker"],
            super::super::defaults::DEFAULT_TTS_SPEAKER
        );
    }

    #[test]
    fn migrate_rejects_non_object_payload() {
        let conn = setup();
        let payload = json!([]);
        let err = migrate_from_local_storage(&conn, &payload);
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("E_CONFIG_PARSE"));
    }
}
