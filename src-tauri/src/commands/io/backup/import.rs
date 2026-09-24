//! 备份导入：只读载入校验 + 三策略写入（replace / merge / fill-gaps）
//!
//! 载入链路：文件级 → 解密 → 结构 → 版本 → 行数上限 → 语义校验，任何失败零写入；
//! replace 清空重建（配合回退点），merge/fill-gaps 单事务逐行择优写入。

use super::rollback::{clear_book_scope, clear_full_tables, prune_expired_rollbacks};
use super::types::{backup_is_newer, stats_to_json, DatabaseExport, ExportPayload, ImportStrategy, WriteStats, MAX_BACKUP_FILE_BYTES, MAX_BACKUP_ROWS};
use crate::commands::io::crypto::{parse_encrypted_file, validate_payload_structure};
use crate::commands::window::emit_sql_log;
use crate::error::AppError;
use crate::repository::embedding_repo;
use rusqlite::params;
use std::collections::HashSet;
use tauri::AppHandle;

// ---- 数据导入辅助 ----

/// 校验备份行数上限（在事务开始前调用，超限直接拒绝，零写入）
pub(crate) fn validate_backup_row_limits(dbx: &DatabaseExport) -> Result<(), AppError> {
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
pub(crate) fn validate_references(dbx: &DatabaseExport) -> Vec<String> {
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

/// 判断某张表是否存在指定主键行
pub(crate) fn existing_id(conn: &rusqlite::Connection, table: &str, id: &str) -> Result<bool, AppError> {
    let cnt: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {} WHERE id = ?1", table),
        params![id],
        |r| r.get(0),
    )?;
    Ok(cnt > 0)
}

/// 读取目标行 updated_at；仅 books/chapters/world_cards 拥有该列，
/// volumes/snapshots 返回 None（由调用方按「存在即保留目标」处理，二者无内容字段可择优）。
pub(crate) fn target_updated_at(
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
pub(crate) fn apply_upsert_data(
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
pub(crate) fn write_backup_data(
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
pub(crate) fn run_full_import(
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
pub(crate) fn run_single_import(
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

/// 版本兼容检查（Spec §2.2 / §10）：v1.x / v2.x 可导入；高于当前支持主版本 → E_BACKUP_VERSION
pub(crate) fn check_supported_version(version: &str) -> Result<(), AppError> {
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
pub(crate) fn load_backup_payload(file_path: &str) -> Result<(ExportPayload, u64), AppError> {
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
pub(crate) fn run_upsert_import(
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
