//! 软删除生命周期的泛型实现（v1.9 架构优化 #2）
//!
//! 抽取 book / project / task / volume 等 repo 中重复的软删除 SQL 模式：
//! - `soft_delete`：`UPDATE t SET deleted_at=?1, updated_at=?1 WHERE id=?2 AND deleted_at IS NULL`
//! - `restore`：`UPDATE t SET deleted_at=NULL, updated_at=?1 WHERE id=?2 AND deleted_at IS NOT NULL`
//! - `hard_delete`：`DELETE FROM t WHERE id=?1`（无 deleted_at 守卫，依赖外键 CASCADE）
//! - `hard_delete_trashed`：`DELETE FROM t WHERE id=?1 AND deleted_at IS NOT NULL`（仅清回收站）
//! - `count_deleted`：`SELECT COUNT(*) FROM t WHERE deleted_at IS NOT NULL`
//! - `clear_trash`：`DELETE FROM t WHERE deleted_at IS NOT NULL`
//! - `purge_expired`：`DELETE FROM t WHERE deleted_at IS NOT NULL AND deleted_at < ?1`
//!
//! ## 选型理由（trait + 泛型函数 vs macro）
//!
//! - **类型安全**：表名通过 `Table` trait 关联常量传递，编译期校验，无运行时开销；
//! - **IDE 友好**：trait 完整签名 + 默认实现，IDE 自动补全；macro 调试困难；
//! - **渐进迁移**：旧 repo 函数保留为薄包装委派，不破坏现有调用点；
//! - **符合分层**：trait 与泛型函数位于 repository 层，service 通过 `Table` 标记类型调用。
//!
//! ## 用法
//!
//! ```ignore
//! use crate::repository::soft_delete::{Table, self};
//!
//! // 1. 在 repo 模块定义 marker 类型并 impl Table
//! pub struct BookTable;
//! impl Table for BookTable {
//!     const NAME: &'static str = "books";
//! }
//!
//! // 2. 旧函数改为薄包装
//! pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<()> {
//!     soft_delete::soft_delete::<BookTable>(conn, id, ts)?;
//!     Ok(())
//! }
//! ```

use rusqlite::{params, Connection, Result};

/// 软删除表的标记 trait。
///
/// 每个软删除实体的 repo 模块定义一个 unit struct 作为 marker，
/// impl `Table` 提供表名与可选的列名（默认 `id` / `deleted_at` / `updated_at`）。
///
/// 关联常量保证编译期已知表名，monomorphization 时内联到具体 SQL，
/// 无运行时开销。
pub trait Table {
    /// 表名（如 `"books"`、`"projects"`）。来自代码字面量，禁止外部拼接。
    const NAME: &'static str;
    /// 主键列名，默认 `"id"`。
    const ID_COL: &'static str = "id";
    /// 软删除时间戳列名，默认 `"deleted_at"`。
    const DELETED_AT_COL: &'static str = "deleted_at";
    /// 更新时间戳列名，默认 `"updated_at"`。
    const UPDATED_AT_COL: &'static str = "updated_at";
}

// ── 6 个泛型 SQL 函数 ──

/// 软删除：标记 `deleted_at`，同时刷新 `updated_at`。
///
/// 仅作用于未删除的行（`deleted_at IS NULL`）。
/// 返回受影响行数（0 表示行不存在或已被软删）。
pub fn soft_delete<T: Table>(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    let sql = format!(
        "UPDATE {} SET {}=?1, {}=?1 WHERE {}=?2 AND {} IS NULL",
        T::NAME,
        T::DELETED_AT_COL,
        T::UPDATED_AT_COL,
        T::ID_COL,
        T::DELETED_AT_COL
    );
    conn.execute(&sql, params![ts, id])
}

/// 恢复：清除 `deleted_at`，同时刷新 `updated_at`。
///
/// 仅作用于回收站中的行（`deleted_at IS NOT NULL`）。
/// 返回受影响行数（0 表示行不存在或不在回收站）。
pub fn restore<T: Table>(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    let sql = format!(
        "UPDATE {} SET {}=NULL, {}=?1 WHERE {}=?2 AND {} IS NOT NULL",
        T::NAME,
        T::DELETED_AT_COL,
        T::UPDATED_AT_COL,
        T::ID_COL,
        T::DELETED_AT_COL
    );
    conn.execute(&sql, params![ts, id])
}

/// 硬删除：DELETE WHERE id=?1，无 `deleted_at` 守卫。
///
/// 用于外键 `ON DELETE CASCADE` 的场景（books / volumes 等），
/// 由数据库自动级联清理关联表。回收站之外的行也会被删，
/// 调用方需自行保证不在生产数据上误调用。
pub fn hard_delete<T: Table>(conn: &Connection, id: &str) -> Result<usize> {
    let sql = format!("DELETE FROM {} WHERE {}=?1", T::NAME, T::ID_COL);
    conn.execute(&sql, params![id])
}

/// 硬删除回收站中的行：`DELETE WHERE id=?1 AND deleted_at IS NOT NULL`。
///
/// 仅作用于已软删的行，活数据不会被误删。返回受影响行数。
pub fn hard_delete_trashed<T: Table>(conn: &Connection, id: &str) -> Result<usize> {
    let sql = format!(
        "DELETE FROM {} WHERE {}=?1 AND {} IS NOT NULL",
        T::NAME,
        T::ID_COL,
        T::DELETED_AT_COL
    );
    conn.execute(&sql, params![id])
}

/// 统计回收站中的行数。
pub fn count_deleted<T: Table>(conn: &Connection) -> Result<u32> {
    let sql = format!(
        "SELECT COUNT(*) FROM {} WHERE {} IS NOT NULL",
        T::NAME,
        T::DELETED_AT_COL
    );
    conn.query_row(&sql, [], |row| row.get(0))
}

/// 清空回收站：DELETE WHERE deleted_at IS NOT NULL。
///
/// 外键 `ON DELETE CASCADE` 会自动清理关联表（volumes / chapters / task_tags 等）。
/// `task_activity_logs` 等无外键的表需由 service 在同事务内显式清理。
pub fn clear_trash<T: Table>(conn: &Connection) -> Result<()> {
    let sql = format!(
        "DELETE FROM {} WHERE {} IS NOT NULL",
        T::NAME,
        T::DELETED_AT_COL
    );
    conn.execute(&sql, [])?;
    Ok(())
}

/// 回收站自动清理：硬删除 `deleted_at < cutoff` 的行。
///
/// 用于 30 天滚动清理（PRD 9.12.2）。`deleted_at` 与 `cutoff` 同为
/// UTC RFC3339 字符串，可字典序比较。返回受影响行数。
pub fn purge_expired<T: Table>(conn: &Connection, cutoff: &str) -> Result<usize> {
    let sql = format!(
        "DELETE FROM {} WHERE {} IS NOT NULL AND {} < ?1",
        T::NAME,
        T::DELETED_AT_COL,
        T::DELETED_AT_COL
    );
    conn.execute(&sql, params![cutoff])
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用 marker：表名 `widgets`
    struct WidgetTable;
    impl Table for WidgetTable {
        const NAME: &'static str = "widgets";
    }

    /// 测试用 marker：自定义列名（id_col=`wid`、deleted_at_col=`trashed_at`）
    struct CustomTable;
    impl Table for CustomTable {
        const NAME: &'static str = "customs";
        const ID_COL: &'static str = "wid";
        const DELETED_AT_COL: &'static str = "trashed_at";
        const UPDATED_AT_COL: &'static str = "modified_at";
    }

    /// 构造标准 widgets 表（id, deleted_at, updated_at）
    fn widget_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE widgets (
                id          TEXT PRIMARY KEY,
                deleted_at  TEXT,
                updated_at  TEXT NOT NULL DEFAULT ''
            );",
        )
        .unwrap();
        conn
    }

    /// 构造自定义列名表
    fn custom_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE customs (
                wid         TEXT PRIMARY KEY,
                trashed_at  TEXT,
                modified_at TEXT NOT NULL DEFAULT ''
            );",
        )
        .unwrap();
        conn
    }

    fn insert_widget(conn: &Connection, id: &str, deleted_at: Option<&str>) {
        conn.execute(
            "INSERT INTO widgets (id, deleted_at, updated_at) VALUES (?1, ?2, 't0')",
            params![id, deleted_at],
        )
        .unwrap();
    }

    fn insert_custom(conn: &Connection, wid: &str, trashed_at: Option<&str>) {
        conn.execute(
            "INSERT INTO customs (wid, trashed_at, modified_at) VALUES (?1, ?2, 't0')",
            params![wid, trashed_at],
        )
        .unwrap();
    }

    fn widget_deleted(conn: &Connection, id: &str) -> bool {
        conn.query_row(
            "SELECT deleted_at IS NOT NULL FROM widgets WHERE id=?1",
            params![id],
            |r| r.get::<_, bool>(0),
        )
        .unwrap()
    }

    // ── soft_delete ──

    #[test]
    fn soft_delete_marks_active_row() {
        let conn = widget_db();
        insert_widget(&conn, "w1", None);
        let n = soft_delete::<WidgetTable>(&conn, "w1", "t1").unwrap();
        assert_eq!(n, 1);
        assert!(widget_deleted(&conn, "w1"));
        // updated_at 应同步刷新
        let ts: String = conn
            .query_row("SELECT updated_at FROM widgets WHERE id='w1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ts, "t1");
    }

    #[test]
    fn soft_delete_skips_already_deleted() {
        // 已软删的行返回 0 受影响
        let conn = widget_db();
        insert_widget(&conn, "w1", Some("t0"));
        let n = soft_delete::<WidgetTable>(&conn, "w1", "t1").unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn soft_delete_unknown_id_is_noop() {
        let conn = widget_db();
        let n = soft_delete::<WidgetTable>(&conn, "missing", "t1").unwrap();
        assert_eq!(n, 0);
    }

    // ── restore ──

    #[test]
    fn restore_clears_deleted_at() {
        let conn = widget_db();
        insert_widget(&conn, "w1", Some("t0"));
        let n = restore::<WidgetTable>(&conn, "w1", "t1").unwrap();
        assert_eq!(n, 1);
        assert!(!widget_deleted(&conn, "w1"));
    }

    #[test]
    fn restore_skips_active_row() {
        // 未删除的行返回 0（恢复操作仅作用于回收站）
        let conn = widget_db();
        insert_widget(&conn, "w1", None);
        let n = restore::<WidgetTable>(&conn, "w1", "t1").unwrap();
        assert_eq!(n, 0);
    }

    // ── hard_delete vs hard_delete_trashed ──

    #[test]
    fn hard_delete_no_guard_removes_active_and_trashed() {
        let conn = widget_db();
        insert_widget(&conn, "live", None);
        insert_widget(&conn, "dead", Some("t0"));
        // 无守卫：两种状态都删
        assert_eq!(hard_delete::<WidgetTable>(&conn, "live").unwrap(), 1);
        assert_eq!(hard_delete::<WidgetTable>(&conn, "dead").unwrap(), 1);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM widgets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn hard_delete_trashed_only_removes_deleted() {
        let conn = widget_db();
        insert_widget(&conn, "live", None);
        insert_widget(&conn, "dead", Some("t0"));
        // 仅清回收站
        assert_eq!(
            hard_delete_trashed::<WidgetTable>(&conn, "live").unwrap(),
            0
        );
        assert_eq!(
            hard_delete_trashed::<WidgetTable>(&conn, "dead").unwrap(),
            1
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM widgets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "活跃行应保留");
    }

    // ── count_deleted ──

    #[test]
    fn count_deleted_returns_trash_size() {
        let conn = widget_db();
        insert_widget(&conn, "w1", None);
        insert_widget(&conn, "w2", Some("t0"));
        insert_widget(&conn, "w3", Some("t0"));
        assert_eq!(count_deleted::<WidgetTable>(&conn).unwrap(), 2);
    }

    // ── clear_trash ──

    #[test]
    fn clear_trash_removes_only_deleted() {
        let conn = widget_db();
        insert_widget(&conn, "live", None);
        insert_widget(&conn, "dead1", Some("t0"));
        insert_widget(&conn, "dead2", Some("t0"));
        clear_trash::<WidgetTable>(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM widgets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "仅活跃行保留");
    }

    // ── purge_expired ──

    #[test]
    fn purge_expired_removes_old_trash_only() {
        let conn = widget_db();
        insert_widget(&conn, "live", None);
        insert_widget(&conn, "old", Some("2026-01-01T00:00:00Z"));
        insert_widget(&conn, "new", Some("2026-09-30T00:00:00Z"));
        let n = purge_expired::<WidgetTable>(&conn, "2026-09-01T00:00:00Z").unwrap();
        assert_eq!(n, 1, "只有 old < cutoff 被清理");
        // live 与 new 保留
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM widgets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    // ── 自定义列名 ──

    #[test]
    fn custom_column_names_work() {
        // 验证 ID_COL / DELETED_AT_COL / UPDATED_AT_COL 的覆盖生效
        let conn = custom_db();
        insert_custom(&conn, "c1", None);
        let n = soft_delete::<CustomTable>(&conn, "c1", "tc").unwrap();
        assert_eq!(n, 1);
        // 验证 trashed_at 列被设置
        let trashed: Option<String> = conn
            .query_row("SELECT trashed_at FROM customs WHERE wid='c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(trashed.as_deref(), Some("tc"));
        // 验证 modified_at 列被同步
        let modified: String = conn
            .query_row("SELECT modified_at FROM customs WHERE wid='c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(modified, "tc");
        // restore 也用自定义列名
        let n = restore::<CustomTable>(&conn, "c1", "tr").unwrap();
        assert_eq!(n, 1);
        assert_eq!(count_deleted::<CustomTable>(&conn).unwrap(), 0);
    }
}
