//! 数据访问层（Repository）
//!
//! 每个子模块提供对应实体的纯 SQL 操作，接受 `&rusqlite::Connection`，
//! 不依赖 Tauri State / AppHandle，不包含任何业务逻辑。
//!
//! 所有 row 解析函数对外公开，供上层复用。
//!
//! 模块按产品域分两段排列：前半段为书籍创作（book 域）及日记/日程/生词等
//! 常规模块；后半段（见下方「── 任务卡模块 ──」分隔之后）为任务卡模块。
//!
//! ## 软删除泛型化（v1.9 架构优化 #2）
//!
//! [`soft_delete`] 模块抽取 book / project / task / volume 等 repo 中重复的
//! 软删除 SQL 模式（`soft_delete` / `restore` / `hard_delete` / `count_deleted`
//! / `clear_trash` / `purge_expired`），通过 [`soft_delete::Table`] trait 的
//! 关联常量在编译期注入表名，monomorphization 后零运行时开销。

pub mod book_repo;
pub mod agent_trace_repo;
pub mod chapter_repo;
pub mod diary_repo;
pub mod embedding_repo;
pub mod schedule_repo;
pub mod soft_delete;
pub mod snapshot_repo;
pub mod vocab_repo;
pub mod volume_repo;
pub mod world_card_repo;
pub mod writing_stats_repo;
// ── 任务卡模块 ──
pub mod activity_log_repo;
pub mod attachment_repo;
pub mod project_repo;
pub mod subtask_repo;
pub mod tag_repo;
pub mod task_meta_repo;
pub mod task_repo;
pub mod template_repo;
