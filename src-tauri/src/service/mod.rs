//! 业务服务层（Service）
//!
//! 每个子模块封装对应实体的业务逻辑编排：
//! - 从 `AppDb` 获取数据库连接
//! - 调用 Repository 层完成数据操作（**禁止直接执行 SQL**）
//! - 通过 [`uow::UnitOfWork::audit`] 记录 SQL 审计日志（commit 时统一 emit）
//! - 处理事务边界和业务规则
//!
//! ## Unit of Work（v1.9 新增）
//!
//! [`uow::UnitOfWork`] 封装事务边界 + SQL 审计统一收口，所有写操作必须通过
//! UoW 执行。详见 [`uow`] 模块文档。

pub mod uow;

// ── 写作模块 ──
pub mod book_service;
pub mod chapter_service;
pub mod diary_service;
pub mod export_service;
pub mod import_txt_service;
pub mod schedule_service;
pub mod search_service;
pub mod snapshot_service;
pub mod vocab_service;
pub mod volume_service;
pub mod world_card_service;
pub mod writing_stats_service;
// ── 任务卡模块 ──
pub mod activity_log_service;
pub mod agent_trace_service;
pub mod attachment_service;
pub mod migrate_service;
pub mod project_service;
pub mod project_stats_service;
pub mod reminder_service;
pub mod scheduler;
pub mod subtask_service;
pub mod tag_service;
pub mod task_meta_service;
pub mod task_service;
pub mod template_service;
