//! 应用配置类型定义(单一真源)
//!
//! 各段配置类型与前端 `src/types/index.ts` 保持结构对齐(字段名 camelCase 序列化),
//! 便于前后端透明序列化。所有类型派生 `Serialize + Deserialize`,默认值由
//! [`super::defaults`] 提供。

use serde::{Deserialize, Serialize};

/// 配置段标识(对应 `app_config.section` 列)
///
/// 序列化为小写字符串(`ai` / `tts` / `preferences` / `ai_tool_categories`),
/// 前端按段名调用 IPC 命令。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigSection {
    /// AI 配置(对话/RAG/服务商)
    Ai,
    /// TTS 配置(豆包语音合成)
    Tts,
    /// 用户偏好(主题/字体/网格等)
    Preferences,
    /// AI 工具箱分类(用户自定义提示词)
    AiToolCategories,
}

impl ConfigSection {
    /// 返回稳定的小写字符串(供 SQL 持久化与 IPC 传输)
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ai => "ai",
            Self::Tts => "tts",
            Self::Preferences => "preferences",
            Self::AiToolCategories => "ai_tool_categories",
        }
    }
}

impl std::fmt::Display for ConfigSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ConfigSection {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ai" => Ok(Self::Ai),
            "tts" => Ok(Self::Tts),
            "preferences" => Ok(Self::Preferences),
            "ai_tool_categories" => Ok(Self::AiToolCategories),
            _ => Err(()),
        }
    }
}

/// AI 对话配置(对齐前端 `AiChatConfig`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatConfig {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bigmodel_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepseek_api_key: Option<String>,
    pub thinking_enabled: bool,
    pub context_window_size: i64,
}

/// RAG / Embedding 配置(对齐前端 `RagConfig`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagConfig {
    pub provider: String,
    pub endpoint: String,
    pub embedding_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bigmodel_api_key: Option<String>,
}

/// AI 总配置(对齐前端 `AiConfig`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub chat: AiChatConfig,
    pub rag: RagConfig,
}

/// TTS 配置(对齐前端 `TtsConfig`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsConfig {
    pub api_key: String,
    pub speaker: String,
}

/// 用户偏好(对齐前端 `PreferenceValues`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub eye_care_mode: String,
    pub font_family: String,
    pub font_size: i64,
    pub grid_size: String,
    pub editor_width: String,
    pub library_view_mode: String,
    pub library_sort_by: String,
}

/// AI 工具箱提示词(对齐前端 `AiToolPrompt`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolPrompt {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
}

/// AI 工具箱分类(对齐前端 `AiToolCategory`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolCategory {
    pub id: String,
    pub name: String,
    pub color: String,
    pub tools: Vec<AiToolPrompt>,
}

/// 单段配置的持久化记录(对应 `app_config` 表)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigRecord {
    pub section: String,
    /// JSON 序列化后的配置载荷
    pub value: serde_json::Value,
    /// 该段配置的版本(用于 ConfigVersion 框架)
    pub version: u32,
    /// 上次更新时间(RFC 3339)
    pub updated_at: String,
}

/// 配置元信息(供调试与诊断)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMeta {
    /// 当前应用支持的配置版本
    pub current_version: u32,
    /// 各段当前持久化版本(未持久化则为 0)
    pub sections: Vec<ConfigSectionMeta>,
}

/// 单段配置的元信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSectionMeta {
    pub section: String,
    pub version: u32,
    pub updated_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_serializes_to_snake_case() {
        assert_eq!(serde_json::to_string(&ConfigSection::Ai).unwrap(), "\"ai\"");
        assert_eq!(
            serde_json::to_string(&ConfigSection::Tts).unwrap(),
            "\"tts\""
        );
        assert_eq!(
            serde_json::to_string(&ConfigSection::Preferences).unwrap(),
            "\"preferences\""
        );
        assert_eq!(
            serde_json::to_string(&ConfigSection::AiToolCategories).unwrap(),
            "\"ai_tool_categories\""
        );
    }

    #[test]
    fn section_from_str_round_trips() {
        for s in [
            ConfigSection::Ai,
            ConfigSection::Tts,
            ConfigSection::Preferences,
            ConfigSection::AiToolCategories,
        ] {
            let str = s.as_str();
            let back: ConfigSection = str.parse().unwrap();
            assert_eq!(back, s);
        }
        assert!("unknown".parse::<ConfigSection>().is_err());
    }

    #[test]
    fn ai_config_serializes_with_camel_case() {
        let cfg = AiConfig {
            chat: AiChatConfig {
                provider: "deepseek".into(),
                endpoint: "https://api.deepseek.com".into(),
                model: "deepseek-v4-flash".into(),
                temperature: 0.7,
                max_tokens: 131072,
                bigmodel_api_key: None,
                deepseek_api_key: Some("sk-test".into()),
                thinking_enabled: true,
                context_window_size: 10,
            },
            rag: RagConfig {
                provider: "bigmodel".into(),
                endpoint: "https://open.bigmodel.cn/api/paas/v4".into(),
                embedding_model: "embedding-3".into(),
                bigmodel_api_key: Some("sk-test".into()),
            },
        };
        let v = serde_json::to_value(&cfg).unwrap();
        // camelCase 字段名
        assert_eq!(v["chat"]["maxTokens"], 131072);
        assert_eq!(v["chat"]["thinkingEnabled"], true);
        assert_eq!(v["chat"]["contextWindowSize"], 10);
        assert_eq!(v["chat"]["deepseekApiKey"], "sk-test");
        assert!(v["chat"]["bigmodelApiKey"].is_null()); // None 跳过
        assert_eq!(v["rag"]["embeddingModel"], "embedding-3");
    }
}
