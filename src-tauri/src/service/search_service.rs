//! 搜索业务服务
//!
//! 封装 RAG 语义检索和 FTS5 全文搜索的业务逻辑。

use crate::commands::ai::embedding::call_embedding_api;
use crate::commands::ai::{truncate_for_embedding, EmbeddingProgress, EmbeddingStatus, RagResult};
use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{chapter_repo, embedding_repo, world_card_repo};
use crate::utils::{escape_fts5_query, like_pattern, snippet, strip_html};
use std::collections::HashMap;
use tauri::AppHandle;

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
        emit_sql_log(
            app,
            "SELECT",
            "embeddings",
            &format!("COUNT for book_id={book_id}"),
            file!(),
            line!(),
        );
        let emb_count = embedding_repo::count_indexed_for_book(&conn, book_id).unwrap_or(0);

        if emb_count > 0 {
            // 直接 await 异步调用，避免 block_on 死锁风险
            let query_vec = match call_embedding_api(ep, key, model, &[query.to_string()]).await {
                Ok(embs) => embs.into_iter().next(),
                Err(e) => {
                    crate::app_log_error!("Embedding API 调用失败，降级为关键词搜索: {e}");
                    None
                }
            };

            if let Some(qv) = query_vec {
                // 向量无命中或失败时降级关键词搜索（不直接抛错）
                match vector_search(app, &conn, book_id, &qv, top_n) {
                    Ok(results) if !results.is_empty() => return Ok(results),
                    Ok(_) => {
                        crate::app_log!("[rag] 向量搜索无命中，降级为关键词搜索");
                    }
                    Err(e) => {
                        crate::app_log!("[rag] 向量搜索失败，降级为关键词搜索: {e}");
                    }
                }
            }
        }
    }

    fts5_search(app, &conn, book_id, query, top_n)
}

/// 向量相似度搜索（sqlite-vec KNN，SQLite 内完成，内存占用 O(k)）
///
/// 流程：vec0 镜像表 KNN 取候选 → 按 embeddings.id 关联章节/卡片元数据并过滤书 →
/// Rust 侧仅对候选排序取 top_n。相比旧实现（全书向量加载进内存逐条余弦），
/// 向量扫描与距离计算全部下沉到 SQLite，大书库不再内存爆炸。
fn vector_search(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    book_id: &str,
    query_vec: &[f32],
    top_n: usize,
) -> Result<Vec<RagResult>, AppError> {
    // vec0 镜像表缺失（尚无向量数据）→ 空结果，由调用方降级关键词搜索
    if !embedding_repo::vec_table_exists(conn)? {
        crate::app_log!("[rag] vec0 镜像表不存在，跳过向量搜索");
        return Ok(vec![]);
    }

    // KNN 候选数放大：候选可能命中其他书籍，过滤后需保证本书仍有 ≥ top_n 结果
    let k = top_n.saturating_mul(50).clamp(200, 2000) as i64;
    let query_blob = crate::commands::ai::floats_to_bytes(query_vec);

    emit_sql_log(
        app,
        "SELECT",
        embedding_repo::VEC_TABLE,
        &format!("book_id={book_id}, KNN top-{k}"),
        file!(),
        line!(),
    );
    let hits = embedding_repo::knn_search(conn, &query_blob, k)?;
    if hits.is_empty() {
        return Ok(vec![]);
    }

    let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
    let mut sim_by_id: HashMap<i64, f64> = HashMap::with_capacity(ids.len());
    for (id, dist) in &hits {
        // vec0 cosine distance = 1 - cos；还原为相似度（越大越相关），clamp 防浮点越界
        sim_by_id.insert(*id, (1.0 - dist).clamp(0.0, 1.0));
    }

    emit_sql_log(
        app,
        "SELECT",
        "embeddings+chapters+world_cards",
        &format!("book_id={book_id}, resolve {} KNN candidates", ids.len()),
        file!(),
        line!(),
    );
    let chapter_rows = embedding_repo::find_chapter_meta_by_ids(conn, &ids, book_id)?;
    let card_rows = embedding_repo::find_world_card_meta_by_ids(conn, &ids, book_id)?;

    let mut scored: Vec<(f64, String, String, String, String)> = Vec::new();
    for (eid, sid, title, html) in chapter_rows {
        if let Some(&sim) = sim_by_id.get(&eid) {
            scored.push((
                sim,
                snippet(&strip_html(&html), 200),
                sid,
                title,
                "chapter".into(),
            ));
        }
    }
    for (eid, sid, title, html) in card_rows {
        if let Some(&sim) = sim_by_id.get(&eid) {
            scored.push((
                sim,
                snippet(&strip_html(&html), 200),
                sid,
                title,
                "world_card".into(),
            ));
        }
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
        emit_sql_log(
            app,
            "SELECT",
            "chapters_fts",
            &format!("book_id={book_id}, FTS5 MATCH"),
            file!(),
            line!(),
        );
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
        emit_sql_log(
            app,
            "SELECT",
            "world_cards_fts",
            &format!("book_id={book_id}, FTS5 MATCH"),
            file!(),
            line!(),
        );
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
        emit_sql_log(
            app,
            "SELECT",
            "chapters",
            &format!("book_id={book_id}, LIKE fallback"),
            file!(),
            line!(),
        );
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
        emit_sql_log(
            app,
            "SELECT",
            "world_cards",
            &format!("book_id={book_id}, LIKE fallback"),
            file!(),
            line!(),
        );
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

    emit_sql_log(
        app,
        "SELECT",
        "chapters",
        &format!("COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
    let total_chapters = chapter_repo::count_active_with_content(&conn, book_id)?;

    emit_sql_log(
        app,
        "SELECT",
        "world_cards",
        &format!("COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
    let total_world_cards = world_card_repo::count_with_content(&conn, book_id)?;

    emit_sql_log(
        app,
        "SELECT",
        "embeddings+chapters",
        &format!("indexed COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
    let indexed_chapters = embedding_repo::count_indexed_chapters(&conn, book_id)?;

    emit_sql_log(
        app,
        "SELECT",
        "embeddings+world_cards",
        &format!("indexed COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
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

        emit_sql_log(
            app,
            "SELECT",
            "chapters",
            &format!("book_id={book_id}, collect for embedding"),
            file!(),
            line!(),
        );
        let chapters: Vec<SourceItem> = chapter_repo::list_ids_and_content_plain(&conn, book_id)?
            .into_iter()
            .map(|(id, html)| SourceItem {
                source_type: "chapter".into(),
                source_id: id,
                plain_text: truncate_for_embedding(&strip_html(&html)),
            })
            .collect();
        let tc = chapters.len();

        emit_sql_log(
            app,
            "SELECT",
            "world_cards",
            &format!("book_id={book_id}, collect for embedding"),
            file!(),
            line!(),
        );
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
        let embeddings = call_embedding_api(endpoint, api_key, embedding_model, &texts).await?;

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
        emit_sql_log(
            app,
            "INSERT/UPDATE",
            "embeddings",
            &format!("batch write {} entries", results.len()),
            file!(),
            line!(),
        );
        for (stype, sid, blob) in &results {
            embedding_repo::upsert(&conn, stype, sid, blob, embedding_model)?;

            if stype == "world_card" {
                let _ = world_card_repo::mark_vectorized(&conn, sid);
            }
        }

        // 重建 vec0 KNN 镜像：embeddings upsert 可能变更 rowid（INSERT OR REPLACE），
        // 且模型维度可能变化，全量重建保证镜像与事实源一致。
        emit_sql_log(
            app,
            "REBUILD",
            embedding_repo::VEC_TABLE,
            &format!("rebuild after embedding trigger, {} entries", results.len()),
            file!(),
            line!(),
        );
        embedding_repo::rebuild_chunks_vec(&conn)?;
    }

    Ok(EmbeddingProgress {
        chapters_embedded,
        world_cards_embedded,
        total_chapters,
        total_world_cards,
        model: embedding_model.to_string(),
    })
}
