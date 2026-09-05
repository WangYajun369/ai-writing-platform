//! 数据访问层（Repository）
//!
//! 每个子模块提供对应实体的纯 SQL 操作，接受 `&rusqlite::Connection`，
//! 不依赖 Tauri State / AppHandle，不包含任何业务逻辑。
//!
//! 所有 row 解析函数对外公开，供上层复用。

pub mod book_repo;
pub mod chapter_repo;
pub mod diary_repo;
pub mod embedding_repo;
pub mod schedule_repo;
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
