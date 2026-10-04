//! 应用配置 IPC 命令层
//!
//! 前端通过这些命令统一读写 4 段配置(AI / TTS / Preferences / AiToolCategories):
//!
//! - [`get_config`] — 读取某段配置(默认值 + 持久化值合并 + env 覆盖)
//! - [`set_config`] — 写入某段配置(以 [`CONFIG_VERSION`](super::CONFIG_VERSION) 持久化)
//! - [`reset_config`] — 重置某段配置为默认值
//! - [`get_config_meta`] — 返回版本信息(供调试与诊断)
//! - [`migrate_legacy_config`] — 一次性迁移旧 localStorage 数据
//!
//! 设计要点:
//!
//! - 三层加载入口在此完成:默认值 → 持久化值 → env 覆盖
//! - 命令层无业务逻辑,只做参数解析与委派
//! - env 覆盖用于自动化/CI 场景(如 `TIMEWRITE_AI_API_KEY` 注入测试密钥)

use serde_json::Value;
use tauri::State;

use crate::db::AppDb;
use crate::error::{AppError, ErrCode};

use super::defaults;
use super::migrate;
use super::model::{ConfigMeta, ConfigSection};
use super::store;

/// 读取某段配置(三层加载:默认值 → 持久化值 → env 覆盖)
///
/// - `section`:配置段标识(`ai` / `tts` / `preferences` / `ai_tool_categories`)
///
/// 返回 JSON Value:默认值与持久化值浅合并(持久化值优先),最后应用 env 覆盖。
#[tauri::command]
pub async fn get_config(db: State<'_, AppDb>, section: String) -> Result<Value, AppError> {
    let section: ConfigSection = section.parse().map_err(|_| {
        AppError::business(ErrCode::ConfigSection, format!("未知配置段: {}", section))
    })?;
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;

    // 1. 默认值
    let mut value = defaults::default_value(section);

    // 2. 持久化值覆盖(浅合并:对象逐字段覆盖,数组整体替换)
    if let Ok(Some(record)) = store::load(&conn, section) {
        if let (Some(base), Some(over)) = (value.as_object_mut(), record.value.as_object()) {
            for (k, v) in over {
                base.insert(k.clone(), v.clone());
            }
        } else if record.value.is_array() {
            // 数组段(AI 工具箱分类):整体替换默认值
            value = record.value.clone();
        } else {
            // 标量段:直接替换
            value = record.value.clone();
        }
    }

    // 3. env 覆盖(仅 AI / TTS 段;读取 TIMEWRITE_AI_* / TIMEWRITE_TTS_*)
    apply_env_overrides(section, &mut value);

    Ok(value)
}

/// 写入某段配置(以 [`CONFIG_VERSION`](super::CONFIG_VERSION) 持久化)
///
/// - `section`:配置段标识
/// - `value`:JSON 载荷
#[tauri::command]
pub async fn set_config(
    db: State<'_, AppDb>,
    section: String,
    value: Value,
) -> Result<(), AppError> {
    let section: ConfigSection = section.parse().map_err(|_| {
        AppError::business(ErrCode::ConfigSection, format!("未知配置段: {}", section))
    })?;
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    store::upsert(&conn, section, &value, super::CONFIG_VERSION)?;
    Ok(())
}

/// 重置某段配置为默认值(删除持久化记录,前端再读取时 fallback 到默认值)
#[tauri::command]
pub async fn reset_config(db: State<'_, AppDb>, section: String) -> Result<Value, AppError> {
    let section: ConfigSection = section.parse().map_err(|_| {
        AppError::business(ErrCode::ConfigSection, format!("未知配置段: {}", section))
    })?;
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    let _ = store::delete(&conn, section);
    Ok(defaults::default_value(section))
}

/// 返回配置元信息(供调试与诊断)
#[tauri::command]
pub async fn get_config_meta(db: State<'_, AppDb>) -> Result<ConfigMeta, AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    let sections = store::list_meta(&conn)?;
    Ok(ConfigMeta {
        current_version: super::CONFIG_VERSION,
        sections,
    })
}

/// 一次性迁移旧 localStorage 数据到 `app_config` 表
///
/// 前端启动时检测旧 localStorage key(`time-write-ai-config` 等),
/// 若存在则将所有旧数据打包为 JSON 对象传入本命令,后端按段迁移,
/// 迁移成功后由前端清理 localStorage key。
///
/// 幂等:已迁移的段会跳过(返回 `migrated=false`)。
#[tauri::command]
pub async fn migrate_legacy_config(
    db: State<'_, AppDb>,
    payload: Value,
) -> Result<migrate::LegacyMigrationResult, AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    migrate::migrate_from_local_storage(&conn, &payload)
}

/// 应用 env 覆盖(仅 AI / TTS 段)
///
/// 支持的环境变量:
/// - `TIMEWRITE_AI_CHAT_API_KEY`:AI 对话 API Key(同时写入 bigmodelApiKey + deepseekApiKey)
/// - `TIMEWRITE_AI_RAG_API_KEY`:RAG API Key(写入 bigmodelApiKey)
/// - `TIMEWRITE_TTS_API_KEY`:TTS API Key
///
/// env 优先级最高:存在则覆盖持久化值与默认值。用于自动化测试 / CI 场景。
fn apply_env_overrides(section: ConfigSection, value: &mut Value) {
    match section {
        ConfigSection::Ai => {
            if let Ok(api_key) = std::env::var("TIMEWRITE_AI_CHAT_API_KEY") {
                if !api_key.is_empty() {
                    if let Some(chat) = value.get_mut("chat").and_then(|c| c.as_object_mut()) {
                        chat.insert("bigmodelApiKey".into(), Value::String(api_key.clone()));
                        chat.insert("deepseekApiKey".into(), Value::String(api_key));
                    }
                }
            }
            if let Ok(api_key) = std::env::var("TIMEWRITE_AI_RAG_API_KEY") {
                if !api_key.is_empty() {
                    if let Some(rag) = value.get_mut("rag").and_then(|r| r.as_object_mut()) {
                        rag.insert("bigmodelApiKey".into(), Value::String(api_key));
                    }
                }
            }
        }
        ConfigSection::Tts => {
            if let Ok(api_key) = std::env::var("TIMEWRITE_TTS_API_KEY") {
                if !api_key.is_empty() {
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert("apiKey".into(), Value::String(api_key));
                    }
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    // env 测试需要串行执行(共享环境变量),用全局 Mutex 保证隔离
    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn apply_env_overrides_ai_chat_api_key() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("TIMEWRITE_AI_CHAT_API_KEY", "sk-from-env");
        std::env::remove_var("TIMEWRITE_AI_RAG_API_KEY");
        let mut value = json!({
            "chat": {"provider": "deepseek", "bigmodelApiKey": null, "deepseekApiKey": null},
            "rag": {"provider": "bigmodel"}
        });
        apply_env_overrides(ConfigSection::Ai, &mut value);
        assert_eq!(value["chat"]["bigmodelApiKey"], "sk-from-env");
        assert_eq!(value["chat"]["deepseekApiKey"], "sk-from-env");
        std::env::remove_var("TIMEWRITE_AI_CHAT_API_KEY");
    }

    #[test]
    fn apply_env_overrides_tts_api_key() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("TIMEWRITE_TTS_API_KEY", "tts-env");
        let mut value = json!({"apiKey": "", "speaker": "vivi"});
        apply_env_overrides(ConfigSection::Tts, &mut value);
        assert_eq!(value["apiKey"], "tts-env");
        std::env::remove_var("TIMEWRITE_TTS_API_KEY");
    }

    #[test]
    fn apply_env_overrides_noop_when_var_missing() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::remove_var("TIMEWRITE_AI_CHAT_API_KEY");
        std::env::remove_var("TIMEWRITE_AI_RAG_API_KEY");
        std::env::remove_var("TIMEWRITE_TTS_API_KEY");
        let mut value = json!({
            "chat": {"bigmodelApiKey": "sk-original", "deepseekApiKey": "sk-original"},
            "rag": {"bigmodelApiKey": "sk-rag"}
        });
        let original = value.clone();
        apply_env_overrides(ConfigSection::Ai, &mut value);
        assert_eq!(value, original, "缺失 env 时不应修改值");
    }
}
