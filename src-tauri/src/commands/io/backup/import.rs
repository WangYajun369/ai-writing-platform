//! 备份导入：只读载入校验 + 三策略写入（replace / merge / fill-gaps）
//!
//! 载入链路：文件级 → 解密 → 结构 → 版本 → 行数上限 → 语义校验，任何失败零写入；
//! replace 清空重建（配合回退点），merge/fill-gaps 单事务逐行择优写入。

use super::rollback::{clear_book_scope, clear_full_tables};
use super::types::{
    backup_is_newer, stats_to_json, DatabaseExport, ExportPayload, ImportStrategy, WriteStats,
    MAX_BACKUP_FILE_BYTES, MAX_BACKUP_ROWS,
};
use crate::commands::io::crypto::{parse_encrypted_file, validate_payload_structure};
use crate::error::{AppError, ErrCode};
use crate::service::uow::UnitOfWork;
use rusqlite::params;
use std::collections::HashSet;

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
        ("appConfig", dbx.app_config.len()),
        ("vocabWords", dbx.vocab_words.len()),
        ("vocabReviews", dbx.vocab_reviews.len()),
        ("vocabRelations", dbx.vocab_relations.len()),
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

    // 7) vocab_words：重复 id / 重复单词文本（表内 UNIQUE(word)，导入会撞约束）
    let mut seen_vocab_ids: HashSet<&str> = HashSet::new();
    let mut seen_vocab_words: HashSet<String> = HashSet::new();
    for w in &dbx.vocab_words {
        if !seen_vocab_ids.insert(w.id.as_str()) {
            issues.push(format!("vocabWords: 重复的生词 id={}", w.id));
        }
        let key = w.word.trim().to_lowercase();
        if !seen_vocab_words.insert(key.clone()) {
            issues.push(format!("vocabWords: 重复的单词 word=\"{}\"", w.word));
        }
    }

    // 8) vocab_reviews / vocab_word_relations：重复 id + word_id 悬空
    //    （外键开启，悬空行会让整次导入失败，故必须在预览阶段暴露）
    let mut seen_review_ids: HashSet<&str> = HashSet::new();
    for r in &dbx.vocab_reviews {
        if !seen_review_ids.insert(r.id.as_str()) {
            issues.push(format!("vocabReviews: 重复的复习记录 id={}", r.id));
        }
        if !seen_vocab_ids.contains(r.word_id.as_str()) {
            issues.push(format!(
                "vocabReviews: 复习记录 {} 引用了不存在的生词 wordId={}",
                r.id, r.word_id
            ));
        }
    }

    let mut seen_rel_ids: HashSet<&str> = HashSet::new();
    for r in &dbx.vocab_relations {
        if !seen_rel_ids.insert(r.id.as_str()) {
            issues.push(format!("vocabRelations: 重复的关联 id={}", r.id));
        }
        if !seen_vocab_ids.contains(r.word_id.as_str()) {
            issues.push(format!(
                "vocabRelations: 关联 {} 引用了不存在的生词 wordId={}",
                r.id, r.word_id
            ));
        }
    }

    issues
}

/// 判断某张表是否存在指定主键行
pub(crate) fn existing_id(
    conn: &rusqlite::Connection,
    table: &str,
    id: &str,
) -> Result<bool, AppError> {
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
        "books" | "chapters" | "world_cards" | "vocab_words" => {
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
                     created_at=?11, updated_at=?12, deleted_at=?13, outline=?14, book_type=?15 WHERE id=?1",
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
                        book.book_type,
                    ],
                )?;
                books_st.updated += 1;
            }
            Some(_) => {
                books_st.skipped += 1;
            }
            None => {
                conn.execute(
                    "INSERT INTO books (id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline,book_type) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                    params![
                        book.id, book.title, book.author, book.description,
                        book.cover_image, book.word_count, book.daily_target, book.today_count,
                        book.db_path, tags_json, book.created_at, book.updated_at,
                        book.deleted_at, book.outline, book.book_type,
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

    // 英语生词本：跨作品学习资产，一律 upsert 合并（不在任何策略下删除目标库数据）
    let (vocab_words_st, vocab_reviews_st, vocab_relations_st) =
        apply_vocab_upsert(conn, dbx, insert_only)?;

    Ok(serde_json::json!({
        "books": stats_to_json(&books_st),
        "volumes": stats_to_json(&volumes_st),
        "chapters": stats_to_json(&chapters_st),
        "snapshots": stats_to_json(&snapshots_st),
        "worldCards": stats_to_json(&world_cards_st),
        "vocabWords": stats_to_json(&vocab_words_st),
        "vocabReviews": stats_to_json(&vocab_reviews_st),
        "vocabRelations": stats_to_json(&vocab_relations_st),
    }))
}

/// 按单词文本查找生词 id（大小写不敏感），未收录返回 None
fn find_vocab_id_by_word(
    conn: &rusqlite::Connection,
    word: &str,
) -> Result<Option<String>, AppError> {
    let mut stmt = conn.prepare("SELECT id FROM vocab_words WHERE word = ?1 COLLATE NOCASE")?;
    let mut rows = stmt.query(params![word])?;
    match rows.next()? {
        Some(r) => Ok(Some(r.get(0)?)),
        None => Ok(None),
    }
}

/// 生词本三段写入（replace / merge / fill-gaps 共用）—— **只合并，绝不删除**
///
/// 与作品数据不同，生词本是跨作品的**持续积累型学习资产**，因此：
/// - 不参与 `clear_full_tables` 清空，也不进入回退点快照；
/// - 任何策略下都只做 upsert，旧备份（无 vocab 段）导入时目标库生词**零影响**；
/// - 外键开启（PRAGMA foreign_keys=ON）：子表（reviews / relations）的 word_id
///   在目标库不存在时整行跳过（计 skipped），避免孤儿行让整次导入失败。
pub(crate) fn apply_vocab_upsert(
    conn: &rusqlite::Connection,
    dbx: &DatabaseExport,
    insert_only: bool,
) -> Result<(WriteStats, WriteStats, WriteStats), AppError> {
    let mut words_st = WriteStats::default();
    let mut reviews_st = WriteStats::default();
    let mut relations_st = WriteStats::default();

    for w in &dbx.vocab_words {
        let meanings_json = serde_json::to_string(&w.meanings).unwrap_or_else(|_| "[]".to_string());
        let ai_details = serde_json::to_string(&w.knowledge).unwrap_or_default();

        // 同词不同 id（跨设备收录）时归并到目标库已有行，避免撞 UNIQUE(word)
        let mut row_id = find_vocab_id_by_word(conn, &w.word)?;
        if row_id.is_none() && existing_id(conn, "vocab_words", &w.id)? {
            row_id = Some(w.id.clone());
        }

        match row_id {
            Some(rid) => {
                match target_updated_at(conn, "vocab_words", &rid)? {
                    Some(target) if !insert_only && backup_is_newer(&w.updated_at, &target) => {
                        conn.execute(
                            "UPDATE vocab_words SET phonetic=?2, meanings=?3, example=?4, example_zh=?5, \
                             repetition=?6, interval_days=?7, ease_factor=?8, status=?9, \
                             next_review_at=?10, last_review_at=?11, review_count=?12, correct_count=?13, \
                             source=?14, ai_details=?15, created_at=?16, updated_at=?17 WHERE id=?1",
                            params![
                                rid,
                                w.phonetic,
                                meanings_json,
                                w.example,
                                w.example_zh,
                                w.repetition,
                                w.interval_days,
                                w.ease_factor,
                                w.status,
                                w.next_review_at,
                                w.last_review_at,
                                w.review_count,
                                w.correct_count,
                                w.source,
                                ai_details,
                                w.created_at,
                                w.updated_at,
                            ],
                        )?;
                        words_st.updated += 1;
                    }
                    _ => words_st.skipped += 1,
                }
            }
            None => {
                conn.execute(
                    "INSERT INTO vocab_words (id, word, phonetic, meanings, example, example_zh, \
                     repetition, interval_days, ease_factor, status, next_review_at, last_review_at, \
                     review_count, correct_count, source, ai_details, created_at, updated_at) \
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
                    params![
                        w.id,
                        w.word,
                        w.phonetic,
                        meanings_json,
                        w.example,
                        w.example_zh,
                        w.repetition,
                        w.interval_days,
                        w.ease_factor,
                        w.status,
                        w.next_review_at,
                        w.last_review_at,
                        w.review_count,
                        w.correct_count,
                        w.source,
                        ai_details,
                        w.created_at,
                        w.updated_at,
                    ],
                )?;
                words_st.inserted += 1;
            }
        }
    }

    // 复习日志：不可变历史，按 id 幂等插入；属主生词缺失（外键）则跳过
    for r in &dbx.vocab_reviews {
        if existing_id(conn, "vocab_reviews", &r.id)?
            || !existing_id(conn, "vocab_words", &r.word_id)?
        {
            reviews_st.skipped += 1;
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO vocab_reviews \
             (id, word_id, review_date, rating, repetition, interval_days, ease_factor, reviewed_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                r.id,
                r.word_id,
                r.review_date,
                r.rating,
                r.repetition,
                r.interval_days,
                r.ease_factor,
                r.reviewed_at,
            ],
        )?;
        reviews_st.inserted += 1;
    }

    // 单词关联：按 id 幂等 + UNIQUE 三元组天然去重；属主生词缺失（外键）则跳过
    for r in &dbx.vocab_relations {
        if existing_id(conn, "vocab_word_relations", &r.id)?
            || !existing_id(conn, "vocab_words", &r.word_id)?
        {
            relations_st.skipped += 1;
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO vocab_word_relations \
             (id, word_id, related_word, relation_type, source, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                r.id,
                r.word_id,
                r.related_word,
                r.relation_type,
                r.source,
                r.created_at,
            ],
        )?;
        relations_st.inserted += 1;
    }

    Ok((words_st, reviews_st, relations_st))
}

/// 将备份数据写入数据库（replace 语义专用：调用方已清空目标范围，直接全量插入）
///
/// v1.9：迁移到 UnitOfWork（审计统一收口，调用方负责事务边界）。
pub(crate) fn write_backup_data(
    uow: &mut UnitOfWork,
    dbx: &DatabaseExport,
) -> Result<(), AppError> {
    uow.audit(
        "INSERT",
        "books",
        format!("backup import: {} books", dbx.books.len()),
        file!(),
        line!(),
    );
    for book in &dbx.books {
        let tags_json = serde_json::to_string(&book.tags).unwrap_or_else(|_| "[]".to_string());
        uow.conn().execute(
            "INSERT INTO books (id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline,book_type) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                book.id, book.title, book.author, book.description,
                book.cover_image, book.word_count, book.daily_target, book.today_count,
                book.db_path, tags_json, book.created_at, book.updated_at,
                book.deleted_at, book.outline, book.book_type,
            ],
        )?;
    }

    uow.audit(
        "INSERT",
        "volumes",
        format!("backup import: {} volumes", dbx.volumes.len()),
        file!(),
        line!(),
    );
    for vol in &dbx.volumes {
        uow.conn().execute(
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

    uow.audit(
        "INSERT",
        "chapters",
        format!("backup import: {} chapters", dbx.chapters.len()),
        file!(),
        line!(),
    );
    for ch in &dbx.chapters {
        uow.conn().execute(
            "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                ch.id, ch.book_id, ch.volume_id, ch.title, ch.content_html,
                ch.word_count, ch.status, ch.sort_order, ch.created_at, ch.updated_at,
                ch.deleted_at, ch.summary, ch.summary_at, ch.outline,
            ],
        )?;
    }

    uow.audit(
        "INSERT",
        "snapshots",
        format!("backup import: {} snapshots", dbx.snapshots.len()),
        file!(),
        line!(),
    );
    for snap in &dbx.snapshots {
        uow.conn().execute(
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

    uow.audit(
        "INSERT",
        "world_cards",
        format!("backup import: {} world_cards", dbx.world_cards.len()),
        file!(),
        line!(),
    );
    for card in &dbx.world_cards {
        let tags_json = serde_json::to_string(&card.tags).unwrap_or_else(|_| "[]".to_string());
        uow.conn().execute(
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
///
/// v1.9：迁移到 UnitOfWork（调用方已开启事务，本函数不自行 commit）。
/// 恢复 app_config 配置段（仅全量导入调用）
///
/// 采用 **upsert 合并**语义而非 replace：只覆盖备份中出现的段，绝不删除目标库
/// 已有但备份里缺失的段。理由：
/// 1. `app_config` 不在 `RB_TABLES` 内（不被 `clear_full_tables` 清空），若这里再
///    做删除，旧版备份（无 appConfig 字段）会把用户现有配置清空回退成默认值；
/// 2. 配置是跨作品的全局状态，单作品导入本就不应触碰，全量导入也应保守合并。
///
/// 未知段名（未来新增段 / 降级导入）直接跳过，不阻断整体导入。
pub(crate) fn restore_app_config(
    uow: &mut UnitOfWork,
    rows: &[super::types::AppConfigExport],
) -> Result<usize, AppError> {
    if rows.is_empty() {
        return Ok(0);
    }
    let mut restored = 0usize;
    for row in rows {
        let Ok(section) = row.section.parse::<crate::config::model::ConfigSection>() else {
            // 未知段：跳过而非报错，保证向前/向后兼容
            continue;
        };
        uow.audit(
            "UPSERT",
            "app_config",
            format!("restore section={}", row.section),
            file!(),
            line!(),
        );
        crate::config::store::upsert(
            uow.conn(),
            section,
            &row.value,
            crate::config::CONFIG_VERSION,
        )?;
        restored += 1;
    }
    Ok(restored)
}

pub(crate) fn run_full_import(
    uow: &mut UnitOfWork,
    payload: &ExportPayload,
) -> Result<(), AppError> {
    uow.audit(
        "DELETE",
        "all tables",
        "full import: clearing all data".to_string(),
        file!(),
        line!(),
    );
    clear_full_tables(uow.conn())?;

    write_backup_data(uow, &payload.database)?;

    // 生词本：即使 replace 也走 upsert 合并（作品表已清空重建，学习资产不清空）。
    // 目标库已有的生词/复习记录/关联绝不因导入而丢失，只被备份中更新的行覆盖。
    let (w, r, rel) = apply_vocab_upsert(uow.conn(), &payload.database, false)?;
    if w.inserted + w.updated + r.inserted + rel.inserted > 0 {
        crate::app_log!(
            "[Backup] 生词本合并：词条 +{}/~{}，复习记录 +{}，关联 +{}",
            w.inserted,
            w.updated,
            r.inserted,
            rel.inserted
        );
    }

    // 业务数据写完后恢复配置段（AI 配置 / TTS / 偏好 / AI 工具箱分类）
    restore_app_config(uow, &payload.database.app_config)?;
    Ok(())
}

/// 执行单作品数据写入（事务内：仅删除目标作品数据 → 写入备份数据）
///
/// v1.9：迁移到 UnitOfWork（调用方已开启事务，本函数不自行 commit）。
pub(crate) fn run_single_import(
    uow: &mut UnitOfWork,
    payload: &ExportPayload,
    book_id: &str,
) -> Result<(), AppError> {
    uow.audit(
        "DELETE",
        "all tables",
        format!("single import: clearing data for book_id={book_id}"),
        file!(),
        line!(),
    );
    clear_book_scope(uow.conn(), book_id)?;

    write_backup_data(uow, &payload.database)?;

    // 单作品备份不携带生词本（作用域纯净），此处为空操作；保留调用以兼容未来扩展
    apply_vocab_upsert(uow.conn(), &payload.database, false)?;
    Ok(())
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
        .map_err(|e| AppError::business(ErrCode::BackupRead, format!("读取文件失败：{}", e)))?;
    if meta.len() > MAX_BACKUP_FILE_BYTES {
        return Err(AppError::Business(format!(
            "E_BACKUP_TOO_LARGE：备份文件大小 {:.1} MB 超过上限 200 MB",
            meta.len() as f64 / (1024.0 * 1024.0)
        )));
    }

    let file_bytes = std::fs::read(file_path)
        .map_err(|e| AppError::business(ErrCode::BackupRead, format!("读取文件失败：{}", e)))?;

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

/// 事务内执行非破坏性策略导入（merge / fill-gaps）。
///
/// v1.9：迁移到 UnitOfWork（事务边界 + 审计统一收口）。
/// 本函数消费 Uow 并在内部 commit；vec0 镜像对齐与过期回退点清理等
/// 最佳努力后置操作由调用方在 commit 后另行处理（与 replace 路径保持一致）。
pub(crate) fn run_upsert_import(
    mut uow: UnitOfWork,
    payload: &ExportPayload,
    strategy: ImportStrategy,
) -> Result<serde_json::Value, AppError> {
    uow.begin_transaction()
        .map_err(|e| AppError::business(ErrCode::BackupTxn, format!("开始事务失败: {}", e)))?;

    uow.audit(
        "MERGE",
        "all content tables",
        format!(
            "{} import: books={} volumes={} chapters={} snapshots={} worldCards={} \
             vocabWords={} vocabReviews={} vocabRelations={}",
            strategy.as_str(),
            payload.database.books.len(),
            payload.database.volumes.len(),
            payload.database.chapters.len(),
            payload.database.snapshots.len(),
            payload.database.world_cards.len(),
            payload.database.vocab_words.len(),
            payload.database.vocab_reviews.len(),
            payload.database.vocab_relations.len(),
        ),
        file!(),
        line!(),
    );

    let stats = match apply_upsert_data(
        uow.conn(),
        &payload.database,
        strategy == ImportStrategy::FillGaps,
    ) {
        Ok(s) => s,
        Err(e) => {
            // 出错时不手动回滚：Uow drop 自动回滚事务并丢弃审计条目
            return Err(AppError::Business(format!(
                "E_BACKUP_TXN：导入失败（事务已回滚，目标库未受影响）：{}",
                e
            )));
        }
    };

    uow.commit()
        .map_err(|e| AppError::business(ErrCode::BackupTxn, format!("提交事务失败: {}", e)))?;

    Ok(serde_json::json!({
        "cache": payload.cache,
        "backupType": payload.backup_type,
        "strategy": strategy.as_str(),
        "stats": stats,
        "rollbackTs": null,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建生词本三表（与生产 DDL 保持一致，外键开启）
    fn vocab_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE vocab_words (
                id TEXT PRIMARY KEY, word TEXT NOT NULL UNIQUE, phonetic TEXT NOT NULL DEFAULT '',
                meanings TEXT NOT NULL DEFAULT '[]', example TEXT NOT NULL DEFAULT '',
                example_zh TEXT NOT NULL DEFAULT '', repetition INTEGER NOT NULL DEFAULT 0,
                interval_days INTEGER NOT NULL DEFAULT 0, ease_factor REAL NOT NULL DEFAULT 2.5,
                status TEXT NOT NULL DEFAULT 'learning', next_review_at TEXT, last_review_at TEXT,
                review_count INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'manual', ai_details TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE vocab_reviews (
                id TEXT PRIMARY KEY,
                word_id TEXT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
                review_date TEXT NOT NULL, rating INTEGER NOT NULL, repetition INTEGER NOT NULL,
                interval_days INTEGER NOT NULL, ease_factor REAL NOT NULL, reviewed_at TEXT NOT NULL
             );
             CREATE TABLE vocab_word_relations (
                id TEXT PRIMARY KEY,
                word_id TEXT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
                related_word TEXT NOT NULL, relation_type TEXT NOT NULL, source TEXT NOT NULL,
                created_at TEXT NOT NULL, UNIQUE(word_id, related_word, relation_type)
             );",
        )
        .expect("create vocab schema");
        conn
    }

    /// 由三段 JSON 构造 DatabaseExport（其余段为空）
    fn dbx_with(words: serde_json::Value, reviews: serde_json::Value, rels: serde_json::Value) -> DatabaseExport {
        serde_json::from_value(serde_json::json!({
            "books": [], "volumes": [], "chapters": [], "snapshots": [],
            "worldCards": [], "embeddings": [],
            "vocabWords": words, "vocabReviews": reviews, "vocabRelations": rels,
        }))
        .expect("DatabaseExport 构造失败")
    }

    fn word_row(id: &str, word: &str, updated_at: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "word": word, "phonetic": "/wɜːd/",
            "meanings": [{ "pos": "n.", "def": "单词" }],
            "example": "a new word", "exampleZh": "一个新词",
            "repetition": 2, "intervalDays": 6, "easeFactor": 2.5, "status": "learning",
            "nextReviewAt": "2026-10-20", "lastReviewAt": "2026-10-14T00:00:00Z",
            "reviewCount": 2, "correctCount": 2, "source": "manual",
            "createdAt": "2026-10-01T00:00:00Z", "updatedAt": updated_at
        })
    }

    #[test]
    fn vocab_upsert_inserts_then_merges_by_updated_at() {
        let conn = vocab_conn();
        let dbx = dbx_with(
            serde_json::json!([word_row("vw1", "alpha", "2026-10-10T00:00:00Z")]),
            serde_json::json!([{
                "id": "vr1", "wordId": "vw1", "reviewDate": "2026-10-14", "rating": 3,
                "repetition": 2, "intervalDays": 6, "easeFactor": 2.5,
                "reviewedAt": "2026-10-14T00:00:00Z"
            }]),
            serde_json::json!([{
                "id": "rel1", "wordId": "vw1", "relatedWord": "beta",
                "relationType": "synonym", "source": "ai", "createdAt": "2026-10-14T00:00:00Z"
            }]),
        );

        // ① 首次导入：三段各插入 1 条
        let (w, r, rel) = apply_vocab_upsert(&conn, &dbx, false).unwrap();
        assert_eq!((w.inserted, w.updated, w.skipped), (1, 0, 0));
        assert_eq!(r.inserted, 1);
        assert_eq!(rel.inserted, 1);

        // ② 重复导入同内容：幂等（全部 skipped，不产生重复行）
        let (w2, r2, rel2) = apply_vocab_upsert(&conn, &dbx, false).unwrap();
        assert_eq!((w2.inserted, w2.updated, w2.skipped), (0, 0, 1));
        assert_eq!((r2.inserted, rel2.inserted), (0, 0));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM vocab_reviews", [], |x| x.get::<_, i64>(0))
                .unwrap(),
            1
        );

        // ③ 备份更新（updatedAt 更晚）→ merge 覆盖
        let newer = dbx_with(
            serde_json::json!([word_row("vw1", "alpha", "2026-10-15T00:00:00Z")]),
            serde_json::json!([]),
            serde_json::json!([]),
        );
        let (w3, _, _) = apply_vocab_upsert(&conn, &newer, false).unwrap();
        assert_eq!((w3.inserted, w3.updated, w3.skipped), (0, 1, 0));

        // ④ fill-gaps：已存在行一律跳过，新词插入
        let gaps = dbx_with(
            serde_json::json!([
                word_row("vw1", "alpha", "2026-10-16T00:00:00Z"),
                word_row("vw2", "gamma", "2026-10-16T00:00:00Z")
            ]),
            serde_json::json!([]),
            serde_json::json!([]),
        );
        let (w4, _, _) = apply_vocab_upsert(&conn, &gaps, true).unwrap();
        assert_eq!((w4.inserted, w4.updated, w4.skipped), (1, 0, 1));
        // fill-gaps 不覆盖已存在行
        let status: String = conn
            .query_row("SELECT updated_at FROM vocab_words WHERE word='alpha'", [], |x| x.get(0))
            .unwrap();
        assert_eq!(status, "2026-10-15T00:00:00Z");
    }

    #[test]
    fn vocab_upsert_merges_same_word_with_different_id() {
        let conn = vocab_conn();
        // 目标库已有 alpha（id=A），备份里的 alpha 是另一台设备生成的 id=B
        conn.execute(
            "INSERT INTO vocab_words (id, word, created_at, updated_at) \
             VALUES ('A','alpha','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let dbx = dbx_with(
            serde_json::json!([word_row("B", "alpha", "2026-10-15T00:00:00Z")]),
            serde_json::json!([]),
            serde_json::json!([]),
        );
        let (w, _, _) = apply_vocab_upsert(&conn, &dbx, false).unwrap();
        assert_eq!((w.inserted, w.updated, w.skipped), (0, 1, 0), "应按 word 归并更新");
        // 不产生第二行（UNIQUE(word) 未被撞）
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM vocab_words", [], |x| x.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn vocab_orphan_child_rows_are_skipped_not_error() {
        let conn = vocab_conn();
        // 子表属主 vw_missing 既不在备份也不在目标库 → 整行跳过（外键开启下不会报错）
        let dbx = dbx_with(
            serde_json::json!([]),
            serde_json::json!([{
                "id": "vrx", "wordId": "vw_missing", "reviewDate": "2026-10-14", "rating": 3,
                "repetition": 1, "intervalDays": 1, "easeFactor": 2.5,
                "reviewedAt": "2026-10-14T00:00:00Z"
            }]),
            serde_json::json!([{
                "id": "relx", "wordId": "vw_missing", "relatedWord": "beta",
                "relationType": "synonym", "source": "ai", "createdAt": "2026-10-14T00:00:00Z"
            }]),
        );
        let (_, r, rel) = apply_vocab_upsert(&conn, &dbx, false).unwrap();
        assert_eq!(r.skipped, 1);
        assert_eq!(rel.skipped, 1);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM vocab_word_relations", [], |x| x.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn vocab_references_detect_duplicate_and_dangling() {
        let dbx = dbx_with(
            serde_json::json!([
                word_row("vw1", "alpha", "2026-10-10T00:00:00Z"),
                word_row("vw1", "beta", "2026-10-10T00:00:00Z")
            ]),
            serde_json::json!([{
                "id": "vr1", "wordId": "no_such_word", "reviewDate": "2026-10-14", "rating": 3,
                "repetition": 1, "intervalDays": 1, "easeFactor": 2.5,
                "reviewedAt": "2026-10-14T00:00:00Z"
            }]),
            serde_json::json!([]),
        );
        let issues = validate_references(&dbx);
        assert!(issues.iter().any(|i| i.contains("vocabWords: 重复的生词 id")));
        assert!(issues.iter().any(|i| i.contains("vocabReviews: 复习记录")));
    }

    #[test]
    fn legacy_backup_without_vocab_section_is_noop() {
        // 旧版备份（无 vocab 三段）：反序列化为空 → 写入零影响
        let conn = vocab_conn();
        conn.execute(
            "INSERT INTO vocab_words (id, word, created_at, updated_at) \
             VALUES ('keep','keep','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let dbx: DatabaseExport = serde_json::from_value(serde_json::json!({
            "books": [], "volumes": [], "chapters": [], "snapshots": [],
            "worldCards": [], "embeddings": []
        }))
        .expect("旧版载荷应能反序列化");
        assert!(dbx.vocab_words.is_empty());
        let (w, r, rel) = apply_vocab_upsert(&conn, &dbx, false).unwrap();
        assert_eq!((w.inserted, w.updated, w.skipped), (0, 0, 0));
        assert_eq!((r.inserted, rel.inserted), (0, 0));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM vocab_words", [], |x| x.get::<_, i64>(0))
                .unwrap(),
            1,
            "目标库已有生词必须保留"
        );
    }
}
