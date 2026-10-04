//! 应用配置默认值(嵌入 Rust 常量,无需外部 toml 文件)
//!
//! 等价于 `default.toml`,但避免引入 toml 解析依赖与外部文件 IO。
//! 前端首次启动或某段配置未持久化时,自动 fallback 到此处的默认值。

use serde_json::{json, Value};

use super::model::{AiConfig, AiToolCategory, Preferences, TtsConfig};

/// 默认 AI 配置(对齐前端 `aiStore.ts` 中的默认值)
pub fn default_ai_config() -> AiConfig {
    AiConfig {
        chat: super::model::AiChatConfig {
            provider: "deepseek".into(),
            endpoint: "https://api.deepseek.com".into(),
            model: "deepseek-v4-flash".into(),
            temperature: 0.7,
            max_tokens: 131072,
            bigmodel_api_key: None,
            deepseek_api_key: None,
            thinking_enabled: true,
            context_window_size: 10,
        },
        rag: super::model::RagConfig {
            provider: "bigmodel".into(),
            endpoint: "https://open.bigmodel.cn/api/paas/v4".into(),
            embedding_model: "embedding-3".into(),
            bigmodel_api_key: None,
        },
    }
}

/// 默认 TTS 音色(豆包 seed-tts,Vivi 2.0 青年女声)
pub const DEFAULT_TTS_SPEAKER: &str = "zh_female_vv_uranus_bigtts";

/// 默认 TTS 配置
pub fn default_tts_config() -> TtsConfig {
    TtsConfig {
        api_key: String::new(),
        speaker: DEFAULT_TTS_SPEAKER.into(),
    }
}

/// 默认偏好(对齐前端 `preferencesStore.ts` 的 `prefsDefaults`)
pub fn default_preferences() -> Preferences {
    Preferences {
        theme: "system".into(),
        eye_care_mode: "off".into(),
        font_family: "yahei".into(),
        font_size: 16,
        grid_size: "medium".into(),
        editor_width: "standard".into(),
        library_view_mode: "grid".into(),
        library_sort_by: "updatedAt".into(),
    }
}

/// 默认 AI 工具箱分类(对齐前端 `appTypes.ts` 的 `DEFAULT_AI_TOOL_CATEGORIES`)
///
/// 返回 `serde_json::Value` 是因为内置分类列表较大,前端类型对齐
/// 通过 JSON 字符串 round-trip 即可,无需把 30+ 项模板手动改写为 Rust 结构。
pub fn default_ai_tool_categories() -> Vec<AiToolCategory> {
    let raw = include_str!("default_ai_tool_categories.json");
    serde_json::from_str(raw).expect("内置 AI 工具箱分类 JSON 必须可解析")
}

/// 按段返回默认值(JSON Value 形式,供 store 层与默认值合并)
pub fn default_value(section: super::model::ConfigSection) -> Value {
    match section {
        super::model::ConfigSection::Ai => json!(default_ai_config()),
        super::model::ConfigSection::Tts => json!(default_tts_config()),
        super::model::ConfigSection::Preferences => json!(default_preferences()),
        super::model::ConfigSection::AiToolCategories => json!(default_ai_tool_categories()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ai_config_round_trips() {
        let cfg = default_ai_config();
        let v = serde_json::to_value(&cfg).unwrap();
        let back: AiConfig = serde_json::from_value(v).unwrap();
        assert_eq!(back.chat.provider, "deepseek");
        assert_eq!(back.chat.context_window_size, 10);
        assert_eq!(back.rag.embedding_model, "embedding-3");
    }

    #[test]
    fn default_tts_config_uses_vivi_speaker() {
        let cfg = default_tts_config();
        assert_eq!(cfg.speaker, DEFAULT_TTS_SPEAKER);
        assert!(cfg.api_key.is_empty());
    }

    #[test]
    fn default_preferences_matches_frontend() {
        let p = default_preferences();
        assert_eq!(p.theme, "system");
        assert_eq!(p.font_size, 16);
        assert_eq!(p.grid_size, "medium");
        assert_eq!(p.library_sort_by, "updatedAt");
    }

    #[test]
    fn default_ai_tool_categories_parse_success() {
        let cats = default_ai_tool_categories();
        assert!(!cats.is_empty(), "内置分类列表非空");
        // 每个分类至少有 1 个工具
        for c in &cats {
            assert!(!c.tools.is_empty(), "分类 {} 工具列表非空", c.name);
        }
    }

    #[test]
    fn default_value_returns_valid_json_per_section() {
        for s in [
            super::super::model::ConfigSection::Ai,
            super::super::model::ConfigSection::Tts,
            super::super::model::ConfigSection::Preferences,
            super::super::model::ConfigSection::AiToolCategories,
        ] {
            let v = default_value(s);
            assert!(
                v.is_object() || v.is_array(),
                "{:?} 默认值应为对象或数组",
                s
            );
        }
    }
}
