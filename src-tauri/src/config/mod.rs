//! 应用配置统一模块(v1.9 架构优化)
//!
//! 把原本散落在前端 localStorage 的 4 套配置整合为单一真源:
//!
//! 1. **AI 配置** — 原 `time-write-ai-config`(对话/RAG,服务商/endpoint/apiKey 等)
//! 2. **TTS 配置** — 原 `time-write-tts-config`(豆包语音合成)
//! 3. **偏好** — 原 `time-write-preferences`(主题/字体/网格/编辑器宽度等)
//! 4. **AI 工具箱分类** — 原 `time-write-ai-tool-categories`(用户自定义提示词)
//!
//! ## 三层加载(无 toml 依赖,默认值嵌入 Rust 常量)
//!
//! 1. **默认层** — [`defaults`] 模块,内置各段默认值(类似 default.toml)
//! 2. **用户层** — `app_config` 表持久化的 JSON 载荷(覆盖默认值)
//! 3. **环境层** — `TIMEWRITE_*` 环境变量(覆盖用户层,用于自动化/CI 场景)
//!
//! ## ConfigVersion 框架
//!
//! - [`CONFIG_VERSION`] — 当前支持的配置版本(类似 `SCHEMA_VERSION`)
//! - 启动时读取每段 `version` 字段,高于当前版本拒绝启动(`E_CONFIG_VERSION`)
//! - 低于当前版本触发注册的迁移函数(见 [`migrate`])
//! - 旧 localStorage 数据通过 `migrate_from_local_storage` 一次性导入,迁移后清理
//!
//! ## 与数据库结构版本化的区别
//!
//! - DB 结构版本(`SCHEMA_VERSION`)走 `PRAGMA user_version`,DDL 幂等对齐
//! - 应用配置版本(`CONFIG_VERSION`)走 `app_config.version` 字段,JSON 载荷按段迁移
//! - 二者独立演进,互不影响
//!
//! ## 调用链
//!
//! 前端 `configClient.ts` → IPC 命令 → [`commands`] → [`store`] → SQLite

pub mod commands;
pub mod defaults;
pub mod migrate;
pub mod model;
pub mod store;

/// 当前应用配置版本(类似 `db::SCHEMA_VERSION`)。
///
/// - 启动时读取每段 `version` 字段
/// - 高于当前版本:拒绝启动(`E_CONFIG_VERSION`)
/// - 低于当前版本:运行 [`migrate::run_versioned_migrations`] 迁移
/// - 新增字段或结构演进时递增此版本,并在 `migrate` 追加迁移函数
pub const CONFIG_VERSION: u32 = 1;
