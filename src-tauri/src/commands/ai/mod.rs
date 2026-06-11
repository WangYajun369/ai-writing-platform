//! AI 功能模块
//!
//! 包含：AI 连接测试、RAG 语义检索、Embedding 生成、流式对话、内容总结。

pub mod embedding;
pub mod chat;
pub mod summarize;
pub mod test;

use serde::Serialize;

// ---- 公共类型 ----

/// Embedding 索引状态（用于检测是否需要重新生成）
#[derive(Serialize)]
pub struct EmbeddingStatus {
    #[serde(rename = "totalChapters")]
    pub total_chapters: usize,
    #[serde(rename = "totalWorldCards")]
    pub total_world_cards: usize,
    #[serde(rename = "indexedChapters")]
    pub indexed_chapters: usize,
    #[serde(rename = "indexedWorldCards")]
    pub indexed_world_cards: usize,
    /// 是否有未索引的内容（新增/修改后需重新生成）
    pub stale: bool,
}

#[derive(Serialize)]
pub struct RagResult {
    pub snippet: String,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    pub distance: f64,
}

/// Embedding 生成进度返回给前端
#[derive(Serialize)]
pub struct EmbeddingProgress {
    #[serde(rename = "chaptersEmbedded")]
    pub chapters_embedded: usize,
    #[serde(rename = "worldCardsEmbedded")]
    pub world_cards_embedded: usize,
    #[serde(rename = "totalChapters")]
    pub total_chapters: usize,
    #[serde(rename = "totalWorldCards")]
    pub total_world_cards: usize,
    pub model: String,
}

/// AI 连接测试结果
#[derive(Debug, Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub detail: String,
}

/// 单条消息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Token/字数用量统计
#[derive(Debug, Clone, Serialize)]
pub struct UsageInfo {
    #[serde(rename = "inputTokens")]
    pub input_tokens: u32,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u32,
    #[serde(rename = "inputChars")]
    pub input_chars: usize,
    #[serde(rename = "outputChars")]
    pub output_chars: usize,
}

/// 向前端推送的流式事件负载
#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    pub content: String,
    pub thinking: String,
    pub phase: String,
    pub done: bool,
    pub error: Option<String>,
    pub usage: Option<UsageInfo>,
}

// ---- 对话总结相关类型 ----

/// 对话总结请求参数
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeConversationArgs {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: f64,
    pub max_tokens: Option<u32>,
    pub messages: Vec<ChatMessage>,
    pub previous_summary: Option<String>,
    pub thinking_enabled: Option<bool>,
}

/// 对话总结结果
#[derive(Debug, Clone, Serialize)]
pub struct ConversationSummary {
    pub summary: String,
    pub covered_count: usize,
    pub summary_chars: usize,
    pub thinking: String,
}

// ---- 章节总结相关类型 ----

/// 章节总结请求参数
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeArgs {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: f64,
    pub max_tokens: Option<u32>,
    pub chapter_title: String,
    pub chapter_content: String,
    pub thinking_enabled: Option<bool>,
    pub system_prompt: Option<String>,
}

/// 章节总结结果
#[derive(Debug, Clone, Serialize)]
pub struct ChapterSummary {
    pub summary: String,
    pub original_chars: usize,
    pub summary_chars: usize,
    pub thinking: String,
}

// ---- 工具函数 ----

/// f32 切片序列化为字节 BLOB
pub fn floats_to_bytes(floats: &[f32]) -> Vec<u8> {
    floats.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// 从字节 BLOB 反序列化为 f32 向量
pub fn bytes_to_floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// 余弦相似度（返回 0.0 ~ 1.0）
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let len = a.len().min(b.len());
    let (dot, na, nb) = a[..len].iter().zip(b[..len].iter()).fold(
        (0.0f64, 0.0f64, 0.0f64),
        |(d, x, y), (&ai, &bi)| {
            let af = ai as f64;
            let bf = bi as f64;
            (d + af * bf, x + af * af, y + bf * bf)
        },
    );
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

// strip_html / snippet 已提取至 crate::utils，此处不再重复定义。

/// 截断文本以适应 Embedding API 的 token 限制
///
/// embedding-3 单条最多 3072 tokens，中文约 1.5 token/字，
/// 保守截断到 1800 字符以留有余量。
pub const EMBEDDING_MAX_CHARS: usize = 1800;

pub fn truncate_for_embedding(text: &str) -> String {
    if text.chars().count() <= EMBEDDING_MAX_CHARS {
        text.to_string()
    } else {
        text.chars().take(EMBEDDING_MAX_CHARS).collect()
    }
}
