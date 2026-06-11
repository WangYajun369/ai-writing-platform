//! 多窗口管理、调试控制台、数据库校验
//!
//! 提供世界观资料库、版本历史、章节总结、AI 工具箱、调试控制台独立窗口的打开与关闭功能。

pub mod manager;
pub mod debug;
pub mod validate;

use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

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
pub fn enable_sql_log() {
    SQL_LOG_ENABLED.store(true, Ordering::Release);
}

/// 禁用 SQL 日志广播（调试窗口关闭时调用）
pub fn disable_sql_log() {
    SQL_LOG_ENABLED.store(false, Ordering::Release);
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
    let _ = app.emit(
        "debug-log",
        &LogEntry {
            timestamp: Local::now().format("%H:%M:%S").to_string(),
            level: "info".to_string(),
            message: format!("[SQL] {} → {} | {}", operation, table, detail),
            file: Some(file.to_string()),
            file_name: Some(file.split('/').last().unwrap_or(file).to_string()),
            line: Some(line),
        },
    );
}