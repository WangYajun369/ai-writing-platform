//! Agent 命令模块
//!
//! Agent Skill 引擎已由 Python 迁移为纯 Rust 实现：
//! - profiles: L1 画像注册表（提示词 / 场景提示 / 工具集 / 预算的单一真相源）
//! - prompts: 动态 Prompt 组装
//! - tools: 章节/世界观等数据库工具（OpenAI function calling 协议）
//! - memory: 记忆体存取（time_write.db memories 表，含旧库迁移）
//! - engine: SSE 流式 ReAct 循环，事件契约与旧 Python Agent 保持一致

pub mod engine;
pub mod memory;
pub mod profiles;
pub mod prompts;
pub mod skills;
pub mod tools;
