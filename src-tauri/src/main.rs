//! TimeWrite（智写时光）应用入口 — rustc 启动点
//!
//! 跨平台桌面端小说写作软件，基于 Tauri v2。
//! 实际逻辑在 `lib.rs` 的 `run()` 中。

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    time_write_lib::run()
}
