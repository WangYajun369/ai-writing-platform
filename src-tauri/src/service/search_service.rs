//! 搜索业务服务
//!
//! 封装 RAG 语义检索和 FTS5 全文搜索的业务逻辑。

use crate::commands::ai::embedding::call_embedding_api;
use crate::commands::ai::{truncate_for_embedding, EmbeddingProgress, EmbeddingStatus, RagResult};
use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{chapter_repo, embedding_repo, world_card_repo};
use crate::service::uow::UnitOfWork;
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
    // v1.9：迁移到 UnitOfWork。注意 async 函数不能跨 await 持有非 Send 的
    // UnitOfWork（内含 &rusqlite::Connection），因此把 embedding API 调用
    // 放在「不持有连接」的区间：先查计数→释放连接→await→再开连接做向量/FTS。

    // 阶段 1：检查是否有已索引向量，决定是否走向量搜索（查询后立即释放连接）
    let query_vec: Option<Vec<f32>> = if let (Some(ep), Some(key), Some(model)) =
        (endpoint, api_key, embedding_model)
    {
        // 用独立作用域包住 pooled + uow，确保 await 前连接已归还连接池
        let emb_count = {
            let pooled = db.pool.get()?;
            let mut uow = UnitOfWork::new(&pooled, Some(app));
            uow.audit(
                "SELECT",
                "embeddings",
                format!("COUNT for book_id={book_id}"),
                file!(),
                line!(),
            );
            let count = embedding_repo::count_indexed_for_book(uow.conn(), book_id).unwrap_or(0);
            uow.commit()?;
            count
        };

        if emb_count > 0 {
            // 直接 await 异步调用，避免 block_on 死锁风险（此时不持有任何 DB 连接）
            match call_embedding_api(ep, key, model, &[query.to_string()]).await {
                Ok(embs) => embs.into_iter().next(),
                Err(e) => {
                    crate::app_log_error!("Embedding API 调用失败，降级为关键词搜索: {e}");
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // 阶段 2：向量搜索或 FTS5 降级（统一一个 Uow，不再跨 await）
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));

    if let Some(qv) = query_vec {
        // 向量无命中或失败时降级关键词搜索（不直接抛错）
        match vector_search(&mut uow, book_id, &qv, top_n) {
            Ok(results) if !results.is_empty() => {
                uow.commit()?;
                return Ok(results);
            }
            Ok(_) => {
                crate::app_log!("[rag] 向量搜索无命中，降级为关键词搜索");
            }
            Err(e) => {
                crate::app_log!("[rag] 向量搜索失败，降级为关键词搜索: {e}");
            }
        }
    }

    let results = fts5_search(&mut uow, book_id, query, top_n)?;
    uow.commit()?;
    Ok(results)
}

/// 向量相似度搜索（sqlite-vec KNN，SQLite 内完成，内存占用 O(k)）
///
/// 流程：vec0 镜像表 KNN 取候选 → 按 embeddings.id 关联章节/卡片元数据并过滤书 →
/// Rust 侧仅对候选排序取 top_n。相比旧实现（全书向量加载进内存逐条余弦），
/// 向量扫描与距离计算全部下沉到 SQLite，大书库不再内存爆炸。
fn vector_search(
    uow: &mut UnitOfWork,
    book_id: &str,
    query_vec: &[f32],
    top_n: usize,
) -> Result<Vec<RagResult>, AppError> {
    // vec0 镜像表缺失（尚无向量数据）→ 空结果，由调用方降级关键词搜索
    if !embedding_repo::vec_table_exists(uow.conn())? {
        crate::app_log!("[rag] vec0 镜像表不存在，跳过向量搜索");
        return Ok(vec![]);
    }

    // KNN 候选数放大：候选可能命中其他书籍，过滤后需保证本书仍有 ≥ top_n 结果
    let k = top_n.saturating_mul(50).clamp(200, 2000) as i64;
    let query_blob = crate::commands::ai::floats_to_bytes(query_vec);

    uow.audit(
        "SELECT",
        embedding_repo::VEC_TABLE,
        format!("book_id={book_id}, KNN top-{k}"),
        file!(),
        line!(),
    );
    let hits = embedding_repo::knn_search(uow.conn(), &query_blob, k)?;
    if hits.is_empty() {
        return Ok(vec![]);
    }

    let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
    let mut sim_by_id: HashMap<i64, f64> = HashMap::with_capacity(ids.len());
    for (id, dist) in &hits {
        // vec0 cosine distance = 1 - cos；还原为相似度（越大越相关），clamp 防浮点越界
        sim_by_id.insert(*id, (1.0 - dist).clamp(0.0, 1.0));
    }

    uow.audit(
        "SELECT",
        "embeddings+chapters+world_cards",
        format!("book_id={book_id}, resolve {} KNN candidates", ids.len()),
        file!(),
        line!(),
    );
    let chapter_rows = embedding_repo::find_chapter_meta_by_ids(uow.conn(), &ids, book_id)?;
    let card_rows = embedding_repo::find_world_card_meta_by_ids(uow.conn(), &ids, book_id)?;

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
    uow: &mut UnitOfWork,
    book_id: &str,
    query: &str,
    top_n: usize,
) -> Result<Vec<RagResult>, AppError> {
    let mut results: Vec<RagResult> = Vec::new();
    let fts_query = escape_fts5_query(query);

    if fts_query.is_empty() {
        return like_search(uow, book_id, query, top_n);
    }

    // FTS5 章节搜索
    {
        uow.audit(
            "SELECT",
            "chapters_fts",
            format!("book_id={book_id}, FTS5 MATCH"),
            file!(),
            line!(),
        );
        let rows = chapter_repo::search_fts5_plain(uow.conn(), book_id, &fts_query, top_n as i64)?;
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
        uow.audit(
            "SELECT",
            "world_cards_fts",
            format!("book_id={book_id}, FTS5 MATCH"),
            file!(),
            line!(),
        );
        let rows = world_card_repo::search_fts5_plain(uow.conn(), book_id, &fts_query, remaining)?;
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
    uow: &mut UnitOfWork,
    book_id: &str,
    query: &str,
    top_n: usize,
) -> Result<Vec<RagResult>, AppError> {
    let pattern = like_pattern(query, 20);
    let mut results: Vec<RagResult> = Vec::new();

    // 章节 LIKE
    {
        uow.audit(
            "SELECT",
            "chapters",
            format!("book_id={book_id}, LIKE fallback"),
            file!(),
            line!(),
        );
        let rows = chapter_repo::search_like_plain(uow.conn(), book_id, &pattern, top_n as i64)?;
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
        uow.audit(
            "SELECT",
            "world_cards",
            format!("book_id={book_id}, LIKE fallback"),
            file!(),
            line!(),
        );
        let rows = world_card_repo::search_like_plain(uow.conn(), book_id, &pattern, remaining)?;
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
    // v1.9：迁移到 UnitOfWork（只读查询，autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));

    uow.audit(
        "SELECT",
        "chapters",
        format!("COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
    let total_chapters = chapter_repo::count_active_with_content(uow.conn(), book_id)?;

    uow.audit(
        "SELECT",
        "world_cards",
        format!("COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
    let total_world_cards = world_card_repo::count_with_content(uow.conn(), book_id)?;

    uow.audit(
        "SELECT",
        "embeddings+chapters",
        format!("indexed COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
    let indexed_chapters = embedding_repo::count_indexed_chapters(uow.conn(), book_id)?;

    uow.audit(
        "SELECT",
        "embeddings+world_cards",
        format!("indexed COUNT for book_id={book_id}"),
        file!(),
        line!(),
    );
    let indexed_world_cards = embedding_repo::count_indexed_world_cards(uow.conn(), book_id)?;

    let stale = total_chapters + total_world_cards > 0
        && (indexed_chapters < total_chapters || indexed_world_cards < total_world_cards);

    uow.commit()?;
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
    // 待向量化文档统一结构：章节与世界观卡片归一为同一批处理单元
    struct SourceItem {
        source_type: String,
        source_id: String,
        plain_text: String,
    }

    let (items, total_chapters, total_world_cards) = {
        // v1.9：迁移到 UnitOfWork（只读查询，autocommit 模式，审计统一收口）。
        let pooled = db.pool.get()?;
        let mut uow = UnitOfWork::new(&pooled, Some(app));

        uow.audit(
            "SELECT",
            "chapters",
            format!("book_id={book_id}, collect for embedding"),
            file!(),
            line!(),
        );
        let chapters: Vec<SourceItem> = chapter_repo::list_ids_and_content_plain(uow.conn(), book_id)?
            .into_iter()
            .map(|(id, html)| SourceItem {
                source_type: "chapter".into(),
                source_id: id,
                plain_text: truncate_for_embedding(&strip_html(&html)),
            })
            .collect();
        let tc = chapters.len();

        uow.audit(
            "SELECT",
            "world_cards",
            format!("book_id={book_id}, collect for embedding"),
            file!(),
            line!(),
        );
        let cards: Vec<SourceItem> = world_card_repo::list_ids_and_content_plain(uow.conn(), book_id)?
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

        uow.commit()?;
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

    // 每批 20 条调用一次 Embedding API，控制单次请求体量
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
        // v1.9：迁移到 UnitOfWork（批量写入 + 重建 vec，autocommit 模式，审计统一收口）。
        let pooled = db.pool.get()?;
        let mut uow = UnitOfWork::new(&pooled, Some(app));

        uow.audit(
            "INSERT/UPDATE",
            "embeddings",
            format!("batch write {} entries", results.len()),
            file!(),
            line!(),
        );
        for (stype, sid, blob) in &results {
            embedding_repo::upsert(uow.conn(), stype, sid, blob, embedding_model)?;

            if stype == "world_card" {
                let _ = world_card_repo::mark_vectorized(uow.conn(), sid);
            }
        }

        // 重建 vec0 KNN 镜像：embeddings upsert 可能变更 rowid（INSERT OR REPLACE），
        // 且模型维度可能变化，全量重建保证镜像与事实源一致。
        uow.audit(
            "REBUILD",
            embedding_repo::VEC_TABLE,
            format!("rebuild after embedding trigger, {} entries", results.len()),
            file!(),
            line!(),
        );
        embedding_repo::rebuild_chunks_vec(uow.conn())?;

        uow.commit()?;
    }

    Ok(EmbeddingProgress {
        chapters_embedded,
        world_cards_embedded,
        total_chapters,
        total_world_cards,
        model: embedding_model.to_string(),
    })
}
