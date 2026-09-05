//! IPC 命令模块导出
//!
//! 将各子模块的 Tauri 命令统一导出，供 lib.rs 注册。

pub mod agent;
pub mod ai;
pub mod book;
pub mod chapter;
pub mod diary;
pub mod image;
pub mod io;
pub mod schedule;
pub mod snapshot;
pub mod system_check;
pub mod tts;
pub mod vocab;
pub mod vocab_dict;
pub mod volume;
pub mod window;
pub mod world_card;
// ── 任务卡模块 ──
pub mod activity;
pub mod attachment;
pub mod migrate;
pub mod project;
pub mod reminder;
pub mod subtask;
pub mod tag;
pub mod task;
pub mod task_meta;
pub mod template;
