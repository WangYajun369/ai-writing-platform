//! Unit of Work 模式（v1.9 架构优化）
//!
//! 封装事务边界 + SQL 审计统一收口，解决两个痛点：
//!
//! 1. **事务边界手写**：原 service 直接 `db.pool.get()` 取连接，
//!    跨多表操作（如 task 删除要清 tasks + subtasks + task_tags + attachments
//!    + activity_logs）需要外层事务，但内层 service 不知道，靠人工拼接。
//!    UnitOfWork 提供显式 `begin_transaction` / `commit` / `rollback`，
//!    跨 service 协作时通过 `&mut Uow` 引用传递，支持嵌套协调。
//!
//! 2. **SQL 审计分散**：原 100+ 处 `emit_sql_log(app, "INSERT", "tags", ...)`
//!    手写在每个 SQL 操作后，冗长且易遗漏。Uow 改为累积式：service 内
//!    `uow.audit(...)` 记录条目，`commit()` 时统一 emit。失败回滚时
//!    丢弃审计，避免「未提交的操作却留下日志」的反直觉行为。
//!
//! ## 渐进式迁移策略
//!
//! 不强制一次性改造所有 service。新增的跨多表操作优先用 Uow；
//! 既有单表 service 可按节奏迁移。`tag_service.rs` 等单表简单操作
//! 迁移收益较小，可保留原 `emit_sql_log` 形式。
//!
//! ## 用法示例
//!
//! ```ignore
//! use crate::service::uow::UnitOfWork;
//!
//! pub fn delete_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
//!     let pooled = db.pool.get()?;
//!     let mut uow = UnitOfWork::new(&pooled, app);
//!     uow.begin_transaction()?; // 跨多表原子性
//!
//!     task_repo::delete(uow.conn(), id)?;
//!     uow.audit("DELETE", "tasks", format!("id={id}"), file!(), line!());
//!
//!     subtask_repo::delete_by_task(uow.conn(), id)?;
//!     uow.audit("DELETE", "task_subtasks", format!("task_id={id}"), file!(), line!());
//!
//!     // ... 其他关联表清理
//!
//!     uow.commit()?; // 统一 emit 审计 + 提交事务
//!     Ok(())
//! }
//! ```
//!
//! ## 失败回滚
//!
//! 任何 `?` 失败时，`Uow` 通过 `Drop::drop` 自动回滚事务（若已开启），
//! 并丢弃累积的审计条目（未提交的操作不留日志）。

use crate::commands::window::emit_sql_log;
use crate::error::AppError;
use rusqlite::Connection;
use tauri::AppHandle;

/// 单条 SQL 审计条目（累积在 Uow 内，commit 时统一 emit）
struct AuditEntry {
    operation: &'static str,
    table: &'static str,
    detail: String,
    file: &'static str,
    line: u32,
}

/// Unit of Work：封装事务边界 + SQL 审计统一收口。
///
/// 生命周期跟随调用方的 `PooledConnection`：使用方 `db.pool.get()?` 取出连接，
/// 把 `&conn` 传给 `Uow::new`。Uow drop 时若仍有未提交事务则自动回滚。
pub struct UnitOfWork<'a> {
    conn: &'a Connection,
    app: Option<&'a AppHandle>,
    pending_audits: Vec<AuditEntry>,
    in_transaction: bool,
    /// 是否已显式 commit/rollback（避免 drop 时重复操作）
    finished: bool,
}

impl<'a> UnitOfWork<'a> {
    /// 创建 Uow。默认 autocommit 模式（单语句自动提交）。
    /// 跨多表原子性需调用 [`UnitOfWork::begin_transaction`]。
    pub fn new(conn: &'a Connection, app: Option<&'a AppHandle>) -> Self {
        Self {
            conn,
            app,
            pending_audits: Vec::new(),
            in_transaction: false,
            finished: false,
        }
    }

    /// 返回 &Connection，供 repository 函数使用。
    pub fn conn(&self) -> &Connection {
        self.conn
    }

    /// 开启显式事务。后续 SQL 不会自动提交，直到 [`UnitOfWork::commit`]。
    /// 重复调用返回 Ok（幂等，已开启则不报错）。
    pub fn begin_transaction(&mut self) -> Result<(), AppError> {
        if !self.in_transaction {
            self.conn.execute_batch("BEGIN")?;
            self.in_transaction = true;
        }
        Ok(())
    }

    /// 记录审计条目（不立即 emit，commit 时统一发）。
    ///
    /// 替代旧式 `emit_sql_log(app, "INSERT", "tags", &format!(...), file!(), line!())`：
    /// - 失败回滚时丢弃累积条目，避免「未提交的操作留下日志」；
    /// - 批量 emit 减少 app.emit 调用次数。
    pub fn audit(
        &mut self,
        operation: &'static str,
        table: &'static str,
        detail: impl Into<String>,
        file: &'static str,
        line: u32,
    ) {
        self.pending_audits.push(AuditEntry {
            operation,
            table,
            detail: detail.into(),
            file,
            line,
        });
    }

    /// 提交事务（若已开启）+ 统一 emit 累积的审计条目。
    ///
    /// 调用后 Uow 标记为 finished，drop 时不再操作事务。
    pub fn commit(mut self) -> Result<(), AppError> {
        self.finished = true;
        // 先提交事务（如有），失败则不 emit 审计（避免「未提交的操作留下日志」）
        if self.in_transaction {
            self.conn.execute_batch("COMMIT")?;
            self.in_transaction = false;
        }
        // 事务提交成功后再 emit 审计
        if let Some(app) = self.app {
            for entry in &self.pending_audits {
                emit_sql_log(
                    app,
                    entry.operation,
                    entry.table,
                    &entry.detail,
                    entry.file,
                    entry.line,
                );
            }
        }
        Ok(())
    }

    /// 显式回滚（丢弃累积的审计条目 + 回滚事务）。
    ///
    /// 通常不需要显式调用：`?` 失败时 Uow drop 会自动回滚。
    /// 此方法用于「主动放弃但无错误」的场景（如校验后决定不执行）。
    pub fn rollback(mut self) {
        self.finished = true;
        if self.in_transaction {
            // 忽略 rollback 错误（已是错误路径，无法恢复）
            let _ = self.conn.execute_batch("ROLLBACK");
            self.in_transaction = false;
        }
        // 丢弃 pending_audits（不 emit，未提交的操作不留日志）
        self.pending_audits.clear();
    }

    /// 当前累积的审计条目数（用于测试与诊断）。
    pub fn pending_audit_count(&self) -> usize {
        self.pending_audits.len()
    }
}

impl<'a> Drop for UnitOfWork<'a> {
    /// 析构时若仍有未提交事务，自动回滚（丢弃审计）。
    /// 这覆盖了 `?` 失败路径：service 函数返回 Err 前，Uow drop 自动清理。
    fn drop(&mut self) {
        if !self.finished && self.in_transaction {
            let _ = self.conn.execute_batch("ROLLBACK");
            // drop 时丢弃 pending_audits（不 emit）
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 创建内存 SQLite 测试库
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'enabled',
                created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn uow_autocommit_mode_no_transaction() {
        // 不调用 begin_transaction，commit 不执行 COMMIT（autocommit 模式）
        let conn = test_conn();
        let mut uow = UnitOfWork::new(&conn, None);
        uow.audit("INSERT", "tags", "id=t1", file!(), line!());
        assert_eq!(uow.pending_audit_count(), 1);
        // in_transaction 应为 false
        assert!(!uow.in_transaction);
        uow.commit().unwrap();
    }

    #[test]
    fn uow_begin_transaction_then_commit() {
        let conn = test_conn();
        let mut uow = UnitOfWork::new(&conn, None);
        uow.begin_transaction().unwrap();
        assert!(uow.in_transaction);

        // 在事务内插入
        conn.execute(
            "INSERT INTO tags (id, name, color, status, created_at) VALUES (?1, ?2, '', 'enabled', 'now')",
            rusqlite::params!["t1", "Tag1"],
        )
        .unwrap();

        uow.audit("INSERT", "tags", "id=t1", file!(), line!());
        uow.commit().unwrap();

        // commit 后应能查到
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM tags WHERE id = 't1'", [], |row| row.get(0))
                .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn uow_rollback_discards_changes_and_audits() {
        let conn = test_conn();
        let mut uow = UnitOfWork::new(&conn, None);
        uow.begin_transaction().unwrap();

        conn.execute(
            "INSERT INTO tags (id, name, color, status, created_at) VALUES (?1, ?2, '', 'enabled', 'now')",
            rusqlite::params!["t1", "Tag1"],
        )
        .unwrap();
        uow.audit("INSERT", "tags", "id=t1", file!(), line!());
        assert_eq!(uow.pending_audit_count(), 1);

        uow.rollback();

        // rollback 后应查不到（事务回滚）
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM tags WHERE id = 't1'", [], |row| row.get(0))
                .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn uow_drop_auto_rollback_on_early_return() {
        let conn = test_conn();
        {
            let mut uow = UnitOfWork::new(&conn, None);
            uow.begin_transaction().unwrap();
            conn.execute(
                "INSERT INTO tags (id, name, color, status, created_at) VALUES (?1, ?2, '', 'enabled', 'now')",
                rusqlite::params!["t1", "Tag1"],
            )
            .unwrap();
            uow.audit("INSERT", "tags", "id=t1", file!(), line!());
            // 模拟 ? 失败：uow 离开作用域，drop 应自动 rollback
        }
        // 验证：数据应未持久化
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM tags WHERE id = 't1'", [], |row| row.get(0))
                .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn uow_begin_transaction_idempotent() {
        let conn = test_conn();
        let mut uow = UnitOfWork::new(&conn, None);
        uow.begin_transaction().unwrap();
        uow.begin_transaction().unwrap(); // 重复调用不报错
        assert!(uow.in_transaction);
        uow.commit().unwrap();
    }

    #[test]
    fn uow_audit_accumulates_until_commit() {
        // 审计条目累积，commit 时才统一 emit（这里用 None app 不实际 emit）
        let conn = test_conn();
        let mut uow = UnitOfWork::new(&conn, None);
        uow.audit("INSERT", "tags", "id=t1", file!(), line!());
        uow.audit("UPDATE", "tags", "id=t1", file!(), line!());
        uow.audit("DELETE", "tags", "id=t1", file!(), line!());
        assert_eq!(uow.pending_audit_count(), 3);
        uow.commit().unwrap();
    }

    #[test]
    fn uow_without_app_handle_skips_emit_silently() {
        // app = None 时 commit 仍成功，只是不 emit 审计
        let conn = test_conn();
        let mut uow = UnitOfWork::new(&conn, None);
        uow.audit("INSERT", "tags", "id=t1", file!(), line!());
        uow.commit().unwrap();
    }
}
