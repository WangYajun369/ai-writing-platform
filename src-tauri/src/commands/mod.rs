//! IPC 命令模块导出
//!
//! 将各子模块的 Tauri 命令统一导出，供 lib.rs 注册。

pub mod book;
pub mod volume;
pub mod chapter;
pub mod snapshot;
pub mod world_card;
pub mod diary;
pub mod schedule;
pub mod vocab;
pub mod vocab_dict;
pub mod tts;
pub mod ai;
pub mod io;
pub mod image;
pub mod window;
pub mod agent;
pub mod system_check;
// ── 任务卡模块 ──
pub mod project;
pub mod task;
pub mod tag;
pub mod task_meta;
pub mod migrate;
pub mod reminder;
pub mod subtask;
pub mod template;
pub mod attachment;
pub mod activity;
