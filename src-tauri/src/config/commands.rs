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
/// 敏感段(ai/tts)若解密失败:回退默认值并走可观测错误通道(不阻断读取)。
#[tauri::command]
pub async fn get_config(
    db: State<'_, AppDb>,
    app: tauri::AppHandle,
    section: String,
) -> Result<Value, AppError> {
    let section: ConfigSection = section.parse().map_err(|_| {
        AppError::business(ErrCode::ConfigSection, format!("未知配置段: {}", section))
    })?;
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;

    // 1. 默认值
    let mut value = defaults::default_value(section);

    // 2. 持久化值覆盖(浅合并:对象逐字段覆盖,数组整体替换)
    //    解密/解析失败(多为密钥不匹配或密文损坏):回退默认值 + 记录可观测错误,不阻断读取
    match store::load(&conn, section) {
        Ok(Some(record)) => {
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
        Ok(None) => {}
        Err(e) => {
            crate::observability::bus::emit_error(
                Some(&app),
                &e.code(),
                &e.to_string(),
                Some("config.get"),
            );
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
///
/// 写入前会剔除"由 env 注入的密钥"(见 [`strip_env_injected_secrets`])，
/// 避免读接口注入的临时密钥被前端整段回写后落盘。
#[tauri::command]
pub async fn set_config(
    db: State<'_, AppDb>,
    app: tauri::AppHandle,
    section: String,
    value: Value,
) -> Result<(), AppError> {
    let section: ConfigSection = section.parse().map_err(|_| {
        AppError::business(ErrCode::ConfigSection, format!("未知配置段: {}", section))
    })?;
    // 结构校验：拒绝明显损坏的载荷（如把对象段写成标量、分类段缺 id/tools），
    // 避免坏数据入库后直到前端渲染才暴露。
    section.validate_value(&value).map_err(|detail| {
        AppError::business(
            ErrCode::ConfigSection,
            format!("配置结构校验失败（{} 段）：{}", section.as_str(), detail),
        )
    })?;
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    // 读取既有记录：用于① 还原 env 注入值、② 字段级 patch 合并。
    // 读取失败（多为敏感段解密失败）时无法做字段级合并，记录可观测错误后按 patch
    // 整体写入，不阻断用户保存。
    let existing = match store::load(&conn, section) {
        Ok(record) => record.map(|r| r.value),
        Err(e) => {
            crate::observability::bus::emit_error(
                Some(&app),
                &e.code(),
                &e.to_string(),
                Some("config.set"),
            );
            None
        }
    };
    let mut value = value;
    strip_env_injected_secrets(section, existing.as_ref(), &mut value);
    // 字段级 patch：入参只含变更的顶层键，与既有持久化记录浅合并后落库。
    // 这样多窗口并发写 / 局部修改不会把其它未变更字段截断（历史缺陷：前端整段
    // 回写覆盖，导致后端已持久化但前端未持有的字段被重置）。
    let merged = merge_patch(existing.as_ref(), &value);
    store::upsert(&conn, section, &merged, super::CONFIG_VERSION)?;
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

/// env 覆盖目标表:(环境变量名, JSON 路径)
///
/// 读路径(`apply_env_overrides`)与写路径(`strip_env_injected_secrets`)共用同一张表,
/// 保证"被注入的字段"与"回写时要保护的字段"永不漂移。
fn env_override_targets(section: ConfigSection) -> Vec<(&'static str, &'static [&'static str])> {
    match section {
        ConfigSection::Ai => vec![
            ("TIMEWRITE_AI_CHAT_API_KEY", &["chat", "bigmodelApiKey"]),
            ("TIMEWRITE_AI_CHAT_API_KEY", &["chat", "deepseekApiKey"]),
            ("TIMEWRITE_AI_RAG_API_KEY", &["rag", "bigmodelApiKey"]),
        ],
        ConfigSection::Tts => vec![("TIMEWRITE_TTS_API_KEY", &["apiKey"])],
        _ => Vec::new(),
    }
}

/// 把路径段拼成 JSON Pointer(`["chat","apiKey"]` → `/chat/apiKey`)
fn join_pointer(path: &[&str]) -> String {
    let mut pointer = String::new();
    for seg in path {
        pointer.push('/');
        pointer.push_str(seg);
    }
    pointer
}

/// 把前端传入的「字段级 patch」合并到既有持久化值上。
///
/// 语义（与前端 store「只发变更的顶层键」的写入约定配套）：
/// - 双方都是对象：**顶层浅合并**，patch 中的键覆盖既有值；
///   patch 中的显式 `null` 视为「删除该顶层键」
/// - 其余情况（数组 / 标量 / 无既有记录）：patch 整体替换既有值
///
/// 注意子对象（如 ai 的 chat / rag）按顶层键**整体替换**，不做两级递归合并；
/// 因此「清除子对象内某可选字段」由前端省略该键实现（JSON 序列化会丢弃
/// 值为 undefined 的键），而非依赖嵌套 null。
///
/// 抽成纯函数便于单测（`set_config` 依赖 `State<'_, AppDb>`，无法在单测中构造）。
pub(crate) fn merge_patch(existing: Option<&Value>, patch: &Value) -> Value {
    match (existing, patch) {
        (Some(Value::Object(base)), Value::Object(incoming)) => {
            let mut merged = base.clone();
            for (k, v) in incoming {
                if v.is_null() {
                    merged.remove(k);
                } else {
                    merged.insert(k.clone(), v.clone());
                }
            }
            Value::Object(merged)
        }
        _ => patch.clone(),
    }
}

/// 按路径删除子键;父级不存在时返回 false
fn remove_at_path(root: &mut Value, path: &[&str]) -> bool {
    let Some((last, parents)) = path.split_last() else {
        return false;
    };
    let mut cursor = root;
    for seg in parents {
        match cursor.get_mut(*seg) {
            Some(next) => cursor = next,
            None => return false,
        }
    }
    cursor
        .as_object_mut()
        .map(|obj| obj.remove(*last).is_some())
        .unwrap_or(false)
}

/// 写入前剔除"由 env 注入的密钥",避免 CI 临时密钥被前端整段回写后落盘。
///
/// 判定规则:仅当载荷中的值与该 env 变量注入的值**完全相同**时(说明它是
/// "读接口注入 → 前端整段回写"的产物),才还原为库中原值(无则删除该键);
/// 用户手动输入的不同值视为有意为之,予以保留。
fn strip_env_injected_secrets(section: ConfigSection, existing: Option<&Value>, value: &mut Value) {
    for (var, path) in env_override_targets(section) {
        let Ok(env_value) = std::env::var(var) else {
            continue;
        };
        if env_value.is_empty() {
            continue;
        }
        let pointer = join_pointer(path);
        let injected =
            value.pointer(&pointer).and_then(|v| v.as_str()) == Some(env_value.as_str());
        if !injected {
            continue;
        }
        match existing.and_then(|e| e.pointer(&pointer)) {
            Some(previous) => {
                // 还原用户原本持久化的密钥
                if let Some(slot) = value.pointer_mut(&pointer) {
                    *slot = previous.clone();
                }
            }
            None => {
                // 库中本就没有该字段:直接移除,避免注入值落盘
                remove_at_path(value, path);
            }
        }
    }
}

/// 应用 env 覆盖(仅 AI / TTS 段)
///
/// 支持的环境变量:
/// - `TIMEWRITE_AI_CHAT_API_KEY`:AI 对话 API Key(同时写入 bigmodelApiKey + deepseekApiKey)
/// - `TIMEWRITE_AI_RAG_API_KEY`:RAG API Key(写入 bigmodelApiKey)
/// - `TIMEWRITE_TTS_API_KEY`:TTS API Key
///
/// env 优先级最高:存在则覆盖持久化值与默认值。用于自动化测试 / CI 场景。
/// 注意:这些注入值只用于读取(运行时生效),不会随前端回写落盘 —— 见
/// [`strip_env_injected_secrets`]。
fn apply_env_overrides(section: ConfigSection, value: &mut Value) {
    for (var, path) in env_override_targets(section) {
        let Ok(api_key) = std::env::var(var) else {
            continue;
        };
        if api_key.is_empty() {
            continue;
        }
        if let Some(slot) = value.pointer_mut(&join_pointer(path)) {
            *slot = Value::String(api_key);
        }
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

    #[test]
    fn strip_env_injected_secrets_restores_persisted_key() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("TIMEWRITE_AI_CHAT_API_KEY", "sk-env");
        std::env::remove_var("TIMEWRITE_AI_RAG_API_KEY");
        // 库中原本存着用户自己的 key
        let existing = json!({"chat": {"bigmodelApiKey": "sk-user", "deepseekApiKey": "sk-user"}});
        // 前端读到的是 env 注入值,整段回写时把它带了回来
        let mut value = json!({
            "chat": {"temperature": 0.7, "bigmodelApiKey": "sk-env", "deepseekApiKey": "sk-env"}
        });
        strip_env_injected_secrets(ConfigSection::Ai, Some(&existing), &mut value);
        assert_eq!(value["chat"]["bigmodelApiKey"], "sk-user", "应还原用户原密钥");
        assert_eq!(value["chat"]["deepseekApiKey"], "sk-user");
        assert_eq!(value["chat"]["temperature"], 0.7, "其它字段不受影响");
        std::env::remove_var("TIMEWRITE_AI_CHAT_API_KEY");
    }

    #[test]
    fn strip_env_injected_secrets_removes_key_when_nothing_persisted() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("TIMEWRITE_TTS_API_KEY", "tts-env");
        let mut value = json!({"apiKey": "tts-env", "speaker": "vivi"});
        strip_env_injected_secrets(ConfigSection::Tts, None, &mut value);
        assert!(
            value.get("apiKey").is_none(),
            "库中无原值时注入密钥不应落盘"
        );
        assert_eq!(value["speaker"], "vivi");
        std::env::remove_var("TIMEWRITE_TTS_API_KEY");
    }

    #[test]
    fn strip_env_injected_secrets_keeps_user_edited_key() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("TIMEWRITE_TTS_API_KEY", "tts-env");
        // 用户手动输入了不同的 key → 属有意为之,保留
        let mut value = json!({"apiKey": "sk-typed-by-user", "speaker": "vivi"});
        strip_env_injected_secrets(ConfigSection::Tts, None, &mut value);
        assert_eq!(value["apiKey"], "sk-typed-by-user");
        std::env::remove_var("TIMEWRITE_TTS_API_KEY");
    }

    #[test]
    fn strip_env_injected_secrets_noop_for_preferences() {
        let _guard = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("TIMEWRITE_AI_CHAT_API_KEY", "sk-env");
        let mut value = json!({"theme": "dark"});
        let original = value.clone();
        strip_env_injected_secrets(ConfigSection::Preferences, None, &mut value);
        assert_eq!(value, original, "preferences 段不受 env 保护逻辑影响");
        std::env::remove_var("TIMEWRITE_AI_CHAT_API_KEY");
    }

    #[test]
    fn merge_patch_shallow_merges_object_keys() {
        let existing = json!({"theme": "dark", "fontSize": 16, "gridSize": "large"});
        let patch = json!({"theme": "light"});
        let merged = merge_patch(Some(&existing), &patch);
        assert_eq!(merged["theme"], "light", "patch 覆盖既有键");
        assert_eq!(merged["fontSize"], 16, "未变更键保留");
        assert_eq!(merged["gridSize"], "large");
    }

    #[test]
    fn merge_patch_null_deletes_top_level_key() {
        let existing = json!({"apiKey": "sk-old", "speaker": "vivi"});
        let patch = json!({"apiKey": null});
        let merged = merge_patch(Some(&existing), &patch);
        assert!(
            merged.get("apiKey").is_none(),
            "顶层显式 null 应删除该键，而非留下 null"
        );
        assert_eq!(merged["speaker"], "vivi", "同层其它键保留");
    }

    #[test]
    fn merge_patch_sub_object_replaced_wholesale() {
        // chat 子对象作为顶层键整体替换（前端发送的是完整 chat 对象）；
        // 被子对象内省略的键随整体替换一并消失，即「清除 API Key」的实现方式
        let existing =
            json!({"chat": {"model": "old", "temperature": 0.3, "deepseekApiKey": "sk-old"}, "rag": {"provider": "bigmodel"}});
        let patch = json!({"chat": {"model": "new"}});
        let merged = merge_patch(Some(&existing), &patch);
        assert_eq!(merged["chat"]["model"], "new");
        assert!(
            merged["chat"].get("temperature").is_none(),
            "子对象整体替换，不做两级递归合并"
        );
        assert!(
            merged["chat"].get("deepseekApiKey").is_none(),
            "子对象中被省略的可选键（如已清除的 API Key）应一并删除"
        );
        assert_eq!(merged["rag"]["provider"], "bigmodel", "未触及的顶层键保留");
    }

    #[test]
    fn merge_patch_array_replaces_wholesale() {
        let existing = json!([{"id": "a"}, {"id": "b"}]);
        let patch = json!([{"id": "c"}]);
        let merged = merge_patch(Some(&existing), &patch);
        assert_eq!(merged, patch, "数组段整体替换");
    }

    #[test]
    fn merge_patch_no_existing_keeps_patch() {
        let patch = json!({"theme": "light"});
        let merged = merge_patch(None, &patch);
        assert_eq!(merged, patch);
    }

    #[test]
    fn merge_patch_type_mismatch_replaces() {
        // 既有为对象、入参为标量 → 直接替换，避免把标量塞进对象
        let existing = json!({"a": 1});
        let patch = json!("scalar");
        assert_eq!(merge_patch(Some(&existing), &patch), patch);
    }
}
