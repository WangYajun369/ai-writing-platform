//! 全量/单作品数据备份与恢复
//!
//! 通过加密的 `.tw` 文件进行完整数据迁移。查询操作统一委托给 Repository 层，避免在多处重复 SQL。
//!
//! 子模块划分：
//! - `types` —— 共享类型与常量（v2 载荷 / ImportScope / ImportStrategy / WriteStats / 指纹工具）
//! - `export` —— 全量/单作品数据装载与加密载荷写出（临时文件 + rename 原子替换）
//! - `import` —— 只读载入校验（版本/结构/引用/行数）+ replace/merge/fill-gaps 三策略写入
//! - `import_log` —— v2 载荷内容指纹与 import_log 幂等日志（滚动 20 条）
//! - `reconcile` —— 备份 vs 目标库只读对账（matched/missing/targetStale/targetNewer）
//! - `rollback` —— 导入回退点（克隆表快照 / 24h 过期清理 / 回滚执行）
//!
//! 本文件保留 5 个 IPC 命令入口（export_all_data / export_single_book / import_backup /
//! inspect_backup / rollback_import）与全部单元测试。

mod export;
mod import;
mod import_log;
mod reconcile;
mod rollback;
mod types;

// 子模块内部项的统一出口（命令与测试使用；prune_expired_rollbacks 另供 lib.rs 后台清理调用）
pub(crate) use export::{build_and_write_payload, filter_single_book_data, load_full_export_data};
pub(crate) use import::{
    load_backup_payload, run_full_import, run_single_import, run_upsert_import, validate_references,
};
#[cfg(test)]
pub(crate) use import::{apply_upsert_data, check_supported_version};
pub(crate) use import_log::{record_import_success, verified_payload_hash};
pub(crate) use import_log::lookup_import_log;
#[cfg(test)]
pub(crate) use import_log::{database_canonical_hash, record_import_log};
pub(crate) use reconcile::reconcile_backup;
pub use rollback::prune_expired_rollbacks;
pub(crate) use rollback::{
    execute_rollback, insert_rollback_log, new_rollback_ts, snapshot_scope,
};
#[cfg(test)]
pub(crate) use rollback::{clear_book_scope, clear_full_tables, get_rollback_log};
pub(crate) use types::{ImportScope, ImportStrategy};
#[cfg(test)]
pub(crate) use types::ExportPayload;

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::embedding_repo;
#[cfg(test)]
use chrono::Utc;
#[cfg(test)]
use rusqlite::params;
use tauri::{AppHandle, State};

// ---- 全量数据导出 ----

/// 导出全部数据（数据库 + 前端缓存）为加密的 `.tw` 文件
#[tauri::command]
pub async fn export_all_data(
    app: AppHandle,
    db: State<'_, AppDb>,
    output_path: String,
    cache_json: String,
) -> Result<(), AppError> {
    let _guard = super::try_acquire_io_lock()?;
    let conn = db.pool.get()?;
    let database = load_full_export_data(&app, &conn)?;
    let cache: serde_json::Value = serde_json::from_str(&cache_json)
        .map_err(|e| AppError::Business(format!("E_BACKUP_CACHE：缓存数据解析失败: {}", e)))?;

    build_and_write_payload("full", database, cache, &output_path)
}

// ---- 单作品导出 ----

/// 导出单个作品的完整数据为加密的 `.tw` 文件
#[tauri::command]
pub async fn export_single_book(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    output_path: String,
    cache_json: String,
) -> Result<(), AppError> {
    let _guard = super::try_acquire_io_lock()?;
    let conn = db.pool.get()?;
    let full_data = load_full_export_data(&app, &conn)?;
    let database = filter_single_book_data(&full_data, &book_id);
    let cache: serde_json::Value = serde_json::from_str(&cache_json)
        .map_err(|e| AppError::Business(format!("E_BACKUP_CACHE：缓存数据解析失败: {}", e)))?;

    build_and_write_payload("single", database, cache, &output_path)
}

/// 统一数据导入命令（Spec §5.4：策略化写入）
///
/// - `strategy` 可选：`replace`（默认，清空重建 + 回退点）/ `merge` / `fill-gaps`（非破坏性）。
/// - 引用完整性校验失败即拒绝（零写入）；merge/fill-gaps 采用单事务，失败整体回滚。
#[tauri::command]
pub async fn import_backup(
    app: AppHandle,
    db: State<'_, AppDb>,
    file_path: String,
    strategy: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let _guard = super::try_acquire_io_lock()?;
    let import_strategy = ImportStrategy::parse(strategy.as_deref())?;

    // 只读载入与校验（文件级 → 解密 → 结构 → 行数 → 语义），任何失败零写入
    let (payload, file_size) = load_backup_payload(&file_path)?;

    // ④ 幂等前提：v2 载荷指纹校验（内容与声明不符 → 拒绝；v1 无指纹 → None）
    let payload_hash = verified_payload_hash(&payload)?;

    // ③ 引用完整性校验：存在悬空引用/重复 id → 拒绝导入（零写入，清单精确到 id）
    let issues = validate_references(&payload.database);
    if !issues.is_empty() {
        let mut detail = issues
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("；");
        if issues.len() > 5 {
            detail.push_str(&format!("；…等共 {} 项", issues.len()));
        }
        return Err(AppError::Business(format!(
            "E_BACKUP_REFERENCE：备份存在引用完整性问题，已拒绝导入（目标库未受影响）：{}",
            detail
        )));
    }

    let mut conn = db.pool.get()?;
    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // 非破坏性策略（merge / fill-gaps）：不清空、不快照，单事务逐行写入
    if import_strategy != ImportStrategy::Replace {
        let value = run_upsert_import(&app, &mut conn, &payload, import_strategy)?;
        // 导入日志：仅在事务成功提交后写入（幂等判定基础；仅 v2 载荷）
        record_import_success(&conn, &payload, &payload_hash, &file_name, file_size)?;
        return Ok(value);
    }

    // replace：清空重建 + 事务内回退点快照（可撤销）
    let backup_type = payload.backup_type.clone();
    match backup_type.as_str() {
        "full" => {
            emit_sql_log(
                &app,
                "BEGIN",
                "transaction",
                "full import transaction",
                file!(),
                line!(),
            );
            let tx = conn
                .transaction()
                .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：开始事务失败: {}", e)))?;

            // 事务内、删除前创建回退点快照（与导入同事务：失败自动回滚消失）
            let scope = ImportScope::Full;
            let rollback_ts = new_rollback_ts();
            if let Err(e) = snapshot_scope(&tx, &rollback_ts, &scope)
                .and_then(|_| insert_rollback_log(&tx, &rollback_ts, &scope, &file_name))
            {
                return Err(AppError::Business(format!(
                    "E_BACKUP_TXN：导入失败（事务已回滚，原数据未受影响）：创建回退点失败 - {}",
                    e
                )));
            }

            match run_full_import(&app, &tx, &payload) {
                Ok(()) => {
                    emit_sql_log(
                        &app,
                        "COMMIT",
                        "transaction",
                        "full import committed",
                        file!(),
                        line!(),
                    );
                    tx.commit().map_err(|e| {
                        AppError::Business(format!("E_BACKUP_TXN：提交事务失败: {}", e))
                    })?;
                }
                Err(e) => {
                    emit_sql_log(
                        &app,
                        "ROLLBACK",
                        "transaction",
                        "full import rolled back (auto)",
                        file!(),
                        line!(),
                    );
                    return Err(AppError::Business(format!(
                        "E_BACKUP_TXN：导入失败（事务已回滚，原数据未受影响）：{}",
                        e
                    )));
                }
            }

            // 导入日志：仅在事务成功提交后写入（幂等判定基础；仅 v2 载荷）
            record_import_success(&conn, &payload, &payload_hash, &file_name, file_size)?;

            // vec0 镜像对齐（replace 后 embeddings 为空则无操作，幂等）
            if let Err(e) = embedding_repo::rebuild_chunks_vec(&conn) {
                crate::app_log_error!("[Backup] replace 后 vec 镜像对齐失败（忽略）: {}", e);
            }

            // 清理过期回退点（保留本机最近 24h 内的）
            if let Err(e) = prune_expired_rollbacks(&conn) {
                crate::app_log_error!("[Rollback] 过期回退点清理失败（忽略）: {}", e);
            }

            Ok(serde_json::json!({
                "cache": payload.cache,
                "backupType": "full",
                "strategy": "replace",
                "rollbackTs": rollback_ts,
            }))
        }
        "single" => {
            let book_id = payload.database.books[0].id.clone();

            emit_sql_log(
                &app,
                "BEGIN",
                "transaction",
                &format!("single import transaction for book_id={}", book_id),
                file!(),
                line!(),
            );
            let tx = conn
                .transaction()
                .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：开始事务失败: {}", e)))?;

            // 事务内、删除前创建回退点快照
            let scope = ImportScope::Single(book_id.clone());
            let rollback_ts = new_rollback_ts();
            if let Err(e) = snapshot_scope(&tx, &rollback_ts, &scope)
                .and_then(|_| insert_rollback_log(&tx, &rollback_ts, &scope, &file_name))
            {
                return Err(AppError::Business(format!(
                    "E_BACKUP_TXN：导入失败（事务已回滚，原数据未受影响）：创建回退点失败 - {}",
                    e
                )));
            }

            match run_single_import(&app, &tx, &payload, &book_id) {
                Ok(()) => {
                    emit_sql_log(
                        &app,
                        "COMMIT",
                        "transaction",
                        "single import committed",
                        file!(),
                        line!(),
                    );
                    tx.commit().map_err(|e| {
                        AppError::Business(format!("E_BACKUP_TXN：提交事务失败: {}", e))
                    })?;
                }
                Err(e) => {
                    emit_sql_log(
                        &app,
                        "ROLLBACK",
                        "transaction",
                        "single import rolled back (auto)",
                        file!(),
                        line!(),
                    );
                    return Err(AppError::Business(format!(
                        "E_BACKUP_TXN：导入失败（事务已回滚，原数据未受影响）：{}",
                        e
                    )));
                }
            }

            // 导入日志：仅在事务成功提交后写入（幂等判定基础；仅 v2 载荷）
            record_import_success(&conn, &payload, &payload_hash, &file_name, file_size)?;

            // vec0 镜像对齐
            if let Err(e) = embedding_repo::rebuild_chunks_vec(&conn) {
                crate::app_log_error!("[Backup] replace 后 vec 镜像对齐失败（忽略）: {}", e);
            }

            // 清理过期回退点
            if let Err(e) = prune_expired_rollbacks(&conn) {
                crate::app_log_error!("[Rollback] 过期回退点清理失败（忽略）: {}", e);
            }

            Ok(serde_json::json!({
                "cache": payload.cache,
                "backupType": "single",
                "strategy": "replace",
                "rollbackTs": rollback_ts,
            }))
        }
        _ => Err(AppError::Business(format!(
            "E_BACKUP_TYPE：不支持的备份类型：\"{}\"",
            backup_type
        ))),
    }
}

/// 只读预检备份文件（① 文件级 → ② 解密 → ③ 结构/引用 → ④ 幂等判定(import_log) → ⑤ 目标库对账，
/// Spec §5.1 / §5.2）。
///
/// 不写库、不创建回退点；报告含 `duplicateOf`（曾导入提示）与逐表对账清单，供导入预览对话框使用。
#[tauri::command]
pub async fn inspect_backup(
    db: State<'_, AppDb>,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    let (payload, file_size) = load_backup_payload(&file_path)?;

    // ③ 引用完整性（只读收集；指纹不符视为文件问题一并列出，而非中断只读预检）
    let mut issues = validate_references(&payload.database);
    let payload_hash = match verified_payload_hash(&payload) {
        Ok(h) => h,
        Err(e) => {
            issues.push(e.to_string());
            None
        }
    };

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let counts = serde_json::json!({
        "books": payload.database.books.len(),
        "volumes": payload.database.volumes.len(),
        "chapters": payload.database.chapters.len(),
        "snapshots": payload.database.snapshots.len(),
        "worldCards": payload.database.world_cards.len(),
        "embeddings": payload.database.embeddings.len(),
    });

    let single_book = if payload.backup_type == "single" {
        payload
            .database
            .books
            .first()
            .map(|b| serde_json::json!({ "id": b.id, "title": b.title }))
    } else {
        None
    };

    // ④ 幂等判定：v2 指纹 + 类型 + 文件大小命中 import_log → 提示曾导入时间与文件名
    let conn = db.pool.get()?;
    let duplicate_of = match (&payload_hash, payload.backup_type.as_str()) {
        (Some(hash), bt) => {
            lookup_import_log(&conn, hash, bt, file_size as i64)?.map(|(imported_at, fname)| {
                serde_json::json!({ "importedAt": imported_at, "fileName": fname })
            })
        }
        _ => None,
    };

    // ⑤ 目标库对账（只读；single 载荷本身已按书过滤，天然限定范围）
    let reconcile = reconcile_backup(&conn, &payload.database)?;

    Ok(serde_json::json!({
        "ok": issues.is_empty(),
        "backupType": payload.backup_type,
        "fileName": file_name,
        "fileSizeBytes": file_size,
        "counts": counts,
        "singleBook": single_book,
        "issues": issues,
        "payloadHash": payload_hash,
        "duplicateOf": duplicate_of,
        "reconcile": reconcile,
    }))
}

// ---- 导入撤销（回退点） ----

/// 撤销一次导入：将数据库恢复至该回退点快照（导入前状态）。
///
/// 回退点在每次 replace 语义导入（full / single）成功提交时自动创建，
/// 保留 24 小时；本命令执行后回退点即被消费删除。
#[tauri::command]
pub async fn rollback_import(
    app: AppHandle,
    db: State<'_, AppDb>,
    ts: String,
) -> Result<serde_json::Value, AppError> {
    let _guard = super::try_acquire_io_lock()?;
    let mut conn = db.pool.get()?;
    emit_sql_log(
        &app,
        "BEGIN",
        "transaction",
        &format!("rollback import ts={}", ts),
        file!(),
        line!(),
    );
    execute_rollback(&mut conn, &ts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        // 注册 sqlite-vec 扩展（进程级，幂等），保证 embedding 相关函数可安全探测
        let _ = crate::db::register_sqlite_vec_extension();
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL);
            CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT NOT NULL);
            CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, volume_id TEXT);
            CREATE TABLE snapshots (id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL);
            CREATE TABLE world_cards (id TEXT PRIMARY KEY, book_id TEXT NOT NULL);
            CREATE TABLE embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                embedding BLOB NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(source_type, source_id)
            );
            CREATE TABLE import_rollback_log (
                ts TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                file_name TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            "#,
        )
        .expect("create test schema");
        conn
    }

    fn insert_sample(conn: &Connection) {
        conn.execute(
            "INSERT INTO books (id,title) VALUES ('b1','甲'),('b2','乙')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO volumes (id,book_id) VALUES ('v1','b1'),('v2','b2')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chapters (id,book_id,volume_id) VALUES ('c1','b1','v1'),('c2','b2','v2')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO snapshots (id,chapter_id) VALUES ('s1','c1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO world_cards (id,book_id) VALUES ('w1','b1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embeddings (source_type,source_id,embedding) \
             VALUES ('chapter','c1',x'0000803f'),('chapter','c2',x'00008040')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn rollback_full_snapshot_and_restore() {
        let mut conn = test_conn();
        insert_sample(&conn);
        let ts = "test_full_1";
        snapshot_scope(&conn, ts, &ImportScope::Full).unwrap();
        insert_rollback_log(&conn, ts, &ImportScope::Full, "a.tw").unwrap();

        // 模拟导入后的新状态：清空并写入新书
        clear_full_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (id,title) VALUES ('b9','导入后新书')",
            [],
        )
        .unwrap();

        let out = execute_rollback(&mut conn, ts).unwrap();
        assert!(out["rolledBack"].as_bool().unwrap());

        let titles: Vec<String> = conn
            .prepare("SELECT title FROM books ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(titles, vec!["甲", "乙"]);

        // 回退点已消费、克隆表已删除
        assert!(get_rollback_log(&conn, ts).unwrap().is_none());
        let rb_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '__tw_rb_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rb_left, 0);
    }

    #[test]
    fn rollback_single_scope_only_touches_book() {
        let mut conn = test_conn();
        insert_sample(&conn);
        let ts = "test_single_1";
        snapshot_scope(&conn, ts, &ImportScope::Single("b1".to_string())).unwrap();
        insert_rollback_log(&conn, ts, &ImportScope::Single("b1".to_string()), "b1.tw").unwrap();

        // 模拟 b1 被单作品导入替换
        clear_book_scope(&conn, "b1").unwrap();
        conn.execute("INSERT INTO books (id,title) VALUES ('b1','甲-新')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO chapters (id,book_id,volume_id) VALUES ('c9','b1','v1')",
            [],
        )
        .unwrap();

        execute_rollback(&mut conn, ts).unwrap();

        // b1 恢复为旧内容，导入产生的新章节 c9 被撤销
        let b1_chapters: Vec<String> = conn
            .prepare("SELECT id FROM chapters WHERE book_id='b1' ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(b1_chapters, vec!["c1"]);

        // b2 不受影响
        let b2_chapters: Vec<String> = conn
            .prepare("SELECT id FROM chapters WHERE book_id='b2'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(b2_chapters, vec!["c2"]);
    }

    #[test]
    fn prune_expired_removes_old_points() {
        let conn = test_conn();
        snapshot_scope(&conn, "old_1", &ImportScope::Full).unwrap();
        let old = (Utc::now() - chrono::Duration::hours(25)).to_rfc3339();
        conn.execute(
            "INSERT INTO import_rollback_log (ts,scope,file_name,created_at) \
             VALUES ('old_1','full','x.tw',?1)",
            params![old],
        )
        .unwrap();

        snapshot_scope(&conn, "fresh_1", &ImportScope::Full).unwrap();
        conn.execute(
            "INSERT INTO import_rollback_log (ts,scope,file_name,created_at) \
             VALUES ('fresh_1','full','y.tw',?1)",
            params![Utc::now().to_rfc3339()],
        )
        .unwrap();

        let pruned = prune_expired_rollbacks(&conn).unwrap();
        assert_eq!(pruned, 1);
        assert!(get_rollback_log(&conn, "old_1").unwrap().is_none());
        assert!(get_rollback_log(&conn, "fresh_1").unwrap().is_some());
    }

    #[test]
    fn rollback_unknown_ts_is_rejected() {
        let mut conn = test_conn();
        let err = execute_rollback(&mut conn, "not_exists").unwrap_err();
        assert!(err.to_string().contains("不存在或已过期"));
    }

    // ---- Phase B：引用完整性校验 / merge / fill-gaps ----

    /// 建含全部列的测试库（apply_upsert_data 会读写全列）
    fn full_conn() -> Connection {
        let _ = crate::db::register_sqlite_vec_extension();
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '', cover_image TEXT, word_count INTEGER NOT NULL DEFAULT 0,
                daily_target INTEGER NOT NULL DEFAULT 0, today_count INTEGER NOT NULL DEFAULT 0,
                db_path TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
                outline TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE volumes (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL, title TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, deleted_at TEXT
            );
            CREATE TABLE chapters (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL, volume_id TEXT, title TEXT NOT NULL,
                content_html TEXT NOT NULL DEFAULT '', word_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'draft', sort_order INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                summary TEXT, summary_at TEXT, outline TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE snapshots (
                id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, content_html TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL DEFAULT 'auto',
                label TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE world_cards (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'misc',
                title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', content_html TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]', vectorized INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
                embedding BLOB NOT NULL, model TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(source_type, source_id)
            );
            CREATE TABLE import_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                payload_hash TEXT NOT NULL,
                file_name TEXT NOT NULL,
                backup_type TEXT NOT NULL,
                source_size INTEGER NOT NULL,
                imported_at TEXT NOT NULL
            );
            CREATE INDEX idx_import_log_hash ON import_log(payload_hash);
            "#,
        )
        .expect("create full schema");
        conn
    }

    /// 由 database 段 JSON 构造 ExportPayload（元数据字段用默认值）
    fn payload_from_db(db_json: serde_json::Value) -> ExportPayload {
        serde_json::from_value(serde_json::json!({
            "version": "1.0",
            "exportedAt": "2026-09-05T00:00:00Z",
            "backupType": "full",
            "database": db_json,
            "cache": {},
        }))
        .expect("payload 构造失败")
    }

    #[test]
    fn references_detect_dangling_ids() {
        let db_json = serde_json::json!({
            "books": [{ "id": "b1", "title": "甲", "author": "", "description": "", "coverImage": null,
                "wordCount": 0, "dailyTarget": 0, "todayCount": 0, "dbPath": "",
                "tags": [], "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "deletedAt": null, "outline": "" }],
            "volumes": [
                { "id": "v1", "bookId": "b1", "title": "卷一", "sortOrder": 0,
                  "createdAt": "2026-01-01T00:00:00Z", "deletedAt": null },
                { "id": "v2", "bookId": "no_such_book", "title": "悬空卷", "sortOrder": 1,
                  "createdAt": "2026-01-01T00:00:00Z", "deletedAt": null }
            ],
            "chapters": [
                { "id": "c1", "bookId": "b1", "volumeId": "v1", "title": "第一章", "contentHtml": "<p>x</p>",
                  "wordCount": 1, "status": "draft", "sortOrder": 0, "deletedAt": null,
                  "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                  "summary": null, "summaryAt": null, "outline": "" },
                { "id": "c2", "bookId": "b1", "volumeId": "no_such_volume", "title": "悬空章", "contentHtml": "",
                  "wordCount": 0, "status": "draft", "sortOrder": 1, "deletedAt": null,
                  "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                  "summary": null, "summaryAt": null, "outline": "" }
            ],
            "snapshots": [
                { "id": "s1", "chapterId": "c1", "contentHtml": "<p>s</p>", "wordCount": 1,
                  "type": "manual", "label": "v", "createdAt": "2026-01-01T00:00:00Z" },
                { "id": "s2", "chapterId": "no_such_chapter", "contentHtml": "", "wordCount": 0,
                  "type": "manual", "label": null, "createdAt": "2026-01-01T00:00:00Z" }
            ],
            "worldCards": [
                { "id": "w1", "bookId": "b1", "type": "char", "title": "人物", "content": "",
                  "contentHtml": "", "tags": [], "vectorized": false,
                  "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z" }
            ],
            "embeddings": [
                { "sourceType": "chapter", "sourceId": "c1", "model": "m", "createdAt": "2026-01-01T00:00:00Z" },
                { "sourceType": "world_card", "sourceId": "no_such_card", "model": "m", "createdAt": "2026-01-01T00:00:00Z" }
            ]
        });
        let payload = payload_from_db(db_json);
        let issues = validate_references(&payload.database);
        // 预期：v2 悬空、c2 卷悬空、s2 章悬空、w 之外的卡片向量悬空、共 4 类问题
        assert!(
            issues
                .iter()
                .any(|i| i.contains("v2") && i.contains("bookId=no_such_book")),
            "应检出悬空卷: {issues:?}"
        );
        assert!(
            issues
                .iter()
                .any(|i| i.contains("c2") && i.contains("no_such_volume")),
            "应检出悬空卷引用: {issues:?}"
        );
        assert!(
            issues
                .iter()
                .any(|i| i.contains("s2") && i.contains("no_such_chapter")),
            "应检出悬空快照: {issues:?}"
        );
        assert!(
            issues.iter().any(|i| i.contains("no_such_card")),
            "应检出悬空卡片向量: {issues:?}"
        );
    }

    #[test]
    fn references_pass_when_clean() {
        let db_json = serde_json::json!({
            "books": [{ "id": "b1", "title": "甲", "author": "", "description": "", "coverImage": null,
                "wordCount": 0, "dailyTarget": 0, "todayCount": 0, "dbPath": "",
                "tags": [], "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "deletedAt": null, "outline": "" }],
            "volumes": [], "chapters": [], "snapshots": [], "worldCards": [],
            "embeddings": []
        });
        let payload = payload_from_db(db_json);
        assert!(validate_references(&payload.database).is_empty());
    }

    fn insert_target_book(conn: &Connection, id: &str, title: &str, updated_at: &str) {
        conn.execute(
            "INSERT INTO books (id,title,author,description,word_count,daily_target,today_count,db_path,created_at,updated_at,outline) \
             VALUES (?1,?2,'','',0,0,0,'',?3,?4,'')",
            params![id, title, updated_at, updated_at],
        )
        .unwrap();
    }

    fn insert_target_chapter(
        conn: &Connection,
        id: &str,
        book_id: &str,
        title: &str,
        content: &str,
        updated_at: &str,
    ) {
        conn.execute(
            "INSERT INTO chapters (id,book_id,title,content_html,word_count,status,sort_order,created_at,updated_at,outline) \
             VALUES (?1,?2,?3,?4,0,'draft',0,?5,?5,'')",
            params![id, book_id, title, content, updated_at],
        )
        .unwrap();
    }

    /// 生成单书备份的 chapters 数组条目
    fn chapter_row(
        id: &str,
        book_id: &str,
        title: &str,
        content: &str,
        updated_at: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id, "bookId": book_id, "volumeId": null, "title": title,
            "contentHtml": format!("<p>{}</p>", content), "wordCount": 0, "status": "draft",
            "sortOrder": 0, "deletedAt": null,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": updated_at,
            "summary": null, "summaryAt": null, "outline": ""
        })
    }

    fn book_row(id: &str, title: &str, updated_at: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "title": title, "author": "", "description": "", "coverImage": null,
            "wordCount": 0, "dailyTarget": 0, "todayCount": 0, "dbPath": "",
            "tags": [], "createdAt": "2026-01-01T00:00:00Z", "updatedAt": updated_at,
            "deletedAt": null, "outline": ""
        })
    }

    #[test]
    fn merge_keeps_newer_target_but_updates_stale_target() {
        let conn = full_conn();
        // 目标库：b1 较旧（备份会覆盖）、c1 较旧（备份覆盖）、c2 较新（保留目标）、c3 缺失（插入）
        insert_target_book(&conn, "b1", "旧标题", "2026-09-01T00:00:00Z");
        insert_target_chapter(&conn, "c1", "b1", "旧章", "旧内容", "2026-09-01T00:00:00Z");
        insert_target_chapter(
            &conn,
            "c2",
            "b1",
            "目标新章",
            "目标新内容",
            "2026-09-08T00:00:00Z",
        );

        let db_json = serde_json::json!({
            "books": [book_row("b1", "备份新标题", "2026-09-05T00:00:00Z")],
            "volumes": [], "snapshots": [], "worldCards": [], "embeddings": [],
            "chapters": [
                chapter_row("c1", "b1", "备份新章", "备份新内容", "2026-09-05T00:00:00Z"),
                chapter_row("c2", "b1", "备份旧章", "备份旧内容", "2026-09-02T00:00:00Z"),
                chapter_row("c3", "b1", "备份新增章", "新增内容", "2026-09-05T00:00:00Z"),
            ]
        });
        let payload = payload_from_db(db_json);
        let stats = apply_upsert_data(&conn, &payload.database, false).unwrap();

        assert_eq!(stats["books"]["updated"], 1);
        assert_eq!(stats["chapters"]["inserted"], 1);
        assert_eq!(stats["chapters"]["updated"], 1);
        assert_eq!(stats["chapters"]["skipped"], 1);

        // b1 被备份覆盖
        let title: String = conn
            .query_row("SELECT title FROM books WHERE id='b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "备份新标题");
        // c1 覆盖为备份内容
        let c1: String = conn
            .query_row("SELECT content_html FROM chapters WHERE id='c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(c1, "<p>备份新内容</p>");
        // c2 保留目标库新内容（skipped）
        let c2: String = conn
            .query_row("SELECT content_html FROM chapters WHERE id='c2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(c2, "目标新内容");
        // c3 已插入
        let c3_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chapters WHERE id='c3'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(c3_count, 1);
    }

    #[test]
    fn fill_gaps_only_installs_missing_rows() {
        let conn = full_conn();
        insert_target_book(&conn, "b1", "目标标题", "2026-09-08T00:00:00Z");
        insert_target_chapter(
            &conn,
            "c1",
            "b1",
            "目标章",
            "目标内容",
            "2026-09-08T00:00:00Z",
        );

        let db_json = serde_json::json!({
            "books": [book_row("b1", "备份标题", "2026-09-05T00:00:00Z")],
            "volumes": [], "snapshots": [], "worldCards": [], "embeddings": [],
            "chapters": [
                chapter_row("c1", "b1", "备份章", "备份内容", "2026-09-05T00:00:00Z"),
                chapter_row("c2", "b1", "缺失章", "补缺内容", "2026-09-05T00:00:00Z"),
            ]
        });
        let payload = payload_from_db(db_json);
        let stats = apply_upsert_data(&conn, &payload.database, true).unwrap();

        assert_eq!(stats["books"]["skipped"], 1, "fill-gaps 不更新已存在书");
        assert_eq!(stats["chapters"]["inserted"], 1);
        assert_eq!(stats["chapters"]["skipped"], 1);

        // 目标库标题保持；c1 内容保持；c2 补齐
        let title: String = conn
            .query_row("SELECT title FROM books WHERE id='b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "目标标题");
        let c1: String = conn
            .query_row("SELECT content_html FROM chapters WHERE id='c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(c1, "目标内容");
        let c2_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chapters WHERE id='c2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(c2_count, 1);
    }

    #[test]
    fn single_merge_keeps_target_added_chapters() {
        let conn = full_conn();
        // 目标库该书：c1（备份也有，且备份更新）、c2（目标库新增，备份中不存在）
        insert_target_book(&conn, "b1", "目标标题", "2026-09-01T00:00:00Z");
        insert_target_chapter(&conn, "c1", "b1", "旧章", "旧内容", "2026-09-01T00:00:00Z");
        insert_target_chapter(
            &conn,
            "c2",
            "b1",
            "目标后写新增",
            "目标新增内容",
            "2026-09-09T00:00:00Z",
        );

        // 单书备份（backupType 在载荷中为 single 语义；apply 不关心，但内容仅 b1）
        let db_json = serde_json::json!({
            "books": [book_row("b1", "备份标题", "2026-09-05T00:00:00Z")],
            "volumes": [], "snapshots": [], "worldCards": [], "embeddings": [],
            "chapters": [chapter_row("c1", "b1", "备份章", "备份内容", "2026-09-05T00:00:00Z")]
        });
        let payload = payload_from_db(db_json);
        let stats = apply_upsert_data(&conn, &payload.database, false).unwrap();

        assert_eq!(stats["chapters"]["updated"], 1);
        // c2 不受影响：仍在且内容保留（merge 绝不删目标行）
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chapters WHERE book_id='b1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 2);
        let c2: String = conn
            .query_row("SELECT content_html FROM chapters WHERE id='c2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(c2, "目标新增内容");
    }

    // ---- Phase C：payloadHash / import_log / 对账 ----

    /// 构造 v2 载荷（database 同 p1），declared 为声明的 payloadHash 字段值
    fn payload_v2(db_json: &serde_json::Value, declared: &str) -> ExportPayload {
        serde_json::from_value(serde_json::json!({
            "version": "2.0",
            "schemaVersion": 2,
            "appVersion": "9.9.9",
            "exportedAt": "2099-01-01T00:00:00Z",
            "backupType": "single",
            "payloadHash": declared,
            "database": db_json,
            "cache": { "x": 1 },
        }))
        .expect("v2 payload 构造失败")
    }

    #[test]
    fn payload_hash_is_canonical_and_verified() {
        let db_json = serde_json::json!({
            "books": [book_row("b1", "甲", "2026-09-05T00:00:00Z")],
            "volumes": [], "snapshots": [], "worldCards": [], "embeddings": [], "chapters": []
        });
        // v1（无 payloadHash 字段）→ 不判重（None）
        let p1 = payload_from_db(db_json.clone());
        assert!(verified_payload_hash(&p1).unwrap().is_none());

        // 指纹排除 exportedAt / cache / backupType / appVersion / schemaVersion / payloadHash
        let h1 = database_canonical_hash(&p1).unwrap();
        assert_eq!(h1.len(), 64);
        let p2 = payload_v2(&db_json, "anything");
        assert_eq!(database_canonical_hash(&p2).unwrap(), h1);

        // 声明一致 → 通过并返回指纹
        let p3 = payload_v2(&db_json, &h1);
        assert_eq!(verified_payload_hash(&p3).unwrap(), Some(h1.clone()));

        // 篡改（声明与内容不符）→ 拒绝
        let p4 = payload_v2(&db_json, &"f".repeat(64));
        let err = verified_payload_hash(&p4).unwrap_err();
        assert!(err.to_string().contains("E_BACKUP_SCHEMA"), "{err}");
    }

    #[test]
    fn import_log_record_lookup_and_prune() {
        let conn = full_conn();
        record_import_log(&conn, "hashA", "a.tw", "full", 100).unwrap();
        record_import_log(&conn, "hashA", "a.tw", "full", 100).unwrap(); // 同一文件二次导入
        record_import_log(&conn, "hashA", "a2.tw", "full", 200).unwrap(); // 不同大小 → 不命中
        record_import_log(&conn, "hashA", "s.tw", "single", 100).unwrap(); // 不同类型 → 不命中
        record_import_log(&conn, "hashB", "b.tw", "full", 100).unwrap();

        // 命中最近一次同指纹+类型+大小
        let hit = lookup_import_log(&conn, "hashA", "full", 100)
            .unwrap()
            .expect("应命中最近一次导入");
        assert_eq!(hit.1, "a.tw");
        // 同指纹不同大小 → 不命中（辅助判定收敛误判）
        let hit2 = lookup_import_log(&conn, "hashA", "full", 200)
            .unwrap()
            .expect("200 行应命中");
        assert_eq!(hit2.1, "a2.tw");
        assert!(lookup_import_log(&conn, "hashA", "full", 300)
            .unwrap()
            .is_none());
        // 不同类型（full vs single）互不命中
        let hit3 = lookup_import_log(&conn, "hashA", "single", 100)
            .unwrap()
            .expect("single 行应命中");
        assert_eq!(hit3.1, "s.tw");
        assert!(lookup_import_log(&conn, "hashA", "single", 200)
            .unwrap()
            .is_none());
        assert!(lookup_import_log(&conn, "hashC", "full", 100)
            .unwrap()
            .is_none());

        // 滚动清理：仅保留最近 20 条
        for i in 0..25 {
            record_import_log(&conn, &format!("h{}", i), "x.tw", "full", 1).unwrap();
        }
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM import_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 20);
    }

    fn insert_target_volume(conn: &Connection, id: &str, book_id: &str, title: &str) {
        conn.execute(
            "INSERT INTO volumes (id,book_id,title,sort_order,created_at,deleted_at) \
             VALUES (?1,?2,?3,0,'2026-01-01T00:00:00Z',NULL)",
            params![id, book_id, title],
        )
        .unwrap();
    }

    fn insert_target_snapshot(conn: &Connection, id: &str, chapter_id: &str, content: &str) {
        conn.execute(
            "INSERT INTO snapshots (id,chapter_id,content_html,word_count,type,label,created_at) \
             VALUES (?1,?2,?3,0,'auto',NULL,'2026-01-01T00:00:00Z')",
            params![id, chapter_id, content],
        )
        .unwrap();
    }

    fn insert_target_world_card(
        conn: &Connection,
        id: &str,
        book_id: &str,
        title: &str,
        updated_at: &str,
    ) {
        conn.execute(
            "INSERT INTO world_cards (id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at) \
             VALUES (?1,?2,'char',?3,'','', '[]', 0, ?4, ?4)",
            params![id, book_id, title, updated_at],
        )
        .unwrap();
    }

    fn volume_row(id: &str, book_id: &str, title: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "bookId": book_id, "title": title, "sortOrder": 0,
            "createdAt": "2026-01-01T00:00:00Z", "deletedAt": null
        })
    }

    fn snapshot_row(id: &str, chapter_id: &str, content: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "chapterId": chapter_id, "contentHtml": content, "wordCount": 0,
            "type": "auto", "label": null, "createdAt": "2026-01-01T00:00:00Z"
        })
    }

    fn world_card_row(id: &str, book_id: &str, title: &str, updated_at: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "bookId": book_id, "type": "char", "title": title, "content": "",
            "contentHtml": "", "tags": [], "vectorized": false,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": updated_at
        })
    }

    #[test]
    fn reconcile_classifies_rows_across_tables() {
        let conn = full_conn();
        // 目标库现状（模拟「已有部分数据」）
        insert_target_book(&conn, "b1", "旧标题", "2026-09-01T00:00:00Z"); // 目标旧
        insert_target_book(&conn, "b2", "同", "2026-09-09T00:00:00Z"); // 与备份一致
        insert_target_chapter(&conn, "c1", "b1", "旧章", "旧", "2026-09-01T00:00:00Z");
        insert_target_chapter(
            &conn,
            "c2",
            "b1",
            "同章",
            "<p>同</p>",
            "2026-09-09T00:00:00Z",
        );
        insert_target_volume(&conn, "v1", "b1", "卷A旧"); // 与备份内容不同（无时钟）
        insert_target_volume(&conn, "v2", "b1", "卷C"); // 与备份一致
        insert_target_snapshot(&conn, "s1", "c2", "旧快照");
        insert_target_world_card(&conn, "w1", "b1", "目标新卡", "2026-09-09T00:00:00Z"); // 目标新
        insert_target_world_card(&conn, "w2", "b1", "旧卡", "2026-09-01T00:00:00Z"); // 目标旧

        let db_json = serde_json::json!({
            "books": [
                book_row("b1", "备份新标题", "2026-09-05T00:00:00Z"), // backup 新 → targetStale
                book_row("b2", "同", "2026-09-09T00:00:00Z"),          // matched
                book_row("b3", "备份独有", "2026-09-01T00:00:00Z"),    // missing
            ],
            "volumes": [
                volume_row("v1", "b1", "卷B新"), // 内容不同 → targetNewer（merge 保留目标）
                volume_row("v2", "b1", "卷C"),   // matched
                volume_row("v3", "b1", "卷D"),   // missing
            ],
            "chapters": [
                chapter_row("c1", "b1", "备份新章", "新", "2026-09-05T00:00:00Z"), // targetStale
                chapter_row("c2", "b1", "同章", "同", "2026-09-09T00:00:00Z"),     // matched
                chapter_row("c3", "b1", "备份独有章", "独", "2026-09-01T00:00:00Z"), // missing
            ],
            "snapshots": [
                snapshot_row("s1", "c2", "新快照"), // 内容不同 → targetNewer
                snapshot_row("s2", "c2", "补缺"),   // missing
            ],
            "worldCards": [
                world_card_row("w1", "b1", "备份旧卡", "2026-09-01T00:00:00Z"), // 目标新 → targetNewer
                world_card_row("w2", "b1", "备份新卡", "2026-09-05T00:00:00Z"), // 目标旧 → targetStale
                world_card_row("w3", "b1", "独有卡", "2026-09-01T00:00:00Z"),   // missing
            ],
            "embeddings": []
        });
        let payload = payload_from_db(db_json);
        let rep = reconcile_backup(&conn, &payload.database).unwrap();

        assert_eq!(rep.books.matched, 1);
        assert_eq!(rep.books.target_stale, 1);
        assert_eq!(rep.books.missing, 1);
        assert_eq!(rep.volumes.matched, 1);
        assert_eq!(rep.volumes.target_newer, 1);
        assert_eq!(rep.volumes.missing, 1);
        assert_eq!(rep.chapters.matched, 1);
        assert_eq!(rep.chapters.target_stale, 1);
        assert_eq!(rep.chapters.missing, 1);
        assert_eq!(rep.snapshots.target_newer, 1);
        assert_eq!(rep.snapshots.missing, 1);
        assert_eq!(rep.world_cards.target_stale, 1);
        assert_eq!(rep.world_cards.target_newer, 1);
        assert_eq!(rep.world_cards.missing, 1);
    }

    #[test]
    fn reconcile_after_identical_import_is_all_matched() {
        // 模拟「同一备份已成功导入一次」：目标库 = 备份内容，import_log 已记录
        let conn = full_conn();
        let db_json = serde_json::json!({
            "books": [book_row("b1", "甲", "2026-09-05T00:00:00Z")],
            "volumes": [volume_row("v1", "b1", "卷一")],
            "chapters": [chapter_row("c1", "b1", "第一章", "内容", "2026-09-05T00:00:00Z")],
            "snapshots": [snapshot_row("s1", "c1", "<p>快照</p>")],
            "worldCards": [world_card_row("w1", "b1", "人物", "2026-09-05T00:00:00Z")],
            "embeddings": []
        });
        let payload = payload_from_db(db_json);
        apply_upsert_data(&conn, &payload.database, false).unwrap();
        record_import_log(&conn, "hashX", "full.tw", "full", 1234).unwrap();

        let rep = reconcile_backup(&conn, &payload.database).unwrap();
        assert_eq!(rep.books.matched, 1);
        assert_eq!(rep.chapters.matched, 1);
        assert_eq!(rep.volumes.matched, 1);
        assert_eq!(rep.snapshots.matched, 1);
        assert_eq!(rep.world_cards.matched, 1);
        assert_eq!(rep.books.missing, 0);
        assert_eq!(rep.books.target_stale, 0);
        assert_eq!(rep.books.target_newer, 0);

        // 幂等判定命中 → duplicateOf 可展示「曾于 xx 导入」
        let hit = lookup_import_log(&conn, "hashX", "full", 1234)
            .unwrap()
            .unwrap();
        assert!(!hit.0.is_empty());
    }

    // ---- Phase F：版本守卫 + 命令级互斥 ----

    #[test]
    fn version_guard_rejects_future_major() {
        assert!(check_supported_version("1.0").is_ok());
        assert!(check_supported_version("2.0").is_ok());
        let e = check_supported_version("3.0").unwrap_err();
        assert!(e.to_string().contains("E_BACKUP_VERSION"), "{e}");
    }

    #[test]
    fn io_lock_is_single_flight_and_reentrant() {
        let g = crate::commands::io::try_acquire_io_lock().expect("首次占用成功");
        let err = crate::commands::io::try_acquire_io_lock().unwrap_err();
        assert!(err.to_string().contains("E_IO_BUSY"), "{err}");
        drop(g);
        let g2 = crate::commands::io::try_acquire_io_lock().expect("释放后可再占用");
        drop(g2);
    }
}
