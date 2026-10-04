//! DDL 编排入口 —— 建表 / FTS / 索引 / 列迁移
//!
//! 把原本散落在 `db::mod::migrate` 中的 500+ 行 SQL 按产品域拆分到子模块：
//! - [`core`]：书籍 / 章节 / 快照 / 世界观 / embeddings / memories / 日记 / 日程 / 生词本 / 复习记录（11 张表）
//! - [`taskcard`]：任务卡模块（12 张表）
//! - [`fts`]：FTS5 虚拟表 + 同步触发器 + 既有数据回填
//! - [`indices`]：全部二级索引
//! - [`migrations`]：旧库 `ALTER TABLE ADD COLUMN` 兜底清单
//!
//! 调用约定：所有 DDL 均幂等（`IF NOT EXISTS` + `safe_add_column` 跳过已存在列），
//! 重复执行零副作用。本模块只负责结构，业务/数据迁移走 `run_versioned_migrations`。

use anyhow::Context;
use rusqlite::Connection;

pub mod core;
pub mod fts;
pub mod indices;
pub mod migrations;
pub mod taskcard;

/// 执行 ALTER TABLE ADD COLUMN，若列已存在则跳过，其他错误向上传播。
///
/// 返回值：`true` = 本次实际新增了该列；`false` = 列已存在（跳过）。
///
/// 注意：这里刻意不打印日志，交由调用方汇总输出。
/// 因为绝大多数启动都会命中"列已存在"分支，逐条打印会产生固定噪音。
pub(crate) fn safe_add_column(
    conn: &Connection,
    table: &str,
    column: &str,
    column_def: &str,
) -> anyhow::Result<bool> {
    let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, column_def);
    match conn.execute(&sql, []) {
        Ok(_) => Ok(true),
        Err(e) => {
            if e.to_string().contains("duplicate column name") {
                Ok(false)
            } else {
                Err(e).with_context(|| format!("ALTER TABLE {}.{} 失败", table, column))
            }
        }
    }
}

/// 应用全部建表与索引 DDL（不含列迁移）。
///
/// 顺序：核心表 → 任务卡表 → FTS5 → 索引。
/// FTS5 依赖核心表存在（触发器引用 chapters / world_cards），故必须在核心表之后；
/// 索引可放最后，避免旧库因列不存在而创建索引失败（索引列也由 `migrations` 补齐）。
pub fn apply_all_ddl(conn: &Connection) -> anyhow::Result<()> {
    core::apply(conn)?;
    taskcard::apply(conn)?;
    fts::apply(conn)?;
    indices::apply(conn)?;
    Ok(())
}

/// 应用列迁移（旧库 ALTER 兜底）。返回本次实际新增的列名列表。
pub fn apply_column_migrations(conn: &Connection) -> anyhow::Result<Vec<String>> {
    migrations::apply(conn)
}
