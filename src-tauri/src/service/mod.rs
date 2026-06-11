//! 业务服务层（Service）
//!
//! 每个子模块封装对应实体的业务逻辑编排：
//! - 从 `AppDb` 获取数据库连接
//! - 调用 Repository 层完成数据操作
//! - 通过 `emit_sql_log` 记录 SQL 审计日志
//! - 处理事务边界和业务规则

pub mod book_service;
pub mod volume_service;
pub mod chapter_service;
pub mod snapshot_service;
pub mod world_card_service;
pub mod search_service;
