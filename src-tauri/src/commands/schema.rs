//! Schema 演进工具 IPC 命令层
//!
//! 提供调试控制台 / 设置页查询当前数据库 schema 状态的能力:
//! - [`schema_status`]:当前版本 + 已应用迁移 + 待应用迁移(对比代码与库);
//! - [`schema_diff`]:对比 PRAGMA table_info 与 [`crate::db::schema::TABLE_SCHEMA`] 声明的列差异;
//! - [`schema_migrations_list`]:仅查已应用迁移历史(轻量,调试用)。
//!
//! 配套前端 `schemaApi` + `SchemaPanel`,可挂在调试控制台作为新面板。
//! 与原 [`crate::commands::window::validate::validate_database`] 互补:
//! validate_database 检查表/列/外键/integrity,本模块在此基础上额外提供
//! 版本化视角与代码侧声明的 diff。

use serde::Serialize;
use tauri::State;

use crate::db::{migrations, schema::TABLE_SCHEMA, schema_repo, AppDb, SCHEMA_VERSION};
use crate::error::AppError;

/// 待应用迁移(代码侧注册,库中尚未应用的版本)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMigration {
    pub version: u32,
    pub name: String,
    /// 完整 up_sql 的 SHA-256 指纹(规范化后),用于跨实例比对
    pub checksum: String,
}

/// Schema 状态总览(对应 `schema_status` 命令)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaStatus {
    /// 当前数据库结构版本(PRAGMA user_version)
    pub current_version: u32,
    /// 应用支持的最高版本(代码常量 SCHEMA_VERSION)
    pub latest_version: u32,
    /// 是否最新(当前版本 = 最新版本且无待应用迁移)
    pub up_to_date: bool,
    /// 已应用迁移清单(按 version 升序)
    pub applied_migrations: Vec<migrations::AppliedMigration>,
    /// 待应用迁移清单(代码侧已注册但库中未应用)
    pub pending_migrations: Vec<PendingMigration>,
}

/// 单条 schema diff 项(对应 `schema_diff` 命令)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffIssue {
    pub table: String,
    /// 缺失列名(代码声明但 PRAGMA 未发现)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_column: Option<String>,
    /// 多出列名(PRAGMA 有但代码未声明;新增列未同步 TABLE_SCHEMA 时出现)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_column: Option<String>,
    pub issue_type: String, // "missing_table" | "missing_column" | "extra_column"
    pub detail: String,
}

/// Schema diff 总结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiff {
    pub ok: bool,
    pub declared_tables_count: usize,
    pub actual_tables_count: usize,
    pub issues: Vec<SchemaDiffIssue>,
}

/// 查询当前 schema 状态:版本 + 已应用迁移 + 待应用迁移
#[tauri::command]
pub async fn schema_status(db: State<'_, AppDb>) -> Result<SchemaStatus, AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    let current_version = schema_repo::get_user_version(&conn).map_err(AppError::from)?;
    let applied = migrations::list_applied(&conn).map_err(AppError::from)?;

    // 计算 pending:代码注册表中 version > current_version 且未在 applied 中的迁移
    let applied_versions: std::collections::HashSet<u32> =
        applied.iter().map(|m| m.version).collect();
    let pending: Vec<PendingMigration> = migrations::MIGRATIONS
        .iter()
        .filter(|m| !applied_versions.contains(&m.version) && m.version > current_version)
        .map(|m| PendingMigration {
            version: m.version,
            name: m.name.to_string(),
            checksum: migrations::checksum(m.up_sql),
        })
        .collect();
    let up_to_date = current_version == SCHEMA_VERSION && pending.is_empty();

    Ok(SchemaStatus {
        current_version,
        latest_version: SCHEMA_VERSION,
        up_to_date,
        applied_migrations: applied,
        pending_migrations: pending,
    })
}

/// 对比 PRAGMA table_info 与代码声明 TABLE_SCHEMA,列出差异
#[tauri::command]
pub async fn schema_diff(db: State<'_, AppDb>) -> Result<SchemaDiff, AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    let mut issues = Vec::new();

    // 1. 取当前所有用户表
    let actual_tables = schema_repo::list_user_tables(&conn).map_err(AppError::from)?;
    let actual_tables_count = actual_tables.len();

    // 2. 逐个声明的表对比列
    for (table_name, expected_cols) in TABLE_SCHEMA {
        if !actual_tables.contains(&table_name.to_string()) {
            issues.push(SchemaDiffIssue {
                table: table_name.to_string(),
                missing_column: None,
                extra_column: None,
                issue_type: "missing_table".to_string(),
                detail: format!("缺少表: {}", table_name),
            });
            continue;
        }
        let actual_cols = schema_repo::list_table_columns(&conn, table_name)
            .map_err(AppError::from)?;

        for expected in *expected_cols {
            if !actual_cols.contains(&expected.to_string()) {
                issues.push(SchemaDiffIssue {
                    table: table_name.to_string(),
                    missing_column: Some(expected.to_string()),
                    extra_column: None,
                    issue_type: "missing_column".to_string(),
                    detail: format!("表 {} 缺少列: {}", table_name, expected),
                });
            }
        }
        for actual in &actual_cols {
            if !expected_cols.contains(&actual.as_str()) {
                issues.push(SchemaDiffIssue {
                    table: table_name.to_string(),
                    missing_column: None,
                    extra_column: Some(actual.clone()),
                    issue_type: "extra_column".to_string(),
                    detail: format!("表 {} 多出列: {}(代码未声明,需同步 TABLE_SCHEMA)", table_name, actual),
                });
            }
        }
    }

    Ok(SchemaDiff {
        ok: issues.is_empty(),
        declared_tables_count: TABLE_SCHEMA.len(),
        actual_tables_count,
        issues,
    })
}

/// 列出已应用迁移(轻量,调试控制台用)
#[tauri::command]
pub async fn schema_migrations_list(
    db: State<'_, AppDb>,
) -> Result<Vec<migrations::AppliedMigration>, AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    Ok(migrations::list_applied(&conn)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_status_serializes_camel_case() {
        let s = SchemaStatus {
            current_version: 1,
            latest_version: 1,
            up_to_date: true,
            applied_migrations: vec![],
            pending_migrations: vec![],
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["currentVersion"], 1);
        assert_eq!(json["upToDate"], true);
    }

    #[test]
    fn schema_diff_serializes_camel_case() {
        let d = SchemaDiff {
            ok: true,
            declared_tables_count: 5,
            actual_tables_count: 5,
            issues: vec![],
        };
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["declaredTablesCount"], 5);
    }
}
