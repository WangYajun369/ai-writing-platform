//! 搜索业务服务
//!
//! 封装 RAG 语义检索和 FTS5 全文搜索的业务逻辑。

use tauri::AppHandle;
use crate::db::AppDb;
use crate::error::AppError;
use crate::commands::ai::{RagResult, EmbeddingStatus, EmbeddingProgress, bytes_to_floats, cosine_similarity, truncate_for_embedding};
use crate::commands::ai::embedding::call_embedding_api;
use crate::commands::window::emit_sql_log;
use crate::utils::{strip_html, snippet, escape_fts5_query, like_pattern};
use crate::repository::{embedding_repo, chapter_repo, world_card_repo};

/// RAG 语义搜索（向量 + 关键词降级）
pub async fn rag_search(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    query: &str,
    top_n: usize,
    endpoint: Option<&str>,
    api_key: Option<&str>,
    embedding_model: Option<&str>,
) -> Result<Vec<RagResult>, AppError> {
    let conn = db.pool.get()?;

    // 尝试向量搜索
    if let (Some(ep), Some(key), Some(model)) = (endpoint, api_key, embedding_model) {
        emit_sql_log(app, "SELECT", "embeddings",
            &format!("COUNT for book_id={book_id}"), file!(), line!());
        let emb_count = embedding_repo::count_indexed_for_book(&conn, book_id).unwrap_or(0);

        if emb_count > 0 {
            // 直接 await 异步调用，避免 block_on 死锁风险
            let query_vec = match call_embedding_api(ep, key, model, &[query.to_string()]).await {
                Ok(embs) => embs.into_iter().next(),
                Err(e) => {
                    eprintln!("Embedding API 调用失败，降级为关键词搜索: {e}");
                    None
                }
            };

            if let Some(qv) = query_vec {
                return vector_search(app, &conn, book_id, &qv, top_n);
            }
        }
    }

    fts5_search(app, &conn, book_id, query, top_n)
}

/// 向量相似度搜索
fn vector_search(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    book_id: &str,
    query_vec: &[f32],
    top_n: usize,
) -> Result<Vec<RagResult>, AppError> {
    let mut all_rows: Vec<embedding_repo::EmbRow> = Vec::new();

    emit_sql_log(app, "SELECT", "embeddings+chapters",
        &format!("book_id={book_id}, embeddings for vector search"), file!(), line!());
    all_rows.extend(embedding_repo::list_chapter_embeddings(conn, book_id)?);

    emit_sql_log(app, "SELECT", "embeddings+world_cards",
        &format!("book_id={book_id}, embeddings for vector search"), file!(), line!());
    all_rows.extend(embedding_repo::list_world_card_embeddings(conn, book_id)?);

    let mut scored: Vec<(f64, String, String, String, String)> = Vec::new();
    for row in &all_rows {
        let emb_vec = bytes_to_floats(&row.embedding);
        let sim = cosine_similarity(query_vec, &emb_vec);
        let plain = strip_html(&row.content_html);
        let snip = snippet(&plain, 200);
        scored.push((
            sim,
            snip,
            row.source_id.clone(),
            row.title.clone(),
            row.source_type.clone(),
        ));
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_n);

    Ok(scored
        .into_iter()
        .map(|(dist, snip, sid, title, stype)| RagResult {
            snippet: snip,
            source_type: stype,
            source_id: sid,
            source_title: title,
            distance: dist,
        })
        .collect())
}

/// FTS5 全文搜索（含 LIKE 降级）
fn fts5_search(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    book_id: &str,
    query: &str,
    top_n: usize,
) -> Result<Vec<RagResult>, AppError> {
    let mut results: Vec<RagResult> = Vec::new();
    let fts_query = escape_fts5_query(query);

    if fts_query.is_empty() {
        return like_search(app, conn, book_id, query, top_n);
    }

    // FTS5 章节搜索
    {
        emit_sql_log(app, "SELECT", "chapters_fts",
            &format!("book_id={book_id}, FTS5 MATCH"), file!(), line!());
        let rows = chapter_repo::search_fts5_plain(conn, book_id, &fts_query, top_n as i64)?;
        for (id, title, html) in rows {
            let snip = snippet(&strip_html(&html), 200);
            results.push(RagResult {
                snippet: snip,
                source_type: "chapter".into(),
                source_id: id,
                source_title: title,
                distance: 0.5,
            });
        }
    }

    // FTS5 世界观卡片搜索
    if results.len() < top_n {
        let remaining = (top_n - results.len()) as i64;
        emit_sql_log(app, "SELECT", "world_cards_fts",
            &format!("book_id={book_id}, FTS5 MATCH"), file!(), line!());
        let rows = world_card_repo::search_fts5_plain(conn, book_id, &fts_query, remaining)?;
        for (id, title, html) in rows {
            let snip = snippet(&strip_html(&html), 200);
            results.push(RagResult {
                snippet: snip,
                source_type: "world_card".into(),
                source_id: id,
                source_title: title,
                distance: 0.5,
            });
        }
    }

    Ok(results)
}

/// LIKE 降级搜索
fn like_search(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    book_id: &str,
    query: &str,
    top_n: usize,
) -> Result<Vec<RagResult>, AppError> {
    let pattern = like_pattern(query, 20);
    let mut results: Vec<RagResult> = Vec::new();

    // 章节 LIKE
    {
        emit_sql_log(app, "SELECT", "chapters",
            &format!("book_id={book_id}, LIKE fallback"), file!(), line!());
        let rows = chapter_repo::search_like_plain(conn, book_id, &pattern, top_n as i64)?;
        for (id, title, html) in rows {
            let snip = snippet(&strip_html(&html), 200);
            results.push(RagResult {
                snippet: snip,
                source_type: "chapter".into(),
                source_id: id,
                source_title: title,
                distance: 0.5,
            });
        }
    }

    // 世界观卡片 LIKE
    if results.len() < top_n {
        let remaining = (top_n - results.len()) as i64;
        emit_sql_log(app, "SELECT", "world_cards",
            &format!("book_id={book_id}, LIKE fallback"), file!(), line!());
        let rows = world_card_repo::search_like_plain(conn, book_id, &pattern, remaining)?;
        for (id, title, html) in rows {
            let snip = snippet(&strip_html(&html), 200);
            results.push(RagResult {
                snippet: snip,
                source_type: "world_card".into(),
                source_id: id,
                source_title: title,
                distance: 0.5,
            });
        }
    }

    Ok(results)
}

/// 检查 Embedding 索引状态
pub fn check_embedding_status(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
) -> Result<EmbeddingStatus, AppError> {
    let conn = db.pool.get()?;

    emit_sql_log(app, "SELECT", "chapters", &format!("COUNT for book_id={book_id}"), file!(), line!());
    let total_chapters = chapter_repo::count_active_with_content(&conn, book_id)?;

    emit_sql_log(app, "SELECT", "world_cards", &format!("COUNT for book_id={book_id}"), file!(), line!());
    let total_world_cards = world_card_repo::count_with_content(&conn, book_id)?;

    emit_sql_log(app, "SELECT", "embeddings+chapters",
        &format!("indexed COUNT for book_id={book_id}"), file!(), line!());
    let indexed_chapters = embedding_repo::count_indexed_chapters(&conn, book_id)?;

    emit_sql_log(app, "SELECT", "embeddings+world_cards",
        &format!("indexed COUNT for book_id={book_id}"), file!(), line!());
    let indexed_world_cards = embedding_repo::count_indexed_world_cards(&conn, book_id)?;

    let stale = total_chapters + total_world_cards > 0
        && (indexed_chapters < total_chapters || indexed_world_cards < total_world_cards);

    Ok(EmbeddingStatus {
        total_chapters,
        total_world_cards,
        indexed_chapters,
        indexed_world_cards,
        stale,
    })
}

/// 触发 Embedding 生成
pub async fn trigger_embedding(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    endpoint: &str,
    api_key: &str,
    embedding_model: &str,
) -> Result<EmbeddingProgress, AppError> {
    struct SourceItem {
        source_type: String,
        source_id: String,
        plain_text: String,
    }

    let (items, total_chapters, total_world_cards) = {
        let conn = db.pool.get()?;

        emit_sql_log(app, "SELECT", "chapters",
            &format!("book_id={book_id}, collect for embedding"), file!(), line!());
        let chapters: Vec<SourceItem> = chapter_repo::list_ids_and_content_plain(&conn, book_id)?
            .into_iter()
            .map(|(id, html)| SourceItem {
                source_type: "chapter".into(),
                source_id: id,
                plain_text: truncate_for_embedding(&strip_html(&html)),
            })
            .collect();
        let tc = chapters.len();

        emit_sql_log(app, "SELECT", "world_cards",
            &format!("book_id={book_id}, collect for embedding"), file!(), line!());
        let cards: Vec<SourceItem> = world_card_repo::list_ids_and_content_plain(&conn, book_id)?
            .into_iter()
            .map(|(id, html)| SourceItem {
                source_type: "world_card".into(),
                source_id: id,
                plain_text: truncate_for_embedding(&strip_html(&html)),
            })
            .collect();
        let twc = cards.len();

        let mut all: Vec<SourceItem> = chapters;
        all.extend(cards);
        all.retain(|item| !item.plain_text.trim().is_empty());

        (all, tc, twc)
    };

    if items.is_empty() {
        return Ok(EmbeddingProgress {
            chapters_embedded: 0,
            world_cards_embedded: 0,
            total_chapters,
            total_world_cards,
            model: embedding_model.to_string(),
        });
    }

    const BATCH_SIZE: usize = 20;
    let mut chapters_embedded = 0usize;
    let mut world_cards_embedded = 0usize;
    let mut results: Vec<(String, String, Vec<u8>)> = Vec::with_capacity(items.len());

    for batch in items.chunks(BATCH_SIZE) {
        let texts: Vec<String> = batch.iter().map(|item| item.plain_text.clone()).collect();
        let embeddings = call_embedding_api(endpoint, api_key, embedding_model, &texts)
            .await?;

        if embeddings.len() != batch.len() {
            return Err(AppError::Business(format!(
                "Embedding API 返回数量不匹配: 期望 {} 条，实际 {} 条",
                batch.len(),
                embeddings.len()
            )));
        }

        for (item, emb) in batch.iter().zip(embeddings.iter()) {
            let blob = super::super::commands::ai::floats_to_bytes(emb);
            match item.source_type.as_str() {
                "chapter" => chapters_embedded += 1,
                "world_card" => world_cards_embedded += 1,
                _ => {}
            }
            results.push((item.source_type.clone(), item.source_id.clone(), blob));
        }
    }

    {
        let conn = db.pool.get()?;
        emit_sql_log(app, "INSERT/UPDATE", "embeddings",
            &format!("batch write {} entries", results.len()), file!(), line!());
        for (stype, sid, blob) in &results {
            embedding_repo::upsert(&conn, stype, sid, blob, embedding_model)?;

            if stype == "world_card" {
                let _ = world_card_repo::mark_vectorized(&conn, sid);
            }
        }
    }

    Ok(EmbeddingProgress {
        chapters_embedded,
        world_cards_embedded,
        total_chapters,
        total_world_cards,
        model: embedding_model.to_string(),
    })
}