//! 全量/单作品数据备份与恢复
//!
//! 通过加密的 `.tw` 文件进行完整数据迁移。
//! 查询操作统一委托给 Repository 层，避免在多处重复 SQL。

use super::crypto::{build_encrypted_file, parse_encrypted_file, validate_payload_structure};
use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Book, Snapshot, Volume, WorldCard};
use crate::repository::{
    book_repo, chapter_repo, embedding_repo, snapshot_repo, volume_repo, world_card_repo,
};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use tauri::{AppHandle, State};

// ==================== 导入回退点（运行态，24h 可撤销） ====================

/// 回退点保留时长：24 小时
const RB_TTL_HOURS: i64 = 24;

/// 备份文件大小上限：200 MB
const MAX_BACKUP_FILE_BYTES: u64 = 200 * 1024 * 1024;

/// 备份行数上限（超限拒绝，防超大事务与内存占用）
const MAX_BACKUP_ROWS: &[(&str, usize)] = &[
    ("books", 10_000),
    ("volumes", 50_000),
    ("chapters", 100_000),
    ("snapshots", 200_000),
    ("worldCards", 100_000),
    ("embeddings", 200_000),
];

/// 需要参与快照/回滚的表（顺序无关快照，恢复/清空按需排列）
const RB_TABLES: &[&str] = &[
    "books",
    "volumes",
    "chapters",
    "snapshots",
    "world_cards",
    "embeddings",
];

/// 导入作用域：全库或单个作品（与备份类型解耦，覆盖「replace 语义」的受影响范围）
#[derive(Clone, Debug)]
enum ImportScope {
    Full,
    Single(String),
}

impl ImportScope {
    fn as_str(&self) -> String {
        match self {
            ImportScope::Full => "full".to_string(),
            ImportScope::Single(id) => format!("single:{}", id),
        }
    }

    fn parse(s: &str) -> Option<ImportScope> {
        if s == "full" {
            Some(ImportScope::Full)
        } else if let Some(id) = s.strip_prefix("single:") {
            Some(ImportScope::Single(id.to_string()))
        } else {
            None
        }
    }
}

/// 回退点克隆表名：__tw_rb_{ts}_{table}
fn rb_table(ts: &str, table: &str) -> String {
    format!("__tw_rb_{}_{}", ts, table)
}

/// 生成新的回退点分组 id（UTC 纳秒戳，表名唯一性足够）
fn new_rollback_ts() -> String {
    format!("{}", Utc::now().timestamp_nanos_opt().unwrap_or_default())
}

/// 记录回退点元信息（须在快照表创建后、同一事务内调用）
fn insert_rollback_log(
    conn: &rusqlite::Connection,
    ts: &str,
    scope: &ImportScope,
    file_name: &str,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO import_rollback_log (ts, scope, file_name, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![ts, scope.as_str(), file_name, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// 读取回退点元信息
fn get_rollback_log(
    conn: &rusqlite::Connection,
    ts: &str,
) -> Result<Option<(String, String)>, AppError> {
    let mut stmt =
        conn.prepare("SELECT scope, file_name FROM import_rollback_log WHERE ts = ?1")?;
    let mut rows = stmt.query_map(params![ts], |r| Ok((r.get(0)?, r.get(1)?)))?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// 单作品作用域下某张表的过滤谓词（列引用与现有导入删除逻辑保持一致）
fn single_scope_where(table: &str) -> &'static str {
    match table {
        "books" => "WHERE id = ?1",
        "volumes" => "WHERE book_id = ?1",
        "chapters" => "WHERE book_id = ?1",
        "snapshots" => "WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id = ?1)",
        "world_cards" => "WHERE book_id = ?1",
        "embeddings" => {
            "WHERE source_id IN (SELECT id FROM chapters WHERE book_id = ?1) \
                         OR source_id IN (SELECT id FROM world_cards WHERE book_id = ?1)"
        }
        _ => "WHERE 0", // 不会到达
    }
}

/// 在导入事务内、删除数据前，把受影响范围快照为克隆表（replace 语义的回退点）
///
/// 快照与导入写入处于同一事务：导入失败自动整体回滚（快照随之消失，无残留）；
/// 导入成功则快照随事务一并提交，供后续 rollback_import 撤销。
fn snapshot_scope(
    conn: &rusqlite::Connection,
    ts: &str,
    scope: &ImportScope,
) -> Result<(), AppError> {
    for table in RB_TABLES {
        let rb = rb_table(ts, table);
        let sql = match scope {
            ImportScope::Full => format!("CREATE TABLE {} AS SELECT * FROM {}", rb, table),
            ImportScope::Single(_) => format!(
                "CREATE TABLE {} AS SELECT * FROM {} {}",
                rb,
                table,
                single_scope_where(table)
            ),
        };
        match scope {
            ImportScope::Single(book_id) => {
                conn.execute(&sql, params![book_id])?;
            }
            ImportScope::Full => {
                conn.execute(&sql, [])?;
            }
        }
    }
    Ok(())
}

/// 统计快照行数（回滚时用于报告影响规模）
fn count_rb_table(conn: &rusqlite::Connection, ts: &str, table: &str) -> Result<i64, AppError> {
    let rb = rb_table(ts, table);
    let cnt: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {}", rb), [], |r| r.get(0))?;
    Ok(cnt)
}

/// 清空全库数据（与删除顺序保持一致：镜像 → 事实源，子表先于父表）。
/// 供 full 导入与 full 回滚共用。
fn clear_full_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    // 先清 vec0 KNN 镜像（表不存在则跳过），再清事实源
    embedding_repo::clear_vec_table(conn)?;
    conn.execute("DELETE FROM embeddings", [])?;
    conn.execute("DELETE FROM snapshots", [])?;
    conn.execute("DELETE FROM world_cards", [])?;
    conn.execute("DELETE FROM chapters", [])?;
    conn.execute("DELETE FROM volumes", [])?;
    conn.execute("DELETE FROM books", [])?;
    Ok(())
}

/// 清空单个作品的数据（含其 embedding 与 vec 镜像）。供 single 导入与回滚共用。
fn clear_book_scope(conn: &rusqlite::Connection, book_id: &str) -> Result<(), AppError> {
    // 先删该书在 vec0 KNN 镜像中的行（rowid ↔ embeddings.id），再清事实源
    let book_emb_ids = embedding_repo::list_ids_by_book(conn, book_id)?;
    embedding_repo::delete_vec_rows(conn, &book_emb_ids)?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_id IN (SELECT id FROM chapters WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_id IN (SELECT id FROM world_cards WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute(
        "DELETE FROM snapshots WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute("DELETE FROM world_cards WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM chapters WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM volumes WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM books WHERE id=?1", params![book_id])?;
    Ok(())
}

/// 当前作用域下的数据清理（full / single），供回滚撤销「导入后状态」用
fn clear_scope_data(conn: &rusqlite::Connection, scope: &ImportScope) -> Result<(), AppError> {
    match scope {
        ImportScope::Full => clear_full_tables(conn),
        ImportScope::Single(book_id) => clear_book_scope(conn, book_id),
    }
}

/// 从克隆表恢复数据到目标表（books → volumes → chapters → snapshots → world_cards → embeddings，
/// 父表先于子表，满足外键依赖）
fn restore_from_clones(
    conn: &rusqlite::Connection,
    ts: &str,
) -> Result<serde_json::Value, AppError> {
    let mut restored = serde_json::Map::new();
    // INSERT INTO t SELECT * FROM rb：克隆表由 SELECT * 创建，列序与当前目标表一致
    for table in RB_TABLES {
        let rb = rb_table(ts, table);
        let sql = format!("INSERT INTO {} SELECT * FROM {}", table, rb);
        let n = conn.execute(&sql, [])?;
        restored.insert(table.to_string(), serde_json::json!(n));
    }
    Ok(serde_json::Value::Object(restored))
}

/// 删除回退点克隆表与元信息（回滚消费或过期清理）
fn drop_rollback_point(conn: &rusqlite::Connection, ts: &str) -> Result<(), AppError> {
    for table in RB_TABLES {
        let rb = rb_table(ts, table);
        conn.execute(&format!("DROP TABLE IF EXISTS {}", rb), [])?;
    }
    conn.execute("DELETE FROM import_rollback_log WHERE ts = ?1", params![ts])?;
    Ok(())
}

/// 清理过期回退点（超过 RB_TTL_HOURS）。返回清理的回退点数量。
pub fn prune_expired_rollbacks(conn: &rusqlite::Connection) -> Result<usize, AppError> {
    let cutoff = (Utc::now() - chrono::Duration::hours(RB_TTL_HOURS)).to_rfc3339();
    let mut stmt = conn
        .prepare("SELECT ts FROM import_rollback_log WHERE created_at < ?1 ORDER BY created_at")?;
    let expired: Vec<String> = stmt
        .query_map(params![cutoff], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for ts in &expired {
        drop_rollback_point(conn, ts)?;
    }
    if !expired.is_empty() {
        crate::app_log!("[Rollback] 已清理 {} 个过期导入回退点", expired.len());
    }
    Ok(expired.len())
}

/// 撤销一次导入：把目标库恢复至该回退点快照状态（事务内，commit 后重建 vec 镜像）
pub fn execute_rollback(
    conn: &mut rusqlite::Connection,
    ts: &str,
) -> Result<serde_json::Value, AppError> {
    let Some((scope_str, file_name)) = get_rollback_log(conn, ts)? else {
        return Err(AppError::Business(format!(
            "E_BACKUP_ROLLBACK：回退点不存在或已过期：{}",
            ts
        )));
    };
    let scope = ImportScope::parse(&scope_str).ok_or_else(|| {
        AppError::Business(format!(
            "E_BACKUP_ROLLBACK：回退点作用域异常：{}",
            scope_str
        ))
    })?;

    // 先确认快照表可读（避免回滚到一半才发现数据缺失）
    for table in RB_TABLES {
        count_rb_table(conn, ts, table)?;
    }

    let tx = conn
        .transaction()
        .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：开始回滚事务失败: {}", e)))?;

    // 1) 删除当前导入后的数据（撤销 replace 的效果）
    clear_scope_data(&tx, &scope)?;
    // 2) 从快照恢复导入前状态
    let restored = restore_from_clones(&tx, ts)?;
    // 3) 消费回退点
    drop_rollback_point(&tx, ts)?;
    tx.commit()
        .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：提交回滚事务失败: {}", e)))?;

    // 4) vec 镜像与 embeddings 对齐（回滚恢复的 embedding 行可能为空或非空）
    if let Err(e) = embedding_repo::rebuild_chunks_vec(conn) {
        crate::app_log_error!("[Rollback] vec 镜像重建失败（可后续由检索自动修复）: {}", e);
    }

    Ok(serde_json::json!({
        "rolledBack": true,
        "ts": ts,
        "scope": scope_str,
        "file_name": file_name,
        "restored": restored,
    }))
}

// ---- 导出结构 ----

/// 章节导出结构（含 HTML 正文内容）
#[derive(Clone, Serialize, Deserialize)]
struct ChapterExport {
    id: String,
    #[serde(rename = "bookId")]
    book_id: String,
    #[serde(rename = "volumeId")]
    volume_id: Option<String>,
    title: String,
    #[serde(rename = "contentHtml")]
    content_html: String,
    #[serde(rename = "wordCount")]
    word_count: i64,
    status: String,
    #[serde(rename = "sortOrder")]
    sort_order: i64,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "deletedAt")]
    deleted_at: Option<String>,
    summary: Option<String>,
    #[serde(rename = "summaryAt")]
    summary_at: Option<String>,
    outline: String,
}

/// Embedding 元数据导出（不含 BLOB 向量，可重新生成）
#[derive(Clone, Serialize, Deserialize)]
struct EmbeddingMetaExport {
    #[serde(rename = "sourceType")]
    source_type: String,
    #[serde(rename = "sourceId")]
    source_id: String,
    model: String,
    #[serde(rename = "createdAt")]
    created_at: String,
}

/// 数据库全量导出子模块
#[derive(Serialize, Deserialize)]
struct DatabaseExport {
    books: Vec<Book>,
    volumes: Vec<Volume>,
    chapters: Vec<ChapterExport>,
    snapshots: Vec<Snapshot>,
    #[serde(rename = "worldCards")]
    world_cards: Vec<WorldCard>,
    embeddings: Vec<EmbeddingMetaExport>,
}

/// 全量导出总载荷（v1 字段兼容保留；v2 新增 schemaVersion / appVersion / payloadHash，均缺失时自动兼容旧文件）
#[derive(Serialize, Deserialize)]
struct ExportPayload {
    version: String,
    #[serde(rename = "exportedAt")]
    exported_at: String,
    #[serde(rename = "backupType")]
    backup_type: String,
    #[serde(rename = "schemaVersion")]
    schema_version: Option<i64>,
    #[serde(rename = "appVersion")]
    app_version: Option<String>,
    #[serde(rename = "payloadHash")]
    payload_hash: Option<String>,
    database: DatabaseExport,
    cache: serde_json::Value,
}

// ---- 导出辅助函数 ----

/// 从 Repository 加载全量数据（委托给各 repo 的 list_all_* 函数）
fn load_full_export_data(
    app: &AppHandle,
    conn: &rusqlite::Connection,
) -> Result<DatabaseExport, AppError> {
    emit_sql_log(
        app,
        "SELECT",
        "books",
        "full export via repo",
        file!(),
        line!(),
    );
    let books = book_repo::list_all_include_deleted(conn)?;

    emit_sql_log(
        app,
        "SELECT",
        "volumes",
        "full export via repo",
        file!(),
        line!(),
    );
    let volumes = volume_repo::list_all_include_deleted(conn)?;

    emit_sql_log(
        app,
        "SELECT",
        "chapters",
        "full export via repo",
        file!(),
        line!(),
    );
    let chapter_rows = chapter_repo::list_all_include_deleted_with_content(conn)?;
    let chapters: Vec<ChapterExport> = chapter_rows
        .into_iter()
        .map(
            |(
                id,
                book_id,
                volume_id,
                title,
                content_html,
                word_count,
                status,
                sort_order,
                created_at,
                updated_at,
                deleted_at,
                summary,
                summary_at,
                outline,
            )| {
                ChapterExport {
                    id,
                    book_id,
                    volume_id,
                    title,
                    content_html,
                    word_count,
                    status,
                    sort_order,
                    created_at,
                    updated_at,
                    deleted_at,
                    summary,
                    summary_at,
                    outline,
                }
            },
        )
        .collect();

    emit_sql_log(
        app,
        "SELECT",
        "snapshots",
        "full export via repo",
        file!(),
        line!(),
    );
    let snapshots = snapshot_repo::list_all(conn)?;

    emit_sql_log(
        app,
        "SELECT",
        "world_cards",
        "full export via repo",
        file!(),
        line!(),
    );
    let world_cards = world_card_repo::list_all(conn)?;

    emit_sql_log(
        app,
        "SELECT",
        "embeddings",
        "full export via repo",
        file!(),
        line!(),
    );
    let emb_rows = embedding_repo::list_all_meta(conn)?;
    let embeddings: Vec<EmbeddingMetaExport> = emb_rows
        .into_iter()
        .map(
            |(source_type, source_id, model, created_at)| EmbeddingMetaExport {
                source_type,
                source_id,
                model,
                created_at,
            },
        )
        .collect();

    Ok(DatabaseExport {
        books,
        volumes,
        chapters,
        snapshots,
        world_cards,
        embeddings,
    })
}

/// 从全量数据中筛选单作品的导出数据
fn filter_single_book_data(data: &DatabaseExport, book_id: &str) -> DatabaseExport {
    let chapter_ids: Vec<&str> = data.chapters.iter().map(|c| c.id.as_str()).collect();

    DatabaseExport {
        books: data
            .books
            .iter()
            .filter(|b| b.id == book_id)
            .cloned()
            .collect(),
        volumes: data
            .volumes
            .iter()
            .filter(|v| v.book_id == book_id)
            .cloned()
            .collect(),
        chapters: data
            .chapters
            .iter()
            .filter(|c| c.book_id == book_id)
            .cloned()
            .collect(),
        snapshots: data
            .snapshots
            .iter()
            .filter(|s| chapter_ids.contains(&s.chapter_id.as_str()))
            .cloned()
            .collect(),
        world_cards: data
            .world_cards
            .iter()
            .filter(|w| w.book_id == book_id)
            .cloned()
            .collect(),
        embeddings: data
            .embeddings
            .iter()
            .filter(|e| {
                chapter_ids.contains(&e.source_id.as_str())
                    || data.world_cards.iter().any(|w| w.id == e.source_id)
            })
            .cloned()
            .collect(),
    }
}

// ---- 公共导出逻辑 ----

fn build_and_write_payload(
    backup_type: &str,
    database: DatabaseExport,
    cache: serde_json::Value,
    output_path: &str,
) -> Result<(), AppError> {
    let exported_at = Utc::now().to_rfc3339();
    // v2 载荷（Spec §3.2 / §4.2）：payloadHash = database 规范化 JSON 的 SHA-256，
    // 排除 exportedAt / cache / backupType / appVersion 等导出侧元数据
    let db_bytes = serde_json::to_vec(&database)
        .map_err(|e| AppError::Business(format!("E_BACKUP_SERIALIZE：JSON 序列化失败: {}", e)))?;
    let payload_hash = sha256_hex(&db_bytes);

    let payload = ExportPayload {
        version: "2.0".to_string(),
        exported_at,
        backup_type: backup_type.to_string(),
        schema_version: Some(2),
        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        payload_hash: Some(payload_hash),
        database,
        cache,
    };
    let json = serde_json::to_string(&payload)
        .map_err(|e| AppError::Business(format!("E_BACKUP_SERIALIZE：JSON 序列化失败: {}", e)))?;
    // Spec §8.2：序列化后估算，超 200 MB 拒绝（提示分书导出）
    if json.len() > MAX_BACKUP_FILE_BYTES as usize {
        return Err(AppError::Business(format!(
            "E_BACKUP_TOO_LARGE：导出载荷 {:.1} MB 超过上限 200 MB，请使用单作品导出或拆分数据",
            json.len() as f64 / 1024.0 / 1024.0
        )));
    }
    let encrypted = build_encrypted_file(json.as_bytes())?;
    // Spec §8.2：先写临时文件，成功后 rename 原子替换（避免中断留下半截文件）
    let tmp_path = format!("{}.tw.tmp", output_path);
    std::fs::write(&tmp_path, &encrypted)
        .map_err(|e| AppError::Business(format!("E_BACKUP_WRITE：写入临时文件失败: {}", e)))?;
    if let Err(e) = std::fs::rename(&tmp_path, output_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(AppError::Business(format!(
            "E_BACKUP_WRITE：移动临时文件到目标路径失败: {}",
            e
        )));
    }
    Ok(())
}

/// SHA-256 十六进制（载荷指纹 / 行内容短指纹共用）
fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

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

// ---- 数据导入辅助 ----

/// 校验备份行数上限（在事务开始前调用，超限直接拒绝，零写入）
fn validate_backup_row_limits(dbx: &DatabaseExport) -> Result<(), AppError> {
    let counts = [
        ("books", dbx.books.len()),
        ("volumes", dbx.volumes.len()),
        ("chapters", dbx.chapters.len()),
        ("snapshots", dbx.snapshots.len()),
        ("worldCards", dbx.world_cards.len()),
        ("embeddings", dbx.embeddings.len()),
    ];
    for (name, count) in counts {
        let max = MAX_BACKUP_ROWS
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, m)| *m)
            .unwrap_or(0);
        if count > max {
            return Err(AppError::Business(format!(
                "E_BACKUP_TOO_LARGE：备份包含 {} 行「{}」数据，超过上限 {} 行，请分书导出后分别导入",
                count, name, max
            )));
        }
    }
    Ok(())
}

/// 引用完整性校验（Spec §3.3 / §5.2，G4）
///
/// 收集备份载荷内的全部悬空引用与重复 id（精确到 id），返回问题清单；空清单表示通过。
/// 导入与预览前均调用：发现问题 → 导入被拒（零写入）/ 预览标红。
fn validate_references(dbx: &DatabaseExport) -> Vec<String> {
    let mut issues: Vec<String> = Vec::new();

    let book_ids: HashSet<&str> = dbx.books.iter().map(|b| b.id.as_str()).collect();
    let volume_ids: HashSet<&str> = dbx.volumes.iter().map(|v| v.id.as_str()).collect();
    let chapter_ids: HashSet<&str> = dbx.chapters.iter().map(|c| c.id.as_str()).collect();
    let world_card_ids: HashSet<&str> = dbx.world_cards.iter().map(|w| w.id.as_str()).collect();

    // 1) books：重复 id
    let mut seen_books: HashSet<&str> = HashSet::new();
    for b in &dbx.books {
        if !seen_books.insert(b.id.as_str()) {
            issues.push(format!("books: 重复的书籍 id={}", b.id));
        }
    }

    // 2) volumes：重复 id + book_id 悬空
    let mut seen_volumes: HashSet<&str> = HashSet::new();
    for v in &dbx.volumes {
        if !seen_volumes.insert(v.id.as_str()) {
            issues.push(format!("volumes: 重复的卷 id={}", v.id));
        }
        if !book_ids.contains(v.book_id.as_str()) {
            issues.push(format!(
                "volumes: 卷 {} 引用了不存在的书籍 bookId={}",
                v.id, v.book_id
            ));
        }
    }

    // 3) chapters：重复 id + book_id/volume_id 悬空
    let mut seen_chapters: HashSet<&str> = HashSet::new();
    for c in &dbx.chapters {
        if !seen_chapters.insert(c.id.as_str()) {
            issues.push(format!("chapters: 重复的章节 id={}", c.id));
        }
        if !book_ids.contains(c.book_id.as_str()) {
            issues.push(format!(
                "chapters: 章节 {} 引用了不存在的书籍 bookId={}",
                c.id, c.book_id
            ));
        }
        if let Some(vid) = &c.volume_id {
            if !volume_ids.contains(vid.as_str()) {
                issues.push(format!(
                    "chapters: 章节 {} 引用了不存在的卷 volumeId={}",
                    c.id, vid
                ));
            }
        }
    }

    // 4) snapshots：重复 id + chapter_id 悬空
    let mut seen_snapshots: HashSet<&str> = HashSet::new();
    for s in &dbx.snapshots {
        if !seen_snapshots.insert(s.id.as_str()) {
            issues.push(format!("snapshots: 重复的快照 id={}", s.id));
        }
        if !chapter_ids.contains(s.chapter_id.as_str()) {
            issues.push(format!(
                "snapshots: 快照 {} 引用了不存在的章节 chapterId={}",
                s.id, s.chapter_id
            ));
        }
    }

    // 5) world_cards：重复 id + book_id 悬空
    let mut seen_cards: HashSet<&str> = HashSet::new();
    for w in &dbx.world_cards {
        if !seen_cards.insert(w.id.as_str()) {
            issues.push(format!("worldCards: 重复的卡片 id={}", w.id));
        }
        if !book_ids.contains(w.book_id.as_str()) {
            issues.push(format!(
                "worldCards: 卡片 {} 引用了不存在的书籍 bookId={}",
                w.id, w.book_id
            ));
        }
    }

    // 6) embeddings：(source_type, source_id) 重复 + 源对象悬空
    let mut seen_emb: HashSet<(String, String)> = HashSet::new();
    for e in &dbx.embeddings {
        if !seen_emb.insert((e.source_type.clone(), e.source_id.clone())) {
            issues.push(format!(
                "embeddings: 重复的向量记录 ({}, {})",
                e.source_type, e.source_id
            ));
        }
        match e.source_type.as_str() {
            "chapter" => {
                if !chapter_ids.contains(e.source_id.as_str()) {
                    issues.push(format!(
                        "embeddings: 章节向量引用了不存在的章节 chapterId={}",
                        e.source_id
                    ));
                }
            }
            "world_card" => {
                if !world_card_ids.contains(e.source_id.as_str()) {
                    issues.push(format!(
                        "embeddings: 世界观向量引用了不存在的卡片 worldCardId={}",
                        e.source_id
                    ));
                }
            }
            other => {
                issues.push(format!(
                    "embeddings: 未知向量来源类型 sourceType=\"{}\" (sourceId={})",
                    other, e.source_id
                ));
            }
        }
    }

    issues
}

/// 单条写入统计（供 merge / fill-gaps 报告）
#[derive(Default, Clone, Copy, Debug)]
struct WriteStats {
    inserted: usize,
    updated: usize,
    skipped: usize,
}

fn stats_to_json(s: &WriteStats) -> serde_json::Value {
    serde_json::json!({
        "inserted": s.inserted,
        "updated": s.updated,
        "skipped": s.skipped,
    })
}

/// 判断某张表是否存在指定主键行
fn existing_id(conn: &rusqlite::Connection, table: &str, id: &str) -> Result<bool, AppError> {
    let cnt: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {} WHERE id = ?1", table),
        params![id],
        |r| r.get(0),
    )?;
    Ok(cnt > 0)
}

/// 读取目标行 updated_at；仅 books/chapters/world_cards 拥有该列，
/// volumes/snapshots 返回 None（由调用方按「存在即保留目标」处理，二者无内容字段可择优）。
fn target_updated_at(
    conn: &rusqlite::Connection,
    table: &str,
    id: &str,
) -> Result<Option<String>, AppError> {
    match table {
        "books" | "chapters" | "world_cards" => {
            let mut stmt =
                conn.prepare(&format!("SELECT updated_at FROM {} WHERE id = ?1", table))?;
            let mut rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
            match rows.next() {
                Some(Ok(v)) => Ok(Some(v)),
                Some(Err(e)) => Err(e.into()),
                None => Ok(None),
            }
        }
        _ => Ok(None),
    }
}

/// 备份时间戳是否新于目标行（RFC3339 / 同构时间串按字典序可比较；
/// 格式混用导致误判时，merge 只会保守地保留目标行，绝不丢目标新数据）
fn backup_is_newer(backup: &str, target: &str) -> bool {
    backup > target
}

// ---- merge / fill-gaps 写入（非破坏性策略，调用方需置于事务内） ----

/// 按策略写入备份数据，不清空目标库（merge / fill-gaps 共用）。
///
/// 表级择优基准（Spec §5.4）：
/// - books / chapters / world_cards：id 冲突时按 updated_at 择优，备份更新则全字段覆盖，否则保留目标行；
/// - volumes / snapshots：无 updated_at（无内容字段），id 冲突时保留目标行（不覆盖）；
/// - fill-gaps（insert_only=true）：任何表只插入目标库缺失行，绝不更新已存在行；
/// - embeddings：向量 BLOB 由本机 AI 重索引生成，备份仅含元数据，导入时忽略（保留目标库已有向量）。
///
/// 返回每表写入统计。
fn apply_upsert_data(
    conn: &rusqlite::Connection,
    dbx: &DatabaseExport,
    insert_only: bool,
) -> Result<serde_json::Value, AppError> {
    let mut books_st = WriteStats::default();
    let mut volumes_st = WriteStats::default();
    let mut chapters_st = WriteStats::default();
    let mut snapshots_st = WriteStats::default();
    let mut world_cards_st = WriteStats::default();

    for book in &dbx.books {
        let tags_json = serde_json::to_string(&book.tags).unwrap_or_else(|_| "[]".to_string());
        match target_updated_at(conn, "books", &book.id)? {
            Some(target) if !insert_only && backup_is_newer(&book.updated_at, &target) => {
                conn.execute(
                    "UPDATE books SET title=?2, author=?3, description=?4, cover_image=?5, \
                     word_count=?6, daily_target=?7, today_count=?8, db_path=?9, tags=?10, \
                     created_at=?11, updated_at=?12, deleted_at=?13, outline=?14 WHERE id=?1",
                    params![
                        book.id,
                        book.title,
                        book.author,
                        book.description,
                        book.cover_image,
                        book.word_count,
                        book.daily_target,
                        book.today_count,
                        book.db_path,
                        tags_json,
                        book.created_at,
                        book.updated_at,
                        book.deleted_at,
                        book.outline,
                    ],
                )?;
                books_st.updated += 1;
            }
            Some(_) => {
                books_st.skipped += 1;
            }
            None => {
                conn.execute(
                    "INSERT INTO books (id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                    params![
                        book.id, book.title, book.author, book.description,
                        book.cover_image, book.word_count, book.daily_target, book.today_count,
                        book.db_path, tags_json, book.created_at, book.updated_at,
                        book.deleted_at, book.outline,
                    ],
                )?;
                books_st.inserted += 1;
            }
        }
    }

    for vol in &dbx.volumes {
        if existing_id(conn, "volumes", &vol.id)? {
            volumes_st.skipped += 1;
        } else {
            conn.execute(
                "INSERT INTO volumes (id,book_id,title,sort_order,created_at,deleted_at) \
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    vol.id,
                    vol.book_id,
                    vol.title,
                    vol.sort_order,
                    vol.created_at,
                    vol.deleted_at
                ],
            )?;
            volumes_st.inserted += 1;
        }
    }

    for ch in &dbx.chapters {
        match target_updated_at(conn, "chapters", &ch.id)? {
            Some(target) if !insert_only && backup_is_newer(&ch.updated_at, &target) => {
                conn.execute(
                    "UPDATE chapters SET book_id=?2, volume_id=?3, title=?4, content_html=?5, \
                     word_count=?6, status=?7, sort_order=?8, created_at=?9, updated_at=?10, \
                     deleted_at=?11, summary=?12, summary_at=?13, outline=?14 WHERE id=?1",
                    params![
                        ch.id,
                        ch.book_id,
                        ch.volume_id,
                        ch.title,
                        ch.content_html,
                        ch.word_count,
                        ch.status,
                        ch.sort_order,
                        ch.created_at,
                        ch.updated_at,
                        ch.deleted_at,
                        ch.summary,
                        ch.summary_at,
                        ch.outline,
                    ],
                )?;
                chapters_st.updated += 1;
            }
            Some(_) => {
                chapters_st.skipped += 1;
            }
            None => {
                conn.execute(
                    "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                    params![
                        ch.id, ch.book_id, ch.volume_id, ch.title, ch.content_html,
                        ch.word_count, ch.status, ch.sort_order, ch.created_at, ch.updated_at,
                        ch.deleted_at, ch.summary, ch.summary_at, ch.outline,
                    ],
                )?;
                chapters_st.inserted += 1;
            }
        }
    }

    for snap in &dbx.snapshots {
        if existing_id(conn, "snapshots", &snap.id)? {
            snapshots_st.skipped += 1;
        } else {
            conn.execute(
                "INSERT INTO snapshots (id,chapter_id,content_html,word_count,type,label,created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    snap.id,
                    snap.chapter_id,
                    snap.content_html,
                    snap.word_count,
                    snap.snapshot_type,
                    snap.label,
                    snap.created_at,
                ],
            )?;
            snapshots_st.inserted += 1;
        }
    }

    for card in &dbx.world_cards {
        let tags_json = serde_json::to_string(&card.tags).unwrap_or_else(|_| "[]".to_string());
        match target_updated_at(conn, "world_cards", &card.id)? {
            Some(target) if !insert_only && backup_is_newer(&card.updated_at, &target) => {
                conn.execute(
                    "UPDATE world_cards SET book_id=?2, type=?3, title=?4, content=?5, \
                     content_html=?6, tags=?7, vectorized=?8, created_at=?9, updated_at=?10 \
                     WHERE id=?1",
                    params![
                        card.id,
                        card.book_id,
                        card.card_type,
                        card.title,
                        card.content,
                        card.content_html,
                        tags_json,
                        card.vectorized as i64,
                        card.created_at,
                        card.updated_at,
                    ],
                )?;
                world_cards_st.updated += 1;
            }
            Some(_) => {
                world_cards_st.skipped += 1;
            }
            None => {
                conn.execute(
                    "INSERT INTO world_cards (id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![
                        card.id, card.book_id, card.card_type, card.title, card.content,
                        card.content_html, tags_json, card.vectorized as i64,
                        card.created_at, card.updated_at,
                    ],
                )?;
                world_cards_st.inserted += 1;
            }
        }
    }

    Ok(serde_json::json!({
        "books": stats_to_json(&books_st),
        "volumes": stats_to_json(&volumes_st),
        "chapters": stats_to_json(&chapters_st),
        "snapshots": stats_to_json(&snapshots_st),
        "worldCards": stats_to_json(&world_cards_st),
    }))
}

/// 将备份数据写入数据库（replace 语义专用：调用方已清空目标范围，直接全量插入）
fn write_backup_data(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    dbx: &DatabaseExport,
) -> Result<(), AppError> {
    emit_sql_log(
        app,
        "INSERT",
        "books",
        &format!("backup import: {} books", dbx.books.len()),
        file!(),
        line!(),
    );
    for book in &dbx.books {
        let tags_json = serde_json::to_string(&book.tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO books (id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                book.id, book.title, book.author, book.description,
                book.cover_image, book.word_count, book.daily_target, book.today_count,
                book.db_path, tags_json, book.created_at, book.updated_at,
                book.deleted_at, book.outline,
            ],
        )?;
    }

    emit_sql_log(
        app,
        "INSERT",
        "volumes",
        &format!("backup import: {} volumes", dbx.volumes.len()),
        file!(),
        line!(),
    );
    for vol in &dbx.volumes {
        conn.execute(
            "INSERT INTO volumes (id,book_id,title,sort_order,created_at,deleted_at) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                vol.id,
                vol.book_id,
                vol.title,
                vol.sort_order,
                vol.created_at,
                vol.deleted_at
            ],
        )?;
    }

    emit_sql_log(
        app,
        "INSERT",
        "chapters",
        &format!("backup import: {} chapters", dbx.chapters.len()),
        file!(),
        line!(),
    );
    for ch in &dbx.chapters {
        conn.execute(
            "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                ch.id, ch.book_id, ch.volume_id, ch.title, ch.content_html,
                ch.word_count, ch.status, ch.sort_order, ch.created_at, ch.updated_at,
                ch.deleted_at, ch.summary, ch.summary_at, ch.outline,
            ],
        )?;
    }

    emit_sql_log(
        app,
        "INSERT",
        "snapshots",
        &format!("backup import: {} snapshots", dbx.snapshots.len()),
        file!(),
        line!(),
    );
    for snap in &dbx.snapshots {
        conn.execute(
            "INSERT INTO snapshots (id,chapter_id,content_html,word_count,type,label,created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                snap.id,
                snap.chapter_id,
                snap.content_html,
                snap.word_count,
                snap.snapshot_type,
                snap.label,
                snap.created_at,
            ],
        )?;
    }

    emit_sql_log(
        app,
        "INSERT",
        "world_cards",
        &format!("backup import: {} world_cards", dbx.world_cards.len()),
        file!(),
        line!(),
    );
    for card in &dbx.world_cards {
        let tags_json = serde_json::to_string(&card.tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO world_cards (id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                card.id, card.book_id, card.card_type, card.title, card.content,
                card.content_html, tags_json, card.vectorized as i64,
                card.created_at, card.updated_at,
            ],
        )?;
    }

    Ok(())
}

/// 执行全量数据写入（事务内：清空所有表 → 写入备份数据）
fn run_full_import(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    payload: &ExportPayload,
) -> Result<(), AppError> {
    emit_sql_log(
        app,
        "DELETE",
        "all tables",
        "full import: clearing all data",
        file!(),
        line!(),
    );
    clear_full_tables(conn)?;

    write_backup_data(app, conn, &payload.database)
}

/// 执行单作品数据写入（事务内：仅删除目标作品数据 → 写入备份数据）
fn run_single_import(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    payload: &ExportPayload,
    book_id: &str,
) -> Result<(), AppError> {
    emit_sql_log(
        app,
        "DELETE",
        "all tables",
        &format!("single import: clearing data for book_id={}", book_id),
        file!(),
        line!(),
    );
    clear_book_scope(conn, book_id)?;

    write_backup_data(app, conn, &payload.database)
}

// ---- Phase C：内容指纹 / 幂等日志 / 对账（Spec §4 / §5.5） ----

/// import_log 保留条数（滚动清理，运行态表）
const IMPORT_LOG_KEEP: usize = 20;

/// 载荷内容指纹：`database` 规范化 JSON 的 SHA-256（Spec §4.2）。
/// 序列化使用 struct 固定字段序，因此「导出时序列化」与「导入解析后再序列化」字节一致；
/// 天然排除 exportedAt / cache / backupType / appVersion / schemaVersion / payloadHash。
fn database_canonical_hash(payload: &ExportPayload) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(&payload.database)
        .map_err(|e| AppError::Business(format!("E_BACKUP_SERIALIZE：载荷指纹计算失败: {}", e)))?;
    Ok(sha256_hex(&bytes))
}

/// v2 载荷：校验声明的 payloadHash 与内容指纹一致（防篡改误判，Spec §4.2）。
/// 返回内容指纹；v1 旧文件（无 payloadHash 字段）返回 None —— 不判重但照常对账。
fn verified_payload_hash(payload: &ExportPayload) -> Result<Option<String>, AppError> {
    let Some(declared) = &payload.payload_hash else {
        return Ok(None);
    };
    let computed = database_canonical_hash(payload)?;
    if declared != &computed {
        return Err(AppError::Business(
            "E_BACKUP_SCHEMA：载荷指纹校验失败（文件内容与声明的 payloadHash 不一致，文件可能被篡改）。已拒绝导入，目标库未受影响。"
                .into(),
        ));
    }
    Ok(Some(computed))
}

/// 写入导入日志（幂等判定基础）：仅在导入事务**成功提交后**调用；v1 文件不写入。
/// 顺带滚动清理，仅保留最近 20 条。
fn record_import_log(
    conn: &rusqlite::Connection,
    payload_hash: &str,
    file_name: &str,
    backup_type: &str,
    source_size: i64,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO import_log (payload_hash, file_name, backup_type, source_size, imported_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            payload_hash,
            file_name,
            backup_type,
            source_size,
            Utc::now().to_rfc3339()
        ],
    )?;
    conn.execute(
        "DELETE FROM import_log WHERE id NOT IN \
         (SELECT id FROM import_log ORDER BY id DESC LIMIT ?1)",
        params![IMPORT_LOG_KEEP as i64],
    )?;
    Ok(())
}

/// 查最近一条同指纹 + 同类型 + 同大小的导入记录（幂等提示，Spec §4.3 判定）
fn lookup_import_log(
    conn: &rusqlite::Connection,
    payload_hash: &str,
    backup_type: &str,
    source_size: i64,
) -> Result<Option<(String, String)>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT imported_at, file_name FROM import_log \
         WHERE payload_hash = ?1 AND backup_type = ?2 AND source_size = ?3 \
         ORDER BY id DESC LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![payload_hash, backup_type, source_size], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// 导入成功提交后统一记录入口（仅 v2 载荷；v1 无指纹不写日志）
fn record_import_success(
    conn: &rusqlite::Connection,
    payload: &ExportPayload,
    payload_hash: &Option<String>,
    file_name: &str,
    file_size: u64,
) -> Result<(), AppError> {
    let Some(hash) = payload_hash else {
        return Ok(());
    };
    record_import_log(
        conn,
        hash,
        file_name,
        &payload.backup_type,
        file_size as i64,
    )
}

/// 行级对账分类（Spec §5.5）：
/// - matched：与目标库完全一致（updated_at + 内容指纹同）
/// - missing：备份有、目标库无 → 可补
/// - targetStale：目标库比备份旧 → 以备份覆盖才更新（merge 将覆盖）
/// - targetNewer：目标库比备份新 / 同时间戳内容冲突 → merge 保留目标库
#[derive(Clone, Debug, Default, Serialize)]
struct RowReconcile {
    matched: usize,
    #[serde(rename = "targetStale")]
    target_stale: usize,
    #[serde(rename = "targetNewer")]
    target_newer: usize,
    missing: usize,
}

/// 按表对账汇总（embeddings 无内容行，不参与；向量由本机重新索引）
#[derive(Debug, Default, Serialize)]
struct ReconcileReport {
    books: RowReconcile,
    volumes: RowReconcile,
    chapters: RowReconcile,
    snapshots: RowReconcile,
    #[serde(rename = "worldCards")]
    world_cards: RowReconcile,
}

/// 归一化可选字符串：None 与 Some("") 等价（跨库存储差异容忍）
fn fp_opt(v: Option<String>) -> String {
    v.unwrap_or_default()
}

fn classify_ts_row(
    out: &mut RowReconcile,
    backup_ts: &str,
    backup_fp: &str,
    target: Option<(String, String)>,
) {
    match target {
        None => out.missing += 1,
        Some((target_ts, target_fp)) => {
            if target_ts == backup_ts {
                if target_fp == backup_fp {
                    out.matched += 1;
                } else {
                    out.target_newer += 1; // 同时间戳内容冲突 → 默认保留目标
                }
            } else if backup_is_newer(backup_ts, &target_ts) {
                out.target_stale += 1;
            } else {
                out.target_newer += 1;
            }
        }
    }
}

fn classify_plain_row(out: &mut RowReconcile, backup_fp: &str, target: Option<String>) {
    match target {
        None => out.missing += 1,
        Some(target_fp) => {
            if target_fp == backup_fp {
                out.matched += 1;
            } else {
                out.target_newer += 1; // 无内容时钟的表，merge 对已存在行一律保留目标
            }
        }
    }
}

fn reconcile_books(conn: &rusqlite::Connection, rows: &[Book]) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT updated_at, title, author, description, cover_image, db_path, tags, deleted_at, outline \
         FROM books WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for b in rows {
        let target = {
            let mut q = stmt.query(params![b.id])?;
            match q.next()? {
                None => None,
                Some(r) => {
                    let target_fp = vec![
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        fp_opt(r.get::<_, Option<String>>(4)?),
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        fp_opt(r.get::<_, Option<String>>(7)?),
                        r.get::<_, String>(8)?,
                    ]
                    .join("\u{1}");
                    Some((r.get::<_, String>(0)?, target_fp))
                }
            }
        };
        let tags_json = serde_json::to_string(&b.tags).unwrap_or_else(|_| "[]".to_string());
        let backup_fp = vec![
            b.title.clone(),
            b.author.clone(),
            b.description.clone(),
            fp_opt(b.cover_image.clone()),
            b.db_path.clone(),
            tags_json,
            fp_opt(b.deleted_at.clone()),
            b.outline.clone(),
        ]
        .join("\u{1}");
        classify_ts_row(&mut out, &b.updated_at, &backup_fp, target);
    }
    Ok(out)
}

fn reconcile_volumes(
    conn: &rusqlite::Connection,
    rows: &[Volume],
) -> Result<RowReconcile, AppError> {
    let mut stmt =
        conn.prepare("SELECT title, sort_order, deleted_at FROM volumes WHERE id = ?1")?;
    let mut out = RowReconcile::default();
    for v in rows {
        let target = {
            let mut q = stmt.query(params![v.id])?;
            match q.next()? {
                None => None,
                Some(r) => Some(
                    vec![
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?.to_string(),
                        fp_opt(r.get::<_, Option<String>>(2)?),
                    ]
                    .join("\u{1}"),
                ),
            }
        };
        let backup_fp = vec![
            v.title.clone(),
            v.sort_order.to_string(),
            fp_opt(v.deleted_at.clone()),
        ]
        .join("\u{1}");
        classify_plain_row(&mut out, &backup_fp, target);
    }
    Ok(out)
}

fn reconcile_chapters(
    conn: &rusqlite::Connection,
    rows: &[ChapterExport],
) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT updated_at, volume_id, title, content_html, word_count, status, sort_order, \
                deleted_at, summary, summary_at, outline \
         FROM chapters WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for c in rows {
        let target = {
            let mut q = stmt.query(params![c.id])?;
            match q.next()? {
                None => None,
                Some(r) => {
                    let target_fp = vec![
                        fp_opt(r.get::<_, Option<String>>(1)?),
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?.to_string(),
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?.to_string(),
                        fp_opt(r.get::<_, Option<String>>(7)?),
                        fp_opt(r.get::<_, Option<String>>(8)?),
                        fp_opt(r.get::<_, Option<String>>(9)?),
                        r.get::<_, String>(10)?,
                    ]
                    .join("\u{1}");
                    Some((r.get::<_, String>(0)?, target_fp))
                }
            }
        };
        let backup_fp = vec![
            fp_opt(c.volume_id.clone()),
            c.title.clone(),
            c.content_html.clone(),
            c.word_count.to_string(),
            c.status.clone(),
            c.sort_order.to_string(),
            fp_opt(c.deleted_at.clone()),
            fp_opt(c.summary.clone()),
            fp_opt(c.summary_at.clone()),
            c.outline.clone(),
        ]
        .join("\u{1}");
        classify_ts_row(&mut out, &c.updated_at, &backup_fp, target);
    }
    Ok(out)
}

fn reconcile_snapshots(
    conn: &rusqlite::Connection,
    rows: &[Snapshot],
) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT chapter_id, content_html, word_count, type, label FROM snapshots WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for s in rows {
        let target = {
            let mut q = stmt.query(params![s.id])?;
            match q.next()? {
                None => None,
                Some(r) => Some(
                    vec![
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?.to_string(),
                        r.get::<_, String>(3)?,
                        fp_opt(r.get::<_, Option<String>>(4)?),
                    ]
                    .join("\u{1}"),
                ),
            }
        };
        let backup_fp = vec![
            s.chapter_id.clone(),
            s.content_html.clone(),
            s.word_count.to_string(),
            s.snapshot_type.clone(),
            fp_opt(s.label.clone()),
        ]
        .join("\u{1}");
        classify_plain_row(&mut out, &backup_fp, target);
    }
    Ok(out)
}

fn reconcile_world_cards(
    conn: &rusqlite::Connection,
    rows: &[WorldCard],
) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT updated_at, type, title, content, content_html, tags, vectorized \
         FROM world_cards WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for w in rows {
        let target = {
            let mut q = stmt.query(params![w.id])?;
            match q.next()? {
                None => None,
                Some(r) => {
                    let target_fp = vec![
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?.to_string(),
                    ]
                    .join("\u{1}");
                    Some((r.get::<_, String>(0)?, target_fp))
                }
            }
        };
        let tags_json = serde_json::to_string(&w.tags).unwrap_or_else(|_| "[]".to_string());
        let backup_fp = vec![
            w.card_type.clone(),
            w.title.clone(),
            w.content.clone(),
            w.content_html.clone(),
            tags_json,
            (w.vectorized as i64).to_string(),
        ]
        .join("\u{1}");
        classify_ts_row(&mut out, &w.updated_at, &backup_fp, target);
    }
    Ok(out)
}

/// 只读对账：备份各行 vs 目标库（Spec §5.5 快速预判：id + updated_at + 内容指纹）
fn reconcile_backup(
    conn: &rusqlite::Connection,
    dbx: &DatabaseExport,
) -> Result<ReconcileReport, AppError> {
    Ok(ReconcileReport {
        books: reconcile_books(conn, &dbx.books)?,
        volumes: reconcile_volumes(conn, &dbx.volumes)?,
        chapters: reconcile_chapters(conn, &dbx.chapters)?,
        snapshots: reconcile_snapshots(conn, &dbx.snapshots)?,
        world_cards: reconcile_world_cards(conn, &dbx.world_cards)?,
    })
}

// ---- 统一数据导入 ----

/// 导入写入策略（Spec §5.4）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImportStrategy {
    /// 清空受影响范围后按备份重建（默认，保持向后兼容；可回退）
    Replace,
    /// 逐行择优合并：备份更新（updated_at 新）的行全字段覆盖，其余保留目标行 —— 目标库新增数据不丢
    Merge,
    /// 仅插入目标库缺失行，绝不触碰已存在行
    FillGaps,
}

impl ImportStrategy {
    fn parse(s: Option<&str>) -> Result<ImportStrategy, AppError> {
        match s.unwrap_or("replace") {
            "replace" => Ok(ImportStrategy::Replace),
            "merge" => Ok(ImportStrategy::Merge),
            "fill-gaps" => Ok(ImportStrategy::FillGaps),
            other => Err(AppError::Business(format!(
                "E_BACKUP_STRATEGY：不支持的导入策略 \"{}\"（可选：replace / merge / fill-gaps）",
                other
            ))),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            ImportStrategy::Replace => "replace",
            ImportStrategy::Merge => "merge",
            ImportStrategy::FillGaps => "fill-gaps",
        }
    }
}

/// 版本兼容检查（Spec §2.2 / §10）：v1.x / v2.x 可导入；高于当前支持主版本 → E_BACKUP_VERSION
fn check_supported_version(version: &str) -> Result<(), AppError> {
    let major = version
        .split('.')
        .next()
        .and_then(|s| s.parse::<i32>().ok());
    match major {
        Some(m) if m <= 2 => Ok(()),
        _ => Err(AppError::Business(format!(
            "E_BACKUP_VERSION：备份文件版本 v{} 高于当前 App 支持的 v2.x，请升级智写时光后再导入",
            version
        ))),
    }
}

/// 只读载入与校验备份文件：文件级 → 解密 → 结构 → 行数上限 → 语义（full/single 书数）。
/// 返回（载荷, 文件大小字节）。任何失败均在写入前发生，保证零写入。
fn load_backup_payload(file_path: &str) -> Result<(ExportPayload, u64), AppError> {
    // 0) 文件大小上限：先查 metadata 拒绝超大文件，避免一次性读入内存
    let meta = std::fs::metadata(file_path)
        .map_err(|e| AppError::Business(format!("E_BACKUP_READ：读取文件失败：{}", e)))?;
    if meta.len() > MAX_BACKUP_FILE_BYTES {
        return Err(AppError::Business(format!(
            "E_BACKUP_TOO_LARGE：备份文件大小 {:.1} MB 超过上限 200 MB",
            meta.len() as f64 / (1024.0 * 1024.0)
        )));
    }

    let file_bytes = std::fs::read(file_path)
        .map_err(|e| AppError::Business(format!("E_BACKUP_READ：读取文件失败：{}", e)))?;

    let json_str = parse_encrypted_file(&file_bytes)?;
    validate_payload_structure(&json_str)?;

    let payload: ExportPayload = serde_json::from_str(&json_str).map_err(|e| {
        AppError::Business(format!(
            "E_BACKUP_FILE：JSON 解析失败（文件可能已损坏或版本不兼容）：{}",
            e
        ))
    })?;

    // 0.5) 版本兼容：v1.x / v2.x 均可导入；高于当前 App 支持的主版本明确报错（Spec §2.2 / §10）
    check_supported_version(&payload.version)?;

    // 1) 行数上限（写入前，零写入）
    validate_backup_row_limits(&payload.database)?;

    // 2) 语义校验：backupType 合法；single 必须恰好包含 1 本书
    match payload.backup_type.as_str() {
        "full" => {}
        "single" => match payload.database.books.len() {
            0 => {
                return Err(AppError::Business(
                    "E_BACKUP_TYPE：单作品备份校验失败：备份中不包含任何书籍数据".into(),
                ))
            }
            1 => {}
            n => {
                return Err(AppError::Business(format!(
                    "E_BACKUP_TYPE：单作品备份校验失败：备份包含 {} 本书，这不是单作品备份文件",
                    n
                )))
            }
        },
        other => {
            return Err(AppError::Business(format!(
                "E_BACKUP_TYPE：不支持的备份类型：\"{}\"",
                other
            )))
        }
    }

    Ok((payload, meta.len()))
}

/// 事务内执行非破坏性策略导入（merge / fill-gaps），提交后统一对齐 vec0 镜像（G13）。
fn run_upsert_import(
    app: &AppHandle,
    conn: &mut rusqlite::Connection,
    payload: &ExportPayload,
    strategy: ImportStrategy,
) -> Result<serde_json::Value, AppError> {
    emit_sql_log(
        app,
        "BEGIN",
        "transaction",
        &format!("{} import transaction", strategy.as_str()),
        file!(),
        line!(),
    );
    let tx = conn
        .transaction()
        .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：开始事务失败: {}", e)))?;

    emit_sql_log(
        app,
        "MERGE",
        "all content tables",
        &format!(
            "{} import: books={} volumes={} chapters={} snapshots={} worldCards={}",
            strategy.as_str(),
            payload.database.books.len(),
            payload.database.volumes.len(),
            payload.database.chapters.len(),
            payload.database.snapshots.len(),
            payload.database.world_cards.len(),
        ),
        file!(),
        line!(),
    );

    let stats =
        match apply_upsert_data(&tx, &payload.database, strategy == ImportStrategy::FillGaps) {
            Ok(s) => s,
            Err(e) => {
                emit_sql_log(
                    app,
                    "ROLLBACK",
                    "transaction",
                    "upsert import rolled back (auto)",
                    file!(),
                    line!(),
                );
                return Err(AppError::Business(format!(
                    "E_BACKUP_TXN：导入失败（事务已回滚，目标库未受影响）：{}",
                    e
                )));
            }
        };

    emit_sql_log(
        app,
        "COMMIT",
        "transaction",
        &format!("{} import committed", strategy.as_str()),
        file!(),
        line!(),
    );
    tx.commit()
        .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：提交事务失败: {}", e)))?;

    // 非破坏性策略不产生新向量，但统一对齐 vec0 镜像，防止内容变更后镜像残留/缺失（G13）
    if let Err(e) = embedding_repo::rebuild_chunks_vec(conn) {
        crate::app_log_error!(
            "[Backup] {} 后 vec 镜像对齐失败（忽略，可后续由检索自动修复）: {}",
            strategy.as_str(),
            e
        );
    }

    // 清理过期回退点（非破坏性导入本身不回退，但保持库内点数量受控）
    if let Err(e) = prune_expired_rollbacks(conn) {
        crate::app_log_error!("[Rollback] 过期回退点清理失败（忽略）: {}", e);
    }

    Ok(serde_json::json!({
        "cache": payload.cache,
        "backupType": payload.backup_type,
        "strategy": strategy.as_str(),
        "stats": stats,
        "rollbackTs": null,
    }))
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
