//! 全局日志宏
//!
//! 统一双写到 stderr（控制台）与前端调试窗口日志缓冲（经 `get_debug_logs` IPC 拉取）。
//!
//! # 背景
//!
//! 此前各模块直接用 `eprintln!`，日志只进控制台，调试窗口完全看不到，
//! 排查 Agent 启动失败、Bridge 端口占用等问题时只能让用户翻控制台输出。
//!
//! # 使用
//!
//! 宏通过 `#[macro_export]` 导出到 crate 根，各模块按需引入：
//!
//! ```ignore
//! use crate::{app_log, app_log_error};
//!
//! app_log!("[Bridge] Server 已启动，监听 {}", addr);
//! app_log_error!("[Bridge] 无法启动: {}", e);
//! ```
//!
//! # 注意
//!
//! 宏体内使用 `std::io::Write::write_fmt` 而非 `eprintln!`，
//! 这样宏定义中不出现 `eprintln!` 字面量，便于安全地对存量调用点做批量替换。
//!
//! 日志缓冲上限 1000 条（超出丢弃最旧的）。因此**流式热路径**（如 AI SSE 逐 chunk
//! 解析）不要使用本宏，否则会瞬间刷满缓冲、冲掉其它模块的日志。

/// 日志双写实现：stderr + 调试窗口缓冲
#[macro_export]
macro_rules! app_log_inner {
    ($level:expr, $($arg:tt)*) => {{
        let msg = format!($($arg)*);
        let _ = std::io::Write::write_fmt(&mut std::io::stderr(), format_args!("{}\n", msg));
        if let Ok(mut buffer) = $crate::commands::window::log_buffer().lock() {
            if buffer.len() >= 1000 {
                buffer.remove(0);
            }
            buffer.push($crate::commands::window::LogEntry {
                timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
                level: $level.to_string(),
                message: msg,
                file: None,
                file_name: None,
                line: None,
            });
        }
    }};
}

/// info 级别日志：控制台 + 调试窗口
#[macro_export]
macro_rules! app_log {
    ($($arg:tt)*) => { $crate::app_log_inner!("info", $($arg)*) };
}

/// error 级别日志：控制台 + 调试窗口
#[macro_export]
macro_rules! app_log_error {
    ($($arg:tt)*) => { $crate::app_log_inner!("error", $($arg)*) };
}

/// 仅输出到控制台，不写入调试窗口缓冲
///
/// 用于高频或噪声日志，典型场景是子进程 stdout/stderr 的原样转发：
/// uvicorn 以 `--log-level debug` 运行时每秒可产生大量日志，
/// 全量写入会占满 1000 条缓冲并把其它模块的日志挤掉。
#[macro_export]
macro_rules! app_log_console {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        let _ = std::io::Write::write_fmt(&mut std::io::stderr(), format_args!("{}\n", msg));
    }};
}
