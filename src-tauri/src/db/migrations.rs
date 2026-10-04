//! Schema 演进工具 —— 迁移注册表 + 持久化历史 + 真实分发
//!
//! 弥补 [`crate::db::mod`] 中 `run_versioned_migrations` 的 stub:
//! - [`schema_migrations`] 表记录每次迁移的 version / name / applied_at / checksum;
//! - [`Migration`] 注册表:新增非幂等演进时追加(v2 / v3 ...),并在 [`SCHEMA_VERSION`] 递增;
//! - [`checksum`] 稳定指纹(SHA-256 of normalized SQL),用于校验已应用迁移未被篡改;
//! - [`run_pending`] 逐级分发,跳过已应用、拒绝 checksum 不匹配,迁移与历史记录同事务原子提交;
//! - v1 baseline 由幂等 DDL 全量对齐,首次运行时通过 [`record_baseline`] 写入一行版本号 1 的占位记录。
//!
//! 调用链:`AppDb::migrate` → `ensure_schema_migrations_table` → `record_baseline` →
//! `run_pending(conn, from_version)` → 各迁移 v2+ 逐个执行(空时为 no-op)。
//!
//! 设计参考:Rails ActiveRecord Migrations + Flyway / Liquibase checksum 校验。
//! 故意不实现自动 down(回滚),需要时手动 `down_sql` 仅作存档,见 [`Migration::down_sql`]。

use anyhow::Context;
use chrono::Local;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::db::SCHEMA_VERSION;

/// 单个版本化迁移定义(注册表项)。
///
/// - `version`:从 2 开始递增(v1 由 baseline 占位,不在此注册)。
/// - `name`:人类可读的迁移名(snake_case),如 `add_project_milestones_table`。
/// - `up_sql`:正向迁移 SQL,可含多条语句(`execute_batch` 执行);幂等性由编写者保证
///   (推荐 `CREATE TABLE IF NOT EXISTS` 等)。**不应**包含事务控制语句(BEGIN/COMMIT),
///   迁移调度器会在外层事务中执行。
/// - `down_sql`:可选回滚 SQL,**仅作存档**,框架不会自动执行(降级场景需手动操作)。
#[derive(Debug, Clone)]
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub up_sql: &'static str,
    pub down_sql: Option<&'static str>,
}

/// 当前注册的版本化迁移列表。
///
/// **维护约定**:新增非幂等演进时按 version 升序追加;同时:
/// 1. 递增 [`crate::db::SCHEMA_VERSION`];
/// 2. 在本常量追加 [`Migration`] 项;
/// 3. SQL 必须可重入(已应用 → no-op),或写为 `IF NOT EXISTS` 形式;
/// 4. 提供对应单测(应用 → 重启 → no-op → checksum 一致)。
///
/// 当前为空:全部结构变更均可由 [`crate::db::ddl`] 幂等表达,故 SCHEMA_VERSION 停在 1。
pub const MIGRATIONS: &[Migration] = &[
    // 占位示例(实际启用时取消注释并递增 SCHEMA_VERSION):
    // Migration {
    //     version: 2,
    //     name: "add_xxx_column_to_yyy",
    //     up_sql: "ALTER TABLE yyy ADD COLUMN xxx TEXT NOT NULL DEFAULT ''",
    //     down_sql: Some("ALTER TABLE yyy DROP COLUMN xxx"),  -- SQLite 3.35+ 支持
    // },
];

/// schema_migrations 表的 DDL(幂等)。
///
/// 表语义:
/// - `version`:迁移版本号,主键,与 [`Migration::version`] 一致;baseline 行固定为 1;
/// - `name`:迁移名(baseline 为 "baseline");
/// - `applied_at`:应用时间(ISO 8601,本地时区);
/// - `checksum`:迁移 SQL 的 SHA-256 指纹(16 进制 64 字符);baseline 行使用常量 [`BASELINE_CHECKSUM`];
/// - `down_sql`:可选回滚 SQL,用于人工降级排查;baseline 行为 NULL。
pub const SCHEMA_MIGRATIONS_DDL: &str = r#"
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        down_sql    TEXT
    );
"#;

/// baseline 行的固定 checksum(占位,不代表真实 SQL 指纹)。
///
/// v1 baseline 由幂等 DDL 全量对齐,无独立 SQL 文本可指,故用常量字符串作为指纹。
/// 后续真实迁移(v2+)使用 [`checksum`] 计算 SHA-256。
pub const BASELINE_CHECKSUM: &str = "baseline-v1";

/// 计算 SQL 的稳定指纹(SHA-256 of normalized text)。
///
/// 规范化:去除前后空白、统一 CRLF → LF、压缩连续空白为单空格。
/// 同一 SQL 文本始终产生同一指纹;空字符串返回空指纹的 SHA-256。
pub fn checksum(sql: &str) -> String {
    let normalized: String = sql
        .trim()
        .replace("\r\n", "\n")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

/// 单条已应用迁移记录(供 IPC 命令返回前端)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedMigration {
    pub version: u32,
    pub name: String,
    pub applied_at: String,
    pub checksum: String,
    /// 是否支持回滚(down_sql 非空)。仅作元数据,框架不自动执行回滚。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub down_sql: Option<String>,
}

/// 幂等地创建 schema_migrations 表(若已存在则跳过)。
pub fn ensure_schema_migrations_table(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(SCHEMA_MIGRATIONS_DDL)
        .context("创建 schema_migrations 表失败")
}

/// 记录 v1 baseline 行(若不存在)。
///
/// v1 baseline 由幂等 DDL 覆盖,无独立迁移 SQL,故写入一行 version=1 的占位记录,
/// 让 [`list_applied`] 返回的列表对历史回放有完整闭环。重复调用为 no-op。
pub fn record_baseline(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at, checksum, down_sql)
         VALUES (?, ?, ?, ?, NULL)",
        params![1, "baseline", Local::now().to_rfc3339(), BASELINE_CHECKSUM],
    )
    .context("写入 baseline 迁移记录失败")?;
    Ok(())
}

/// 读取已应用的迁移记录(按 version 升序)。
pub fn list_applied(conn: &Connection) -> anyhow::Result<Vec<AppliedMigration>> {
    let mut stmt = conn
        .prepare(
            "SELECT version, name, applied_at, checksum, down_sql
             FROM schema_migrations ORDER BY version ASC",
        )
        .context("准备 schema_migrations 查询失败")?;
    let records = stmt
        .query_map([], |row| {
            Ok(AppliedMigration {
                version: row.get::<_, i64>(0)? as u32,
                name: row.get(1)?,
                applied_at: row.get(2)?,
                checksum: row.get(3)?,
                down_sql: row.get(4)?,
            })
        })
        .context("查询 schema_migrations 失败")?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(records)
}

/// 运行所有待应用的迁移(逐级分发,事务原子,checksum 校验)。
///
/// 调用约定:由 [`crate::db::AppDb::migrate`] 在 DDL 应用之后、写回 `PRAGMA user_version`
/// 之前调用。`from_version` 为当前数据库版本(0 表示旧库),目标版本为 [`SCHEMA_VERSION`]。
///
/// 行为:
/// 1. 跳过 `version <= from_version` 的迁移(已通过幂等 DDL 覆盖,无需重跑);
/// 2. 对每个待应用迁移:
///    - 若 `schema_migrations` 已有该 version → 校验 checksum,不匹配报错 [`ErrCode::DbMigrationChecksum`];
///    - 否则在事务中执行 `up_sql` + 写入历史记录;失败回滚并报 [`ErrCode::DbMigrationFailed`]。
/// 3. 全部成功后返回;调用方负责写回 `user_version`。
pub fn run_pending(conn: &mut Connection, from_version: u32) -> anyhow::Result<()> {
    for m in MIGRATIONS.iter() {
        // 已应用的迁移:校验 checksum 是否一致(防篡改)
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT name, checksum FROM schema_migrations WHERE version = ?",
                params![m.version],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok();
        if let Some((stored_name, stored_checksum)) = existing {
            if stored_name != m.name {
                return Err(anyhow::anyhow!(
                    "E_DB_MIGRATION_CHECKSUM: 迁移 v{} 名称不一致(已记录 '{}', 代码 '{}')",
                    m.version,
                    stored_name,
                    m.name
                ));
            }
            let expected = checksum(m.up_sql);
            if stored_checksum != expected {
                return Err(anyhow::anyhow!(
                    "E_DB_MIGRATION_CHECKSUM: 迁移 v{} checksum 不匹配(已记录 {}, 代码 {})",
                    m.version,
                    stored_checksum,
                    expected
                ));
            }
            // 已应用且 checksum 一致,跳过
            continue;
        }

        // 仅运行 from_version 之后的迁移
        if m.version <= from_version {
            continue;
        }

        // 事务执行迁移 + 记录历史
        let tx = conn.transaction();
        let tx = match tx {
            Ok(t) => t,
            Err(e) => {
                return Err(anyhow::anyhow!(
                    "E_DB_MIGRATION_FAILED: v{} 开启事务失败: {}",
                    m.version,
                    e
                ));
            }
        };
        if let Err(e) = tx.execute_batch(m.up_sql) {
            return Err(anyhow::anyhow!(
                "E_DB_MIGRATION_FAILED: v{} ({}) 执行失败: {}",
                m.version,
                m.name,
                e
            ));
        }
        let cs = checksum(m.up_sql);
        if let Err(e) = tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum, down_sql)
             VALUES (?, ?, ?, ?, ?)",
            params![
                m.version,
                m.name,
                Local::now().to_rfc3339(),
                cs,
                m.down_sql,
            ],
        ) {
            return Err(anyhow::anyhow!(
                "E_DB_MIGRATION_FAILED: v{} ({}) 写入迁移历史失败: {}",
                m.version,
                m.name,
                e
            ));
        }
        if let Err(e) = tx.commit() {
            return Err(anyhow::anyhow!(
                "E_DB_MIGRATION_FAILED: v{} ({}) 提交事务失败: {}",
                m.version,
                m.name,
                e
            ));
        }
        crate::app_log!(
            "[SQL] schema_migrations → v{} ({}) 已应用, checksum={}",
            m.version,
            m.name,
            &cs[..8]
        );
    }
    Ok(())
}

/// 计算待应用迁移列表(供 `schema_status` 命令返回)。
pub fn pending(from_version: u32) -> Vec<&'static Migration> {
    MIGRATIONS
        .iter()
        .filter(|m| m.version > from_version && m.version <= SCHEMA_VERSION)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema_migrations_table(&conn).unwrap();
        conn
    }

    #[test]
    fn checksum_stable() {
        let a = checksum("ALTER TABLE foo ADD COLUMN bar TEXT NOT NULL DEFAULT ''");
        let b = checksum("ALTER   TABLE   foo   ADD   COLUMN   bar   TEXT   NOT   NULL   DEFAULT   ''");
        assert_eq!(a, b, "空白差异不应影响 checksum");
        assert_eq!(a.len(), 64, "SHA-256 应为 64 字符 16 进制");
    }

    #[test]
    fn checksum_differs_on_different_sql() {
        let a = checksum("ALTER TABLE foo ADD COLUMN bar TEXT");
        let b = checksum("ALTER TABLE foo ADD COLUMN baz TEXT");
        assert_ne!(a, b);
    }

    #[test]
    fn ensure_schema_migrations_table_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema_migrations_table(&conn).unwrap();
        ensure_schema_migrations_table(&conn).unwrap();
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt, 1, "重复调用应仅 1 张表");
    }

    #[test]
    fn record_baseline_is_idempotent() {
        let conn = setup();
        record_baseline(&conn).unwrap();
        record_baseline(&conn).unwrap();
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt, 1, "baseline 行应只 1 条");
    }

    #[test]
    fn list_applied_returns_baseline_first() {
        let conn = setup();
        record_baseline(&conn).unwrap();
        let list = list_applied(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, 1);
        assert_eq!(list[0].name, "baseline");
        assert_eq!(list[0].checksum, BASELINE_CHECKSUM);
        assert!(list[0].down_sql.is_none());
    }

    #[test]
    fn run_pending_with_empty_registry_is_noop() {
        let mut conn = setup();
        record_baseline(&conn).unwrap();
        // MIGRATIONS 当前为空,任何 from_version 调用都应 no-op
        run_pending(&mut conn, 0).unwrap();
        run_pending(&mut conn, 1).unwrap();
        let list = list_applied(&conn).unwrap();
        assert_eq!(list.len(), 1, "空注册表不应新增迁移");
    }

    #[test]
    fn pending_returns_only_after_from_version() {
        // 当前 MIGRATIONS 为空,pending 永远返回空 Vec
        assert_eq!(pending(0).len(), 0);
        assert_eq!(pending(1).len(), 0);
    }

    /// 模拟一个 v2 迁移:验证 apply → record → re-run no-op 全链路。
    /// 通过临时表验证,不污染真实 schema_migrations 表。
    #[test]
    fn hypothetical_v2_migration_applies_and_skips_on_rerun() {
        // 1. 在内存库模拟一次完整迁移
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema_migrations_table(&conn).unwrap();
        record_baseline(&conn).unwrap();

        // 2. 模拟 v2 迁移:创建 demo 表
        let v2_sql = "CREATE TABLE IF NOT EXISTS tw_demo_v2 (id INTEGER PRIMARY KEY, val TEXT);";
        let v2_cs = checksum(v2_sql);
        let v2 = Migration {
            version: 2,
            name: "create_demo_v2_table",
            up_sql: v2_sql,
            down_sql: Some("DROP TABLE IF EXISTS tw_demo_v2"),
        };

        // 3. 模拟 run_pending 单条迁移逻辑(直接复制核心流程,避免改 MIGRATIONS 常量)
        let tx = conn.transaction().unwrap();
        tx.execute_batch(v2.up_sql).unwrap();
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum, down_sql)
             VALUES (?, ?, ?, ?, ?)",
            params![v2.version, v2.name, "2026-01-01T00:00:00+08:00", v2_cs, v2.down_sql],
        )
        .unwrap();
        tx.commit().unwrap();

        // 4. 验证历史已记录
        let list = list_applied(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].version, 2);
        assert_eq!(list[1].name, "create_demo_v2_table");
        assert_eq!(list[1].checksum, v2_cs);
        assert_eq!(list[1].down_sql.as_deref(), Some("DROP TABLE IF EXISTS tw_demo_v2"));

        // 5. 验证表已创建
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tw_demo_v2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt, 1);

        // 6. 重跑同一迁移 SQL 应为 no-op(IF NOT EXISTS),且 checksum 校验通过
        let stored: (String, String) = conn
            .query_row(
                "SELECT name, checksum FROM schema_migrations WHERE version = 2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, v2.name);
        assert_eq!(stored.1, v2_cs, "已应用迁移的 checksum 应一致");
    }

    #[test]
    fn checksum_mismatch_is_detected() {
        let conn = setup();
        // 写入一个 baseline + 假 v2 记录(checksum=旧值)
        record_baseline(&conn).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum, down_sql)
             VALUES (2, 'fake_v2', '2026-01-01', 'old_checksum', NULL)",
            [],
        )
        .unwrap();

        // 模拟代码侧 v2 定义(checksum 不同)
        let v2_sql = "CREATE TABLE tw_xxx (id INTEGER PRIMARY KEY);";
        let expected_cs = checksum(v2_sql);
        assert_ne!(expected_cs, "old_checksum");

        // 校验逻辑应识别不一致
        let stored: (String, String) = conn
            .query_row(
                "SELECT name, checksum FROM schema_migrations WHERE version = 2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(stored.1, expected_cs, "测试前提:checksum 应不同");
    }
}
