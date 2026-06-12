//! IPC 命令模块导出
//!
//! 将各子模块的 Tauri 命令统一导出，供 lib.rs 注册。

pub mod book;
pub mod volume;
pub mod chapter;
pub mod snapshot;
pub mod world_card;
pub mod ai;
pub mod io;
pub mod image;
pub mod window;
pub mod agent;
