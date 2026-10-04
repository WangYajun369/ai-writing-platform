//! Schema 内省（introspection）工具函数
//!
//! 封装对 SQLite schema 元数据的查询（PRAGMA / sqlite_master），供调试控制台
//! 的 `schema_status` / `schema_diff` 命令使用。
//!
//! 这些操作的对象是 **数据库结构本身** 而非业务实体，因此放在 `db` 层而非
//! `repository` 层（repository 层只处理业务表的 CRUD）。

use anyhow::{Context, Result};
use rusqlite::Connection;

/// 读取当前数据库的 `PRAGMA user_version`（结构版本号）
pub fn get_user_version(conn: &Connection) -> Result<u32> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .context("读取 PRAGMA user_version 失败")?;
    Ok(version as u32)
}

/// 列出数据库中所有用户表名（排除 sqlite_* 内部表，按名称升序）
pub fn list_user_tables(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type='table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .context("准备 sqlite_master 查询失败")?;
    let tables = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .context("查询 sqlite_master 失败")?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tables)
}

/// 通过 `PRAGMA table_info` 获取指定表的全部列名
pub fn list_table_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>> {
    // table_name 来自代码侧 TABLE_SCHEMA 常量（编译期字面量），非用户输入，
    // 直接拼接 SQL 无注入风险。
    let sql = format!("PRAGMA table_info({})", table_name);
    let mut stmt = conn
        .prepare(&sql)
        .with_context(|| format!("准备 PRAGMA table_info({}) 失败", table_name))?;
    // PRAGMA table_info 返回列：cid, name, type, notnull, dflt_value, pk
    // 第二列（index 1）是列名。
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .with_context(|| format!("查询 PRAGMA table_info({}) 失败", table_name))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn user_version_defaults_to_zero() {
        let conn = setup();
        assert_eq!(get_user_version(&conn).unwrap(), 0);
    }

    #[test]
    fn list_user_tables_excludes_sqlite_internal() {
        let conn = setup();
        let tables = list_user_tables(&conn).unwrap();
        assert_eq!(tables, vec!["books".to_string(), "volumes".to_string()]);
    }

    #[test]
    fn list_table_columns_returns_column_names() {
        let conn = setup();
        let cols = list_table_columns(&conn, "books").unwrap();
        assert_eq!(cols, vec!["id".to_string(), "title".to_string()]);
    }
}
