//! 列迁移清单 —— 旧库 ALTER TABLE ADD COLUMN 兜底
//!
//! 在幂等 DDL 之上为旧库补列。`safe_add_column` 会跳过已存在的列，故本清单
//! 重复执行是安全的。新增非幂等演进时改走 `AppDb::run_versioned_migrations`。
//!
//! 元组语义：(table, column, column_def)。
//!
//! 维护约定：在 `db::mod::migrate` 给旧表新增列时，**必须**同步追加到本清单，
//! 否则 [`crate::db::schema::TABLE_SCHEMA`] 与 `validate_database` 会误报缺列
//! （见 `commands/window/validate.rs`）。

use rusqlite::Connection;

/// 旧库补列清单（v1.7.0 之前的库需要这些 ALTER 才能对齐当前结构）。
///
/// 顺序无依赖，但建议按表聚集以便阅读。
pub const COLUMN_MIGRATIONS: &[(&str, &str, &str)] = &[
    ("volumes", "deleted_at", "TEXT"),
    ("chapters", "deleted_at", "TEXT"),
    ("books", "deleted_at", "TEXT"),
    ("chapters", "summary", "TEXT"),
    ("chapters", "summary_at", "TEXT"),
    ("books", "outline", "TEXT NOT NULL DEFAULT ''"),
    ("chapters", "outline", "TEXT NOT NULL DEFAULT ''"),
    ("vocab_words", "ai_details", "TEXT NOT NULL DEFAULT ''"),
    ("vocab_words", "example_zh", "TEXT NOT NULL DEFAULT ''"),
    // 任务卡 P2 补列
    ("tasks", "recurrence", "TEXT NOT NULL DEFAULT ''"),
    ("tasks", "note_html", "TEXT NOT NULL DEFAULT ''"),
    ("tasks", "started_at", "TEXT"),
    ("tasks", "work_seconds", "INTEGER NOT NULL DEFAULT 0"),
    // 任务卡父子任务（甘特图铺路）：parent_id 引用同表任务的 id
    ("tasks", "parent_id", "TEXT"),
    // 任务完成总结（富文本 HTML；勾选完成时填写）
    ("tasks", "completion_summary", "TEXT NOT NULL DEFAULT ''"),
    // 记忆库命中时间（过期清理依据；旧库 ALTER 补列，默认 NULL 表示从未命中）
    ("memories", "last_hit_at", "TEXT"),
];

/// 依次执行补列。返回本次实际新增的列名列表（形如 `table.column`），
/// 供调用方汇总输出。空 Vec 表示全部列已存在（最常见情况）。
pub fn apply(conn: &Connection) -> anyhow::Result<Vec<String>> {
    let mut added: Vec<String> = Vec::new();
    for (table, column, column_def) in COLUMN_MIGRATIONS {
        if super::safe_add_column(conn, table, column, column_def)? {
            added.push(format!("{table}.{column}"));
        }
    }
    Ok(added)
}
