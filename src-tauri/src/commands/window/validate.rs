//! 数据库校验
//!
//! 表结构完整性检查 + 数据完整性验证（PRAGMA integrity_check + 外键孤儿检测）。

use tauri::{AppHandle, Emitter, Manager};
use chrono::Local;
use serde::Serialize;
use super::LogEntry;
use crate::db::schema::TABLE_SCHEMA;
use crate::error::AppError;

/// 数据库校验结果 — 单条问题
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    pub issue_type: String,
    pub detail: String,
}

/// 数据库校验总结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub ok: bool,
    pub tables_count: usize,
    pub issues: Vec<ValidationIssue>,
}

/// 校验本地 SQLite 数据库：表结构完整性 + 数据完整性
#[tauri::command]
pub async fn validate_database(app: AppHandle) -> Result<ValidationResult, AppError> {
    let db = app.state::<crate::db::AppDb>();
    let conn = db.pool.get().map_err(|e| AppError::DbPool(format!("获取数据库连接失败: {}", e)))?;
    let mut issues = Vec::new();

    // 1. 检查所有表是否存在
    let tables_sql =
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
    let mut stmt = conn.prepare(tables_sql).map_err(|e| AppError::Business(format!("准备 SQL 失败: {}", e)))?;
    let existing_tables: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| AppError::Business(format!("查询表列表失败: {}", e)))?
        .filter_map(|r| r.ok())
        .collect();
    let tables_count = existing_tables.len();

    let _ = app.emit(
        "debug-log",
        LogEntry {
            timestamp: Local::now().format("%H:%M:%S").to_string(),
            level: "log".to_string(),
            message: format!(
                "[validate_database] 发现 {} 张表: {:?}",
                tables_count, existing_tables
            ),
            file: Some("src-tauri/src/commands/window/validate.rs".to_string()),
            file_name: Some("validate.rs".to_string()),
            line: Some(line!()),
        },
    );

    for (table_name, expected_cols) in TABLE_SCHEMA {
        if !existing_tables.contains(&table_name.to_string()) {
            issues.push(ValidationIssue {
                table: table_name.to_string(),
                column: None,
                issue_type: "missing_table".to_string(),
                detail: format!("缺少表: {}", table_name),
            });
            continue;
        }

        // 2. 检查每张表的列是否齐全
        let cols_sql = &format!("PRAGMA table_info({})", table_name);
        let mut col_stmt = conn.prepare(cols_sql).map_err(|e| AppError::Business(format!("准备 PRAGMA 失败: {}", e)))?;
        let existing_cols: Vec<String> = col_stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| AppError::Business(format!("查询列信息失败: {}", e)))?
            .filter_map(|r| r.ok())
            .collect();

        for expected in *expected_cols {
            if !existing_cols.contains(&expected.to_string()) {
                issues.push(ValidationIssue {
                    table: table_name.to_string(),
                    column: Some(expected.to_string()),
                    issue_type: "missing_column".to_string(),
                    detail: format!("表 {} 缺少列: {}", table_name, expected),
                });
            }
        }
    }

    // 3. PRAGMA integrity_check 数据完整性校验
    let integrity_result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| AppError::Business(format!("完整性校验失败: {}", e)))?;
    if integrity_result != "ok" {
        for line in integrity_result.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                issues.push(ValidationIssue {
                    table: "-".to_string(),
                    column: None,
                    issue_type: "integrity_error".to_string(),
                    detail: trimmed.to_string(),
                });
            }
        }
    }

    // 4. 外键孤儿检测
    let orphan_checks: &[(&str, &str, &str)] = &[
        ("volumes", "book_id", "SELECT COUNT(*) FROM volumes WHERE book_id NOT IN (SELECT id FROM books)"),
        ("chapters", "book_id", "SELECT COUNT(*) FROM chapters WHERE book_id NOT IN (SELECT id FROM books)"),
        ("chapters", "volume_id", "SELECT COUNT(*) FROM chapters WHERE volume_id IS NOT NULL AND volume_id NOT IN (SELECT id FROM volumes)"),
        ("snapshots", "chapter_id", "SELECT COUNT(*) FROM snapshots WHERE chapter_id NOT IN (SELECT id FROM chapters)"),
        ("world_cards", "book_id", "SELECT COUNT(*) FROM world_cards WHERE book_id NOT IN (SELECT id FROM books)"),
    ];

    for (table, column, sql) in orphan_checks {
        let count: i64 = conn
            .query_row(sql, [], |row| row.get(0))
            .unwrap_or(0);
        if count > 0 {
            issues.push(ValidationIssue {
                table: table.to_string(),
                column: Some(column.to_string()),
                issue_type: "orphan_record".to_string(),
                detail: format!(
                    "{} 中有 {} 条记录的 {} 指向不存在的记录",
                    table, count, column
                ),
            });
        }
    }

    Ok(ValidationResult {
        ok: issues.is_empty(),
        tables_count,
        issues,
    })
}
