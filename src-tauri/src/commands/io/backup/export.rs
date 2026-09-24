//! 备份导出：全量/单作品数据装载与 v2 加密载荷写出
//!
//! 数据经 Repository 层装载，载荷附 payloadHash（database 规范化 JSON 的 SHA-256），
//! 写出走「临时文件 + rename」原子替换。

use super::types::{sha256_hex, ChapterExport, DatabaseExport, EmbeddingMetaExport, ExportPayload, MAX_BACKUP_FILE_BYTES};
use crate::commands::io::crypto::build_encrypted_file;
use crate::commands::window::emit_sql_log;
use crate::error::AppError;
use crate::repository::{
    book_repo, chapter_repo, embedding_repo, snapshot_repo, volume_repo, world_card_repo,
};
use chrono::Utc;
use tauri::AppHandle;

// ---- 导出辅助函数 ----

/// 从 Repository 加载全量数据（委托给各 repo 的 list_all_* 函数）
pub(crate) fn load_full_export_data(
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
pub(crate) fn filter_single_book_data(data: &DatabaseExport, book_id: &str) -> DatabaseExport {
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

pub(crate) fn build_and_write_payload(
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
