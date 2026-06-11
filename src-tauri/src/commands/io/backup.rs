//! 全量/单作品数据备份与恢复
//!
//! 通过加密的 `.tw` 文件进行完整数据迁移。
//! 查询操作统一委托给 Repository 层，避免在多处重复 SQL。

use tauri::{AppHandle, State};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use chrono::Utc;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Book, Volume, Snapshot, WorldCard};
use crate::commands::window::emit_sql_log;
use crate::repository::{book_repo, volume_repo, chapter_repo, snapshot_repo, world_card_repo, embedding_repo};
use super::crypto::{build_encrypted_file, parse_encrypted_file, validate_payload_structure};

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

/// 全量导出总载荷
#[derive(Serialize, Deserialize)]
struct ExportPayload {
    version: String,
    #[serde(rename = "exportedAt")]
    exported_at: String,
    #[serde(rename = "backupType")]
    backup_type: String,
    database: DatabaseExport,
    cache: serde_json::Value,
}

// ---- 导出辅助函数 ----

/// 从 Repository 加载全量数据（委托给各 repo 的 list_all_* 函数）
fn load_full_export_data(app: &AppHandle, conn: &rusqlite::Connection) -> Result<DatabaseExport, AppError> {
    emit_sql_log(app, "SELECT", "books", "full export via repo", file!(), line!());
    let books = book_repo::list_all_include_deleted(conn)?;

    emit_sql_log(app, "SELECT", "volumes", "full export via repo", file!(), line!());
    let volumes = volume_repo::list_all_include_deleted(conn)?;

    emit_sql_log(app, "SELECT", "chapters", "full export via repo", file!(), line!());
    let chapter_rows = chapter_repo::list_all_include_deleted_with_content(conn)?;
    let chapters: Vec<ChapterExport> = chapter_rows
        .into_iter()
        .map(|(id, book_id, volume_id, title, content_html, word_count, status, sort_order, created_at, updated_at, deleted_at, summary, summary_at, outline)| {
            ChapterExport {
                id, book_id, volume_id, title, content_html, word_count, status, sort_order,
                created_at, updated_at, deleted_at, summary, summary_at, outline,
            }
        })
        .collect();

    emit_sql_log(app, "SELECT", "snapshots", "full export via repo", file!(), line!());
    let snapshots = snapshot_repo::list_all(conn)?;

    emit_sql_log(app, "SELECT", "world_cards", "full export via repo", file!(), line!());
    let world_cards = world_card_repo::list_all(conn)?;

    emit_sql_log(app, "SELECT", "embeddings", "full export via repo", file!(), line!());
    let emb_rows = embedding_repo::list_all_meta(conn)?;
    let embeddings: Vec<EmbeddingMetaExport> = emb_rows
        .into_iter()
        .map(|(source_type, source_id, model, created_at)| EmbeddingMetaExport {
            source_type, source_id, model, created_at,
        })
        .collect();

    Ok(DatabaseExport { books, volumes, chapters, snapshots, world_cards, embeddings })
}

/// 从全量数据中筛选单作品的导出数据
fn filter_single_book_data(data: &DatabaseExport, book_id: &str) -> DatabaseExport {
    let chapter_ids: Vec<&str> = data.chapters.iter().map(|c| c.id.as_str()).collect();

    DatabaseExport {
        books: data.books.iter().filter(|b| b.id == book_id).cloned().collect(),
        volumes: data.volumes.iter().filter(|v| v.book_id == book_id).cloned().collect(),
        chapters: data.chapters.iter().filter(|c| c.book_id == book_id).cloned().collect(),
        snapshots: data.snapshots.iter()
            .filter(|s| chapter_ids.contains(&s.chapter_id.as_str()))
            .cloned()
            .collect(),
        world_cards: data.world_cards.iter().filter(|w| w.book_id == book_id).cloned().collect(),
        embeddings: data.embeddings.iter()
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
    let payload = ExportPayload {
        version: "1.0".to_string(),
        exported_at: Utc::now().to_rfc3339(),
        backup_type: backup_type.to_string(),
        database,
        cache,
    };
    let json = serde_json::to_string(&payload)
        .map_err(|e| AppError::Business(format!("JSON 序列化失败: {}", e)))?;
    let encrypted = build_encrypted_file(json.as_bytes())?;
    std::fs::write(output_path, encrypted)
        .map_err(|e| AppError::Business(format!("写入文件失败: {}", e)))?;
    Ok(())
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
    let conn = db.pool.get()?;
    let database = load_full_export_data(&app, &conn)?;
    let cache: serde_json::Value = serde_json::from_str(&cache_json)
        .map_err(|e| AppError::Business(format!("缓存数据解析失败: {}", e)))?;

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
    let conn = db.pool.get()?;
    let full_data = load_full_export_data(&app, &conn)?;
    let database = filter_single_book_data(&full_data, &book_id);
    let cache: serde_json::Value = serde_json::from_str(&cache_json)
        .map_err(|e| AppError::Business(format!("缓存数据解析失败: {}", e)))?;

    build_and_write_payload("single", database, cache, &output_path)
}

// ---- 数据导入辅助 ----

/// 校验全量备份：backupType 必须为 "full"
fn validate_full_backup_payload(json_str: &str) -> Result<(), AppError> {
    let val: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| AppError::Business(format!("JSON 解析失败: {}", e)))?;
    let backup_type = val
        .get("backupType")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Business("校验失败：缺少 backupType 字段".into()))?;
    if backup_type != "full" {
        return Err(AppError::Business(format!("备份类型不匹配：期望 \"full\"，实际为 \"{}\"", backup_type)));
    }
    Ok(())
}

/// 校验单作品备份：backupType 必须为 "single"，且 database.books 恰好包含 1 本书
fn validate_single_backup_payload(json_str: &str) -> Result<String, AppError> {
    validate_payload_structure(json_str)?;
    let val: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| AppError::Business(format!("JSON 解析失败: {}", e)))?;
    let backup_type = val
        .get("backupType")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Business("校验失败：缺少 backupType 字段".into()))?;
    if backup_type != "single" {
        return Err(AppError::Business(format!("备份类型不匹配：期望 \"single\"，实际为 \"{}\"", backup_type)));
    }
    let db = val.get("database").and_then(|v| v.as_object())
        .ok_or_else(|| AppError::Business("校验失败：database 字段格式错误".into()))?;
    let books_arr = db.get("books").and_then(|v| v.as_array())
        .ok_or_else(|| AppError::Business("校验失败：database.books 不是数组".into()))?;
    if books_arr.is_empty() {
        return Err(AppError::Business("单作品备份校验失败：备份中不包含任何书籍数据".into()));
    }
    if books_arr.len() > 1 {
        return Err(AppError::Business(format!("单作品备份校验失败：备份包含 {} 本书，这不是单作品备份文件", books_arr.len())));
    }
    let book_id = books_arr[0].get("id").and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Business("校验失败：备份中的书籍缺少 id 字段".into()))?
        .to_string();
    Ok(book_id)
}

/// 将备份数据写入数据库（通用，不管理事务）
fn write_backup_data(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    dbx: &DatabaseExport,
) -> Result<(), AppError> {
    emit_sql_log(app, "INSERT", "books", &format!("backup import: {} books", dbx.books.len()), file!(), line!());
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

    emit_sql_log(app, "INSERT", "volumes", &format!("backup import: {} volumes", dbx.volumes.len()), file!(), line!());
    for vol in &dbx.volumes {
        conn.execute(
            "INSERT INTO volumes (id,book_id,title,sort_order,created_at,deleted_at) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![vol.id, vol.book_id, vol.title, vol.sort_order, vol.created_at, vol.deleted_at],
        )?;
    }

    emit_sql_log(app, "INSERT", "chapters", &format!("backup import: {} chapters", dbx.chapters.len()), file!(), line!());
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

    emit_sql_log(app, "INSERT", "snapshots", &format!("backup import: {} snapshots", dbx.snapshots.len()), file!(), line!());
    for snap in &dbx.snapshots {
        conn.execute(
            "INSERT INTO snapshots (id,chapter_id,content_html,word_count,type,label,created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                snap.id, snap.chapter_id, snap.content_html, snap.word_count,
                snap.snapshot_type, snap.label, snap.created_at,
            ],
        )?;
    }

    emit_sql_log(app, "INSERT", "world_cards", &format!("backup import: {} world_cards", dbx.world_cards.len()), file!(), line!());
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
    emit_sql_log(app, "DELETE", "all tables", "full import: clearing all data", file!(), line!());
    conn.execute("DELETE FROM embeddings", [])?;
    conn.execute("DELETE FROM snapshots", [])?;
    conn.execute("DELETE FROM world_cards", [])?;
    conn.execute("DELETE FROM chapters", [])?;
    conn.execute("DELETE FROM volumes", [])?;
    conn.execute("DELETE FROM books", [])?;

    write_backup_data(app, conn, &payload.database)
}

/// 执行单作品数据写入（事务内：仅删除目标作品数据 → 写入备份数据）
fn run_single_import(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    payload: &ExportPayload,
    book_id: &str,
) -> Result<(), AppError> {
    emit_sql_log(app, "DELETE", "all tables", &format!("single import: clearing data for book_id={}", book_id), file!(), line!());
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

    write_backup_data(app, conn, &payload.database)
}

// ---- 统一数据导入 ----

/// 统一数据导入命令
#[tauri::command]
pub async fn import_backup(
    app: AppHandle,
    db: State<'_, AppDb>,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    let file_bytes =
        std::fs::read(&file_path).map_err(|e| AppError::Business(format!("读取文件失败：{}", e)))?;

    let json_str = parse_encrypted_file(&file_bytes)?;
    validate_payload_structure(&json_str)?;

    let payload: ExportPayload = serde_json::from_str(&json_str)
        .map_err(|e| AppError::Business(format!("JSON 解析失败（文件可能已损坏或版本不兼容）：{}", e)))?;

    let backup_type = payload.backup_type.clone();
    let mut conn = db.pool.get()?;

    match backup_type.as_str() {
        "full" => {
            validate_full_backup_payload(&json_str)?;

            let payload = payload;
            emit_sql_log(&app, "BEGIN", "transaction", "full import transaction", file!(), line!());
            let tx = conn
                .transaction()
                .map_err(|e| AppError::Business(format!("开始事务失败: {}", e)))?;

            match run_full_import(&app, &tx, &payload) {
                Ok(()) => {
                    emit_sql_log(&app, "COMMIT", "transaction", "full import committed", file!(), line!());
                    tx.commit().map_err(|e| AppError::Business(format!("提交事务失败: {}", e)))?;
                }
                Err(e) => {
                    emit_sql_log(&app, "ROLLBACK", "transaction", "full import rolled back (auto)", file!(), line!());
                    return Err(AppError::Business(format!(
                        "导入失败（事务已回滚，原数据未受影响）：{}",
                        e
                    )));
                }
            }

            Ok(serde_json::json!({
                "cache": payload.cache,
                "backupType": "full",
            }))
        }
        "single" => {
            let book_id = validate_single_backup_payload(&json_str)?;

            emit_sql_log(&app, "BEGIN", "transaction", &format!("single import transaction for book_id={}", book_id), file!(), line!());
            let tx = conn
                .transaction()
                .map_err(|e| AppError::Business(format!("开始事务失败: {}", e)))?;

            match run_single_import(&app, &tx, &payload, &book_id) {
                Ok(()) => {
                    emit_sql_log(&app, "COMMIT", "transaction", "single import committed", file!(), line!());
                    tx.commit().map_err(|e| AppError::Business(format!("提交事务失败: {}", e)))?;
                }
                Err(e) => {
                    emit_sql_log(&app, "ROLLBACK", "transaction", "single import rolled back (auto)", file!(), line!());
                    return Err(AppError::Business(format!(
                        "导入失败（事务已回滚，原数据未受影响）：{}",
                        e
                    )));
                }
            }

            Ok(serde_json::json!({
                "cache": payload.cache,
                "backupType": "single",
            }))
        }
        _ => Err(AppError::Business(format!("不支持的备份类型：\"{}\"", backup_type))),
    }
}
