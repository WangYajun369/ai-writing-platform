//! 公共工具模块
//!
//! 提供跨命令模块共享的时间戳、HTML 剥离、HTTP 客户端工厂、字数聚合等工具函数。

use crate::error::AppError;
use chrono::{Local, Utc};
use std::sync::OnceLock;

// ---- ECDICT 离线词典文件 ----

/// ECDICT 词典文件相对 app_data_dir 的位置
pub const DICT_DIR: &str = "dict";
pub const DICT_FILE: &str = "ecdict.sqlite";

/// ECDICT 变形家族侧车索引库文件名。
///
/// 该库为一次性从 `ecdict.sqlite` 预解析的产物（`word → lemma` 全量映射，
/// 仅收录 `exchange` 含 `0:` 原型的词条），用于把 `dict_family_uncached`
/// 中的 `exchange LIKE '%0:lemma%'` 全表扫描替换为等值查询，彻底消灭全表扫描。
/// 重新导入词典时由 [`rebuild_lemma_index`](crate::service::vocab_relation_service::rebuild_lemma_index) 重建。
pub const DICT_LEMMA_INDEX_FILE: &str = "ecdict-lemma.db";

/// 获取 ECDICT 词典文件完整路径
pub fn dict_db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Business(format!("无法获取应用数据目录: {e}")))?;
    Ok(dir.join(DICT_DIR).join(DICT_FILE))
}

/// 获取 ECDICT 变形家族侧车索引库完整路径（与 [`dict_db_path`] 同目录）
pub fn dict_lemma_index_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Business(format!("无法获取应用数据目录: {e}")))?;
    Ok(dir.join(DICT_DIR).join(DICT_LEMMA_INDEX_FILE))
}

/// 打开 ECDICT 词典库（只读），校验 stardict 表存在；未安装或缺表返回 None。
///
/// 供 `commands::vocab_dict`（查词/导入）与 `service::vocab_relation_service`
/// （变形家族建议）共享，避免词典文件访问逻辑多处复制。
pub fn open_dict_db(app: &tauri::AppHandle) -> Result<Option<rusqlite::Connection>, AppError> {
    let path = dict_db_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let table_ok: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='stardict')",
        [],
        |row| row.get(0),
    )?;
    if !table_ok {
        return Ok(None);
    }
    Ok(Some(conn))
}

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

/// 转义 HTML 特殊字符（& < >），用于把纯文本安全嵌入 HTML，防注入
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 截取文本片段（前 N 个可见字符）
///
/// 先过滤换行/回车使片段保持单行（用于列表卡片场景）；
/// 计数与截取均基于 `chars()`（Unicode 标量），不会切碎中文/emoji 等多字节字符。
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
    // 与 SSE 客户端保持一致：关闭透明解压（服务端 / 中间代理返回的压缩体在解码阶段
    // 失败时，reqwest 只报 "error decoding response body"，难以定位）；固定 HTTP/1.1 +
    // TCP keepalive，规避长响应传输途中被中间设备提前断流（同样表现为该报错）。
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .http1_only()
        .tcp_keepalive(std::time::Duration::from_secs(120));
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
    // 过滤后为空说明原查询全由保留字符构成（如仅输入 "*"），
    // 返回空串表示"无可匹配项"，调用方据此降级为 like_pattern 模糊匹配
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

/// 搜索接口默认返回条数（各 service 统一，避免魔法数字不一致）
pub const SEARCH_DEFAULT_LIMIT: usize = 20;

// ---- 动态 UPDATE 构建（Phase 4 问题 17：抽取重复的动态更新逻辑）----

/// 动态部分更新构建器：按需收集「列 = ?N」子句与参数值，支持 String /
/// i64 / JSON 等不同类型混合，最终统一生成
/// `UPDATE {table} SET ... , updated_at=?M WHERE id=?K` 语句。
///
/// 原 book_service::update_book 与 world_card_service::update_world_card
/// 各自手写了一遍「逐字段 push + format 序号 + 参数收集」逻辑，现收敛到此处。
pub struct DynamicUpdate {
    table: &'static str,
    clauses: Vec<String>,
    values: Vec<Box<dyn rusqlite::types::ToSql>>,
}

impl DynamicUpdate {
    pub fn new(table: &'static str) -> Self {
        Self {
            table,
            clauses: Vec::new(),
            values: Vec::new(),
        }
    }

    /// 追加一个字段（列名需为白名单内且来自代码字面量，禁止外部拼接）
    pub fn push(&mut self, column: &'static str, value: impl rusqlite::types::ToSql + 'static) {
        // 占位符从 ?1 起按追加顺序连续编号，values 的物理顺序与 SQL 参数顺序一致；
        // build() 会继续在同一序号体系末尾追加 updated_at 与 id
        let idx = self.values.len() + 1;
        self.clauses.push(format!("{column}=?{idx}"));
        self.values.push(Box::new(value));
    }

    /// 追加一个 JSON 序列化字段（如 tags）
    pub fn push_json(&mut self, column: &'static str, value: impl serde::Serialize) {
        let json = serde_json::to_string(&value).unwrap_or_else(|_| "[]".to_string());
        self.push(column, json);
    }

    /// 可更新字段数量（供 SQL 审计日志展示，需在 build 前调用）
    pub fn field_count(&self) -> usize {
        self.clauses.len()
    }

    /// 生成完整 SQL 与参数。无任何可更新字段时返回 `None`（调用方应跳过执行）。
    pub fn build(
        self,
        id: &str,
        updated_at: &str,
    ) -> Option<(String, Vec<Box<dyn rusqlite::types::ToSql>>)> {
        if self.clauses.is_empty() {
            return None;
        }
        let mut clauses = self.clauses;
        let mut values = self.values;

        let updated_idx = values.len() + 1;
        clauses.push(format!("updated_at=?{updated_idx}"));
        values.push(Box::new(updated_at.to_string()));

        let id_idx = values.len() + 1;
        let sql = format!(
            "UPDATE {} SET {} WHERE id=?{}",
            self.table,
            clauses.join(", "),
            id_idx
        );
        values.push(Box::new(id.to_string()));
        Some((sql, values))
    }

    /// 生成带附加 WHERE 条件的 SQL（条件须为代码字面量，如软删守卫
    /// `AND deleted_at IS NULL`）。无任何可更新字段时返回 `None`。
    pub fn build_guarded(
        self,
        id: &str,
        updated_at: &str,
        extra_where: &'static str,
    ) -> Option<(String, Vec<Box<dyn rusqlite::types::ToSql>>)> {
        let (sql, values) = self.build(id, updated_at)?;
        Some((format!("{sql} {extra_where}"), values))
    }
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
