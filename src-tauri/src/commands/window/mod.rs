//! 多窗口管理、调试控制台、数据库校验
//!
//! 提供世界观资料库、版本历史、章节总结、AI 工具箱、调试控制台独立窗口的打开与关闭功能。

pub mod debug;
pub mod manager;
pub mod validate;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// 日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

/// 前端批量上报的日志条目（不含 timestamp，由后端填充）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryInput {
    pub level: String,
    pub message: String,
    pub file: Option<String>,
    pub file_name: Option<String>,
    pub line: Option<u32>,
}

/// 全局日志缓冲区（最近 1000 条）
static LOG_BUFFER: OnceLock<Mutex<Vec<LogEntry>>> = OnceLock::new();

pub fn log_buffer() -> &'static Mutex<Vec<LogEntry>> {
    LOG_BUFFER.get_or_init(|| Mutex::new(Vec::with_capacity(1000)))
}

/// SQL 日志开关：仅在调试窗口打开时广播事件，避免高频 IPC 开销
static SQL_LOG_ENABLED: AtomicBool = AtomicBool::new(false);

/// 启用 SQL 日志广播（调试窗口打开时调用）
///
/// v1.9：同时启用 telemetry 广播,让 4 套通道(包括 SQL)统一推 `telemetry-event`。
pub fn enable_sql_log() {
    SQL_LOG_ENABLED.store(true, Ordering::Release);
    crate::observability::bus::enable_broadcast();
}

/// 禁用 SQL 日志广播（调试窗口关闭时调用）
pub fn disable_sql_log() {
    SQL_LOG_ENABLED.store(false, Ordering::Release);
    crate::observability::bus::disable_broadcast();
}

/// 简单 URL 编码（百分号编码非 ASCII 和保留字符）
pub fn urlencoding(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char)
            }
            _ => result.push_str(&format!("%{:02X}", b)),
        }
    }
    result
}

/// 向调试面板发送 SQL 操作日志（仅在开关开启时广播）
///
/// v1.9：改为 `observability::bus::emit_sql` 的 thin wrapper,签名兼容,
/// 159 处调用点零改动。bus 内部统一缓冲 + 广播(同时推 `telemetry-event`
/// 与旧 `debug-log` 别名),让前端旧组件继续工作。
pub fn emit_sql_log(
    app: &tauri::AppHandle,
    operation: &str,
    table: &str,
    detail: &str,
    file: &str,
    line: u32,
) {
    if !SQL_LOG_ENABLED.load(Ordering::Acquire) {
        return;
    }
    crate::observability::bus::emit_sql(Some(app), operation, table, detail, file, line);
}
