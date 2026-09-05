//! 公共工具模块
//!
//! 提供跨命令模块共享的时间戳、HTML 剥离、HTTP 客户端工厂、字数聚合等工具函数。

use crate::error::AppError;
use chrono::{Local, Utc};
use std::sync::OnceLock;

// ---- 时间戳 ----

/// 获取当前 UTC 时间的 RFC 3339 字符串表示
pub fn now() -> String {
    Utc::now().to_rfc3339()
}

/// 获取当前本地时间的紧凑字符串 `YYYY-MM-DDTHH:MM:SS`（无时区后缀）。
///
/// 用于任务卡模块的业务时间字段（截止时间/开始时间/完成时间/提醒时间等）。
/// 本地单机场景下采用本地时间可让"今天到期/已逾期"等判断直接按字符串字典序
/// 比较即可正确（UTC 时间会在跨天边界造成误判）。
pub fn local_now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// 当前本地日期 `YYYY-MM-DD`
pub fn local_today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

// ---- HTML 处理 ----

/// 缓存 HTML 标签剥离正则，避免高频反复编译
static HTML_REGEX: OnceLock<regex_lite::Regex> = OnceLock::new();

/// 简单 HTML 标签剥离（基于 regex_lite，正则已缓存）
pub fn strip_html(html: &str) -> String {
    let re =
        HTML_REGEX.get_or_init(|| regex_lite::Regex::new(r"<[^>]*>").expect("strip_html regex"));
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

/// 从环境变量自动探测 HTTP/HTTPS 代理配置
///
/// 优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy > ALL_PROXY > all_proxy
/// 返回 None 表示未配置代理（直连模式）。
fn detect_proxy() -> Option<reqwest::Proxy> {
    for var in &[
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(val) = std::env::var(var) {
            let val = val.trim().to_string();
            if !val.is_empty() {
                match reqwest::Proxy::all(&val) {
                    Ok(proxy) => {
                        crate::app_log!("[reqwest] 自动检测到代理: {} (来自环境变量 {})", val, var);
                        return Some(proxy);
                    }
                    Err(e) => {
                        crate::app_log_error!("[reqwest] 环境变量 {} 的代理配置无效: {}", var, e);
                    }
                }
            }
        }
    }
    None
}

/// 构建通用 HTTP 客户端基础配置
fn http_client_builder() -> reqwest::ClientBuilder {
    let mut builder =
        reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15));
    if let Some(proxy) = detect_proxy() {
        builder = builder.proxy(proxy);
    }
    builder
}

/// 构建 SSE 客户端基础配置
fn sse_client_builder() -> reqwest::ClientBuilder {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .tcp_keepalive(std::time::Duration::from_secs(120));
    if let Some(proxy) = detect_proxy() {
        builder = builder.proxy(proxy);
    }
    builder
}

/// 获取或初始化标准 HTTP 客户端（用于 Embedding / 连接测试等普通 API 调用）
pub fn get_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        http_client_builder()
            .build()
            .expect("构建全局 HTTP 客户端失败")
    })
}

/// 获取或初始化 SSE 流式客户端（用于 AI 流式对话/总结）
pub fn get_sse_client() -> &'static reqwest::Client {
    SSE_CLIENT.get_or_init(|| {
        sse_client_builder()
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
