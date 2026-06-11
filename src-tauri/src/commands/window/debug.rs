//! 调试控制台
//!
//! 接收前端日志、提供历史日志查询和清理。
//! 打开调试窗口时启用 SQL 日志广播，关闭时禁用，避免高频 IPC 开销。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use chrono::Local;
use super::{LogEntry, LogEntryInput, log_buffer, enable_sql_log, disable_sql_log};
use crate::error::AppError;

/// 接收前端批量日志并广播到调试窗口
#[tauri::command]
pub async fn log_message(app: AppHandle, entries: Vec<LogEntryInput>) -> Result<(), AppError> {
    let mut buffer = log_buffer().lock().map_err(|e| AppError::Business(format!("获取日志缓冲锁失败: {}", e)))?;

    for input in entries {
        let entry = LogEntry {
            timestamp: Local::now().format("%H:%M:%S").to_string(),
            level: input.level,
            message: input.message,
            file: input.file,
            file_name: input.file_name,
            line: input.line,
        };

        if buffer.len() >= 1000 {
            buffer.remove(0);
        }
        buffer.push(entry.clone());

        let _ = app.emit("debug-log", &entry);
    }

    Ok(())
}

/// 打开调试控制台独立窗口，同时启用 SQL 日志广播
#[tauri::command]
pub async fn open_debug_window(app: AppHandle) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window("debug") {
        w.close().map_err(|e| AppError::Business(format!("关闭旧调试窗口失败: {}", e)))?;
    }

    #[cfg(debug_assertions)]
    let url_str = "http://localhost:1420?debugwin=1".to_string();
    #[cfg(not(debug_assertions))]
    let url_str = "tauri://localhost?debugwin=1".to_string();

    let url = tauri::Url::parse(&url_str).map_err(|e| AppError::Business(format!("URL 解析失败: {}", e)))?;

    let w = WebviewWindowBuilder::new(&app, "debug", WebviewUrl::External(url))
        .title("调试控制台")
        .inner_size(820.0, 560.0)
        .min_inner_size(420.0, 320.0)
        .always_on_top(true)
        .build()
        .map_err(|e| AppError::Business(format!("创建窗口失败: {}", e)))?;

    // 启用 SQL 日志广播
    enable_sql_log();

    if let Some(main) = app.get_webview_window("main") {
        w.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                disable_sql_log();
                let _ = main.emit("debug-window-closed", ());
            }
        });
    }

    Ok(())
}

/// 关闭调试控制台独立窗口，禁用 SQL 日志广播
#[tauri::command]
pub async fn close_debug_window(app: AppHandle) -> Result<(), AppError> {
    disable_sql_log();
    if let Some(w) = app.get_webview_window("debug") {
        w.close().map_err(|e| AppError::Business(format!("关闭调试窗口失败: {}", e)))?;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("debug-window-closed", ());
    }
    Ok(())
}

/// 获取所有已缓存的日志
#[tauri::command]
pub async fn get_debug_logs() -> Result<Vec<LogEntry>, AppError> {
    let buffer = log_buffer();
    let logs = buffer.lock().map_err(|e| AppError::Business(format!("获取日志缓冲锁失败: {}", e)))?;
    Ok(logs.clone())
}

/// 清空所有缓存的日志
#[tauri::command]
pub async fn clear_debug_logs() -> Result<(), AppError> {
    let buffer = log_buffer();
    let mut logs = buffer.lock().map_err(|e| AppError::Business(format!("获取日志缓冲锁失败: {}", e)))?;
    logs.clear();
    Ok(())
}
