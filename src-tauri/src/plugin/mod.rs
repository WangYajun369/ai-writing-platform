//! Agent 插件宿主（ADR-006）
//!
//! 承载「第三方编写的、带自定义逻辑的 Agent」的安装与卸载。
//!
//! ## 与 `src/plugins/`（内置模块）是两套东西
//!
//! | | 内置模块（前端 `src/plugins/`） | Agent 插件（本模块） |
//! |---|---|---|
//! | 载体 | 编译期硬编码的 TypeScript | 运行时从磁盘加载的 JS |
//! | 装卸 | 改源码 + 重新构建 | 运行时安装 / 卸载 |
//! | 权限 | 无声明（同属主 bundle） | `grants` 显式声明 + 安装确认 |
//! | 能力 | 扩展点 UI 命令 | 贡献 Agent 画像与编排逻辑 |
//!
//! 划界详见 `docs/development/plugin-system.md`。
//!
//! ## 分层
//!
//! ```text
//! commands/plugin.rs   IPC 薄层（枚举 / 安装 / 卸载 / 启用 / 读源码）
//!        ↓
//! plugin/loader.rs     目录扫描、清单校验、启用清单持久化
//!        ↓
//! plugin/model.rs      数据模型与权限枚举（grants）
//! ```

// 不设 `pub use` 门面：调用方（commands/plugin.rs、agent/engine.rs）都直接用
// `loader::` / `model::` / `profile::` 的具体路径，多一层转发只会变成死代码。
pub mod loader;
pub mod model;
pub mod profile;
