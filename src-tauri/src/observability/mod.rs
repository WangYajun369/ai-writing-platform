//! 可观测性体系收敛模块(v1.9 架构优化)
//!
//! 把项目原有的 4 套独立可观测性通道整合为统一 telemetry 模块:
//!
//! 1. **SQL 审计** — 原 `commands/window/mod.rs::emit_sql_log` 在 27 个文件 / 159 处
//!    手写五参样板调用,推 `debug-log` 事件。现改为 `bus::emit_sql` 类型化入口,
//!    `emit_sql_log` 保留为 thin wrapper(签名兼容,159 处调用点零改动)。
//! 2. **Agent trace** — 原 `repository/agent_trace_repo::insert_trace` 写 `agent_traces`
//!    表,前端需 `list_agent_traces` 主动查询。现 `bus::emit_agent_trace` 在写表
//!    的同时并行 emit `telemetry-event` 事件,前端实时可见,无需轮询。
//! 3. **IO lock** — 原 `commands/io/mod.rs::try_acquire_io_lock` 静默 acquire/release,
//!    仅错误时返回 `E_IO_BUSY`。现 `bus::emit_io` 记录状态变化。
//! 4. **错误事件** — 原 `error.rs::AppError` 仅序列化为 `{code, message}` 返回前端。
//!    现关键命令路径失败时调用 `bus::emit_error`,调试控制台可见错误流。
//!
//! ## 单一真源
//!
//! - [`event::TelemetryEvent`] — 统一事件结构
//! - [`event::TelemetryKind`] — 5 类标签(Sql/Agent/Io/Error/System)
//! - [`bus`] — 进程内事件总线 + 类型化入口(`emit_sql` / `emit_agent_trace` / `emit_io`
//!   / `emit_error` / `emit_system`)
//! - [`persist`] — `telemetry_events` 表持久化(滚动保留)
//! - [`commands`] — IPC 命令层(list/clear/enable/disable/report_error)
//!
//! ## 调试控制台集成
//!
//! - 前端监听 `telemetry-event` 事件实时显示
//! - 旧 `debug-log` 事件保留(只对 SQL 事件别名 emit),未迁移组件继续工作
//! - `TelemetryExplorer` 组件按 kind tab 聚合查看

pub mod bus;
pub mod commands;
pub mod event;
pub mod persist;
