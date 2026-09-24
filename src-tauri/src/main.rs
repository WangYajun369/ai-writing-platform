//! TimeWrite（智写时光）应用入口 — rustc 启动点
//!
//! 跨平台桌面端小说写作软件，基于 Tauri v2。
//! 实际逻辑在 `lib.rs` 的 `run()` 中。

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 程序唯一入口：直接委托库 crate 的 `run()`（构建并启动 Tauri 应用）。
///
/// 应用级初始化、数据库迁移、插件注册与错误处理均在 `lib.rs` 内完成，
/// 此处刻意保持零逻辑，便于将来切换入口形态（如移动端 `mobile_entry_point`）。
fn main() {
    time_write_lib::run()
}
