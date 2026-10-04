//! Telemetry IPC 命令层
//!
//! 调试控制台通过这些命令查询 / 清理事件、控制广播开关。
//! 与原 `commands/window/debug.rs` 的 `get_debug_logs` / `clear_debug_logs`
//! 互补:旧 API 返回内存缓冲的 `LogEntry`,新 API 返回 `TelemetryEvent`
//! 并支持按 kind 过滤与持久化查询。

use tauri::{AppHandle, State};

use crate::db::AppDb;
use crate::error::AppError;
use crate::observability::bus;
use crate::observability::event::{TelemetryEvent, TelemetryKind};
use crate::observability::persist;

/// 列出事件:优先持久化表(历史回放),fallback 到内存缓冲(即时事件)
///
/// - `kind`:可选类别过滤
/// - `limit`:最多返回条数(默认 200)
/// - `fromBuffer`:true 时跳过持久化表(用于调试窗口启动加载)
#[tauri::command]
pub async fn list_telemetry_events(
    db: State<'_, AppDb>,
    kind: Option<String>,
    limit: Option<i64>,
    from_buffer: Option<bool>,
) -> Result<Vec<TelemetryEvent>, AppError> {
    let limit = limit.unwrap_or(200);
    if from_buffer.unwrap_or(false) {
        let kind = kind.as_deref().and_then(|s| s.parse().ok());
        return Ok(bus::list_buffered(kind));
    }
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    let kind = kind
        .as_deref()
        .map(|s| s.parse::<TelemetryKind>())
        .transpose()
        .map_err(|_| AppError::Validation("无效的 telemetry kind".into()))?;
    persist::list_recent(&conn, kind, limit)
}

/// 清空事件(可选 kind 过滤)
///
/// - `kind`:可选类别过滤;不传则清空全部
/// - `clearBuffer`:是否同时清空内存缓冲(默认 true)
#[tauri::command]
pub async fn clear_telemetry_events(
    db: State<'_, AppDb>,
    kind: Option<String>,
    clear_buffer: Option<bool>,
) -> Result<usize, AppError> {
    let kind = kind
        .as_deref()
        .map(|s| s.parse::<TelemetryKind>())
        .transpose()
        .map_err(|_| AppError::Validation("无效的 telemetry kind".into()))?;
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    let affected = persist::clear(&conn, kind)?;
    if clear_buffer.unwrap_or(true) {
        bus::clear_buffer();
    }
    Ok(affected)
}

/// 启用事件总线广播(调试窗口打开时调用)
#[tauri::command]
pub async fn enable_telemetry_broadcast() -> Result<bool, AppError> {
    bus::enable_broadcast();
    Ok(bus::is_broadcast_enabled())
}

/// 禁用事件总线广播(调试窗口关闭时调用)
#[tauri::command]
pub async fn disable_telemetry_broadcast() -> Result<bool, AppError> {
    bus::disable_broadcast();
    Ok(bus::is_broadcast_enabled())
}

/// 查询广播状态
#[tauri::command]
pub async fn is_telemetry_broadcasting() -> Result<bool, AppError> {
    Ok(bus::is_broadcast_enabled())
}

/// 显式上报前端错误事件(供前端 catch 路径调用)
#[tauri::command]
pub async fn report_error_event(
    app: AppHandle,
    code: String,
    message: String,
    source: Option<String>,
) -> Result<(), AppError> {
    bus::emit_error(Some(&app), &code, &message, source.as_deref());
    Ok(())
}
