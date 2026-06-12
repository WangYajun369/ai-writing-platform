//! Python Agent 集成模块
//!
//! 对外暴露：
//! - AgentManager: 进程生命周期管理
//! - execute_skill / cancel_skill: Rust → Python 调用
//! - Bridge Server: Python → Rust 数据回调 HTTP Server

pub mod manager;
pub mod client;
pub mod bridge;

pub use manager::{AgentManager, AgentServerConfig, AgentState};
// client 模块通过 python::client::xxx 直接访问，无需 re-export
