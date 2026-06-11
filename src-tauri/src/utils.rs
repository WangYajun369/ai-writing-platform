//! 公共工具模块
//!
//! 提供跨命令模块共享的时间戳、HTML 剥离、HTTP 客户端工厂、字数聚合等工具函数。

use std::sync::OnceLock;
use chrono::Utc;
use crate::error::AppError;

// ---- 时间戳 ----

/// 获取当前 UTC 时间的 RFC 3339 字符串表示
pub fn now() -> String {
    Utc::now().to_rfc3339()
}

// ---- HTML 处理 ----

/// 缓存 HTML 标签剥离正则，避免高频反复编译
static HTML_REGEX: OnceLock<regex_lite::Regex> = OnceLock::new();

/// 简单 HTML 标签剥离（基于 regex_lite，正则已缓存）
pub fn strip_html(html: &str) -> String {
    let re = HTML_REGEX.get_or_init(|| {
        regex_lite::Regex::new(r"<[^>]*>").expect("strip_html regex")
    });
    re.replace_all(html, "").to_string()
}

/// 截取文本片段（前 N 个可见字符）
pub fn snippet(text: &str, max_chars: usize) -> String {
    let cleaned: String = text.chars().filter(|&c| c != '\n' && c != '\r').collect();
    if cleaned.chars().count() <= max_chars {
        cleaned
    } else {
        cleaned.chars().take(max_chars).chain(['…']).collect()
    }
}

// ---- HTTP 客户端 ----

/// 全局复用普通 HTTP 客户端（连接池、keep-alive、TLS 会话复用）
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 全局复用 SSE 流式客户端（禁用压缩 + HTTP/1.1 + TCP keepalive）
static SSE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 获取或初始化标准 HTTP 客户端（用于 Embedding / 连接测试等普通 API 调用）
pub fn get_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("构建全局 HTTP 客户端失败")
    })
}

/// 获取或初始化 SSE 流式客户端（用于 AI 流式对话/总结）
pub fn get_sse_client() -> &'static reqwest::Client {
    SSE_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .http1_only()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .tcp_keepalive(std::time::Duration::from_secs(120))
            .build()
            .expect("构建全局 SSE 客户端失败")
    })
}

// ---- FTS5 全文搜索 ----

/// 对 FTS5 MATCH 查询做安全转义（双引号包裹以支持特殊字符）
pub fn escape_fts5_query(query: &str) -> String {
    // 移除 FTS5 保留字符，双引号包裹做精确短语匹配
    let cleaned: String = query
        .chars()
        .filter(|c| !matches!(c, '"' | '*' | '(' | ')' | '^'))
        .collect();
    if cleaned.is_empty() {
        String::new()
    } else {
        format!("\"{}\"", cleaned)
    }
}

/// 降级：当 FTS5 查询为空时使用 LIKE
pub fn like_pattern(query: &str, max_chars: usize) -> String {
    format!("%{}%", query.chars().take(max_chars).collect::<String>())
}

// ---- 输入校验 ----

/// 字段最大长度常量
pub const MAX_TITLE_LEN: usize = 200;
pub const MAX_AUTHOR_LEN: usize = 100;
pub const MAX_DESCRIPTION_LEN: usize = 5000;
pub const MAX_TAG_LEN: usize = 50;
pub const MAX_TAGS_COUNT: usize = 20;
pub const MAX_CHAPTER_CONTENT_LEN: usize = 500_000;

/// 验证字符串字段长度，超长则返回错误
pub fn validate_len(field_name: &str, value: &str, max_len: usize) -> Result<(), AppError> {
    let count = value.chars().count();
    if count > max_len {
        Err(AppError::Validation(format!(
            "{}长度超过上限（{} > {}），请缩短后重试",
            field_name, count, max_len
        )))
    } else {
        Ok(())
    }
}
