use tauri::{AppHandle, Emitter, State};
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;
use tokio::time::timeout;
use crate::db::AppDb;

// ---- RAG & Embedding 公共结构 ----

/// Embedding 索引状态（用于检测是否需要重新生成）
#[derive(Serialize)]
pub struct EmbeddingStatus {
    #[serde(rename = "totalChapters")]
    pub total_chapters: usize,
    #[serde(rename = "totalWorldCards")]
    pub total_world_cards: usize,
    #[serde(rename = "indexedChapters")]
    pub indexed_chapters: usize,
    #[serde(rename = "indexedWorldCards")]
    pub indexed_world_cards: usize,
    /// 是否有未索引的内容（新增/修改后需重新生成）
    pub stale: bool,
}

#[derive(Serialize)]
pub struct RagResult {
    pub snippet: String,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    pub distance: f64,
}

/// Embedding 生成进度返回给前端
#[derive(Serialize)]
pub struct EmbeddingProgress {
    #[serde(rename = "chaptersEmbedded")]
    pub chapters_embedded: usize,
    #[serde(rename = "worldCardsEmbedded")]
    pub world_cards_embedded: usize,
    #[serde(rename = "totalChapters")]
    pub total_chapters: usize,
    #[serde(rename = "totalWorldCards")]
    pub total_world_cards: usize,
    pub model: String,
}

// ---- 向量工具函数 ----

/// f32 切片序列化为字节 BLOB
fn floats_to_bytes(floats: &[f32]) -> Vec<u8> {
    floats.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// 从字节 BLOB 反序列化为 f32 向量
fn bytes_to_floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// 余弦相似度（返回 0.0 ~ 1.0）
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let len = a.len().min(b.len());
    let (dot, na, nb) = a[..len].iter().zip(b[..len].iter()).fold(
        (0.0f64, 0.0f64, 0.0f64),
        |(d, x, y), (&ai, &bi)| {
            let af = ai as f64;
            let bf = bi as f64;
            (d + af * bf, x + af * af, y + bf * bf)
        },
    );
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// 简单 HTML 标签剥离
fn strip_html(html: &str) -> String {
    let re = regex_lite::Regex::new(r"<[^>]*>").unwrap();
    re.replace_all(html, "").to_string()
}

/// 截取文本片段（前 N 个可见字符）
fn snippet(text: &str, max_chars: usize) -> String {
    let cleaned: String = text.chars().filter(|&c| c != '\n' && c != '\r').collect();
    if cleaned.chars().count() <= max_chars {
        cleaned
    } else {
        cleaned.chars().take(max_chars).chain(['…']).collect()
    }
}

/// 截断文本以适应 Embedding API 的 token 限制
///
/// embedding-3 单条最多 3072 tokens，中文约 1.5 token/字，
/// 保守截断到 1800 字符以留有余量。
const EMBEDDING_MAX_CHARS: usize = 1800;

fn truncate_for_embedding(text: &str) -> String {
    if text.chars().count() <= EMBEDDING_MAX_CHARS {
        text.to_string()
    } else {
        // 截取前 1800 个字符，确保不超 token 限制
        text.chars().take(EMBEDDING_MAX_CHARS).collect()
    }
}

/// AI 连接测试结果
#[derive(Debug, Serialize)]
pub struct ConnectionTestResult {
    /// 是否连接成功
    pub ok: bool,
    /// 成功时返回可用模型列表，失败时返回错误信息
    pub detail: String,
}

/// 测试 AI 服务连接：GET /models，验证可达性和认证
#[tauri::command]
pub async fn test_ai_connection(
    _provider: String,
    endpoint: String,
    api_key: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(10))
        .http1_only()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/models", endpoint.trim_end_matches('/'));

    let mut req = client.get(&url);
    if let Some(ref key) = api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("无法连接到 AI 服务: {}\n请检查 API 地址和网络连接", e))?;

    let status = response.status();

    if status.is_success() {
        match response.json::<serde_json::Value>().await {
            Ok(data) => {
                let models: Vec<String> = data["data"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m["id"].as_str().map(String::from))
                            .take(10)
                            .collect()
                    })
                    .unwrap_or_default();

                let detail = if models.is_empty() {
                    "AI 服务已连接".to_string()
                } else if models.len() >= 10 {
                    format!("AI 服务已连接，可用模型: {}...", models.join(", "))
                } else {
                    format!("AI 服务已连接，可用模型: {}", models.join(", "))
                };
                Ok(ConnectionTestResult { ok: true, detail })
            }
            Err(_) => Ok(ConnectionTestResult {
                ok: true,
                detail: "AI 服务已连接（无法解析模型列表）".to_string(),
            }),
        }
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        Ok(ConnectionTestResult {
            ok: false,
            detail: "认证失败 (401): API Key 无效或未提供".to_string(),
        })
    } else {
        let text = response.text().await.unwrap_or_default();
        Ok(ConnectionTestResult {
            ok: false,
            detail: format!("AI 服务返回错误 ({}): {}", status, text),
        })
    }
}

// ---- RAG 语义检索与 Embedding ----

/// 测试 RAG Embedding API 是否可用：发送一条简单文本调用 /embeddings 接口验证连通性
#[tauri::command]
pub async fn test_rag_connection(
    endpoint: String,
    api_key: String,
    embedding_model: String,
) -> Result<ConnectionTestResult, String> {
    match call_embedding_api(&endpoint, &api_key, &embedding_model, &["测试连通性".into()]).await {
        Ok(results) => {
            let dim = results.first().map(|v| v.len()).unwrap_or(0);
            Ok(ConnectionTestResult {
                ok: true,
                detail: format!("RAG Embedding 服务已连接，{} 模型返回向量维度: {}", embedding_model, dim),
            })
        }
        Err(e) => Ok(ConnectionTestResult {
            ok: false,
            detail: format!("RAG Embedding 连接失败: {}", e),
        }),
    }
}

/// 调用 SSE 兼容的 Embedding API（智谱等）
async fn call_embedding_api(
    endpoint: &str,
    api_key: &str,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .http1_only()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!("{}/embeddings", endpoint.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "input": texts,
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Embedding API 请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_text = resp.text().await.unwrap_or_default();

        // 尝试解析 BigModel 错误码，提供友好提示
        let hint = if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&err_text) {
            if let Some(code) = err_json["error"]["code"].as_str() {
                match code {
                    "1210" | "1214" => "（可能原因：单条文本超过了 3072 tokens 限制，已自动截断到 1800 字符；如仍报错请检查 API Key 是否有 Embedding 模型权限）",
                    "1211" => "（模型不存在，请检查 Embedding 模型名称配置）",
                    "1213" => "（缺少必填参数，可能是请求体格式异常）",
                    _ => "",
                }
            } else { "" }
        } else { "" };
        return Err(format!("Embedding API 返回错误 ({}): {} {}", status, err_text, hint));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let items = data["data"]
        .as_array()
        .ok_or_else(|| format!("Embedding API 返回格式异常: 缺少 data 数组"))?;

    // 按 index 排序确保输出顺序与输入一致
    let mut indexed: Vec<(usize, Vec<f32>)> = Vec::new();
    for item in items {
        let idx = item["index"].as_u64().unwrap_or(0) as usize;
        if let Some(vec) = item["embedding"].as_array() {
            let floats: Vec<f32> = vec
                .iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect();
            indexed.push((idx, floats));
        }
    }
    indexed.sort_by_key(|(i, _)| *i);

    Ok(indexed.into_iter().map(|(_, v)| v).collect())
}

/// RAG 语义检索（向量相似度搜索）
///
/// 同时检索章节和世界观卡片的内容。
/// 当 embeddings 表有数据时使用向量搜索，否则降级为 SQL LIKE。
#[tauri::command]
pub async fn rag_search(
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
    top_n: usize,
    endpoint: Option<String>,
    api_key: Option<String>,
    embedding_model: Option<String>,
) -> Result<Vec<RagResult>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

    // 尝试向量检索
    if let (Some(ref ep), Some(ref key), Some(ref model)) = (&endpoint, &api_key, &embedding_model) {
        // 检查该书籍是否有已生成的 embedding（章节 + 世界观卡片，仅非空内容）
        let emb_count: i64 = conn
            .query_row(
                "SELECT (
                    SELECT COUNT(*) FROM embeddings e
                    INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
                    WHERE c.book_id = ?1 AND c.deleted_at IS NULL AND c.content_html != ''
                ) + (
                    SELECT COUNT(*) FROM embeddings e
                    INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
                    WHERE w.book_id = ?1 AND w.content_html != ''
                )",
                rusqlite::params![book_id],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if emb_count > 0 {
            // 使用向量搜索
            match call_embedding_api(ep, key, model, &[query.clone()]).await {
                Ok(query_embs) => {
                    if let Some(query_vec) = query_embs.into_iter().next() {
                        return vector_search(&conn, &book_id, &query_vec, top_n);
                    }
                }
                Err(e) => eprintln!("Embedding API 调用失败，降级为关键词搜索: {}", e),
            }
        }
    }

    // 降级：SQL LIKE 关键词搜索（章节 + 世界观卡片）
    like_search(&conn, &book_id, &query, top_n)
}

/// 向量相似度搜索（章节 + 世界观卡片）
fn vector_search(
    conn: &rusqlite::Connection,
    book_id: &str,
    query_vec: &[f32],
    top_n: usize,
) -> Result<Vec<RagResult>, String> {
    struct EmbRow {
        source_type: String,
        source_id: String,
        embedding: Vec<u8>,
        title: String,
        content_html: String,
    }

    let mut all_rows: Vec<EmbRow> = Vec::new();

    // 查询该书籍所有章节的 embedding
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.source_id, e.embedding, c.title, c.content_html
                 FROM embeddings e
                 INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
                 WHERE c.book_id = ?1 AND c.deleted_at IS NULL",
            )
            .map_err(|e| e.to_string())?;

        let chapter_rows: Vec<EmbRow> = stmt
            .query_map(rusqlite::params![book_id], |row| {
                Ok(EmbRow {
                    source_type: "chapter".into(),
                    source_id: row.get(0)?,
                    embedding: row.get(1)?,
                    title: row.get(2)?,
                    content_html: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        all_rows.extend(chapter_rows);
    }

    // 查询该书籍所有世界观卡片的 embedding
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.source_id, e.embedding, w.title, w.content_html
                 FROM embeddings e
                 INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
                 WHERE w.book_id = ?1",
            )
            .map_err(|e| e.to_string())?;

        let card_rows: Vec<EmbRow> = stmt
            .query_map(rusqlite::params![book_id], |row| {
                Ok(EmbRow {
                    source_type: "world_card".into(),
                    source_id: row.get(0)?,
                    embedding: row.get(1)?,
                    title: row.get(2)?,
                    content_html: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        all_rows.extend(card_rows);
    }

    // 计算余弦相似度并排序
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

/// 降级的 SQL LIKE 搜索（章节 + 世界观卡片）
fn like_search(
    conn: &rusqlite::Connection,
    book_id: &str,
    query: &str,
    top_n: usize,
) -> Result<Vec<RagResult>, String> {
    let pattern = format!("%{}%", query.chars().take(20).collect::<String>());
    let mut results: Vec<RagResult> = Vec::new();

    // 搜索章节
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, content_html FROM chapters
                 WHERE book_id=?1 AND content_html LIKE ?2 AND deleted_at IS NULL LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;

        let chapter_results = stmt
            .query_map(
                rusqlite::params![book_id, &pattern, top_n as i64],
                |row| {
                    let id: String = row.get(0)?;
                    let title: String = row.get(1)?;
                    let html: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
                    let snip = snippet(&strip_html(&html), 200);
                    Ok(RagResult {
                        snippet: snip,
                        source_type: "chapter".into(),
                        source_id: id,
                        source_title: title,
                        distance: 0.5,
                    })
                },
            )
            .map_err(|e| e.to_string())?;

        for r in chapter_results {
            if let Ok(item) = r {
                results.push(item);
            }
        }
    }

    // 搜索世界观卡片
    if results.len() < top_n {
        let remaining = (top_n - results.len()) as i64;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, content_html FROM world_cards
                 WHERE book_id=?1 AND content_html LIKE ?2 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;

        let card_results = stmt
            .query_map(
                rusqlite::params![book_id, &pattern, remaining],
                |row| {
                    let id: String = row.get(0)?;
                    let title: String = row.get(1)?;
                    let html: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
                    let snip = snippet(&strip_html(&html), 200);
                    Ok(RagResult {
                        snippet: snip,
                        source_type: "world_card".into(),
                        source_id: id,
                        source_title: title,
                        distance: 0.5,
                    })
                },
            )
            .map_err(|e| e.to_string())?;

        for r in card_results {
            if let Ok(item) = r {
                results.push(item);
            }
        }
    }

    Ok(results)
}

/// 检查 Embedding 索引状态：对比章节/世界观卡片数量与已索引数量
///
/// 返回是否过期（stale），前端可根据此提示用户重新生成索引。
#[tauri::command]
pub fn check_embedding_status(
    db: State<'_, AppDb>,
    book_id: String,
) -> Result<EmbeddingStatus, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

    let total_chapters: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ?1 AND deleted_at IS NULL AND content_html != ''",
            rusqlite::params![&book_id],
            |row| row.get::<_, i64>(0).map(|v| v as usize),
        )
        .unwrap_or(0);

    let total_world_cards: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM world_cards WHERE book_id = ?1 AND content_html != ''",
            rusqlite::params![&book_id],
            |row| row.get::<_, i64>(0).map(|v| v as usize),
        )
        .unwrap_or(0);

    let indexed_chapters: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM embeddings e
             INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
             WHERE c.book_id = ?1 AND c.deleted_at IS NULL AND c.content_html != ''",
            rusqlite::params![&book_id],
            |row| row.get::<_, i64>(0).map(|v| v as usize),
        )
        .unwrap_or(0);

    let indexed_world_cards: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM embeddings e
             INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
             WHERE w.book_id = ?1 AND w.content_html != ''",
            rusqlite::params![&book_id],
            |row| row.get::<_, i64>(0).map(|v| v as usize),
        )
        .unwrap_or(0);

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

/// 触发 Embedding 生成：为指定书籍的所有章节和世界观卡片生成向量
///
/// 调用 /embeddings API，批量生成后写入 embeddings 表。
#[tauri::command]
pub async fn trigger_embedding(
    db: State<'_, AppDb>,
    book_id: String,
    endpoint: String,
    api_key: String,
    embedding_model: String,
) -> Result<EmbeddingProgress, String> {
    /// 待嵌入的数据项
    struct SourceItem {
        source_type: String,
        source_id: String,
        plain_text: String,
    }

    // 在块内收集所有数据，确保 statement 在 await 前释放
    let (items, total_chapters, total_world_cards) = {
        let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

        // 收集章节
        let mut chap_stmt = conn
            .prepare(
                "SELECT id, content_html FROM chapters
                 WHERE book_id = ?1 AND deleted_at IS NULL AND content_html != ''",
            )
            .map_err(|e| e.to_string())?;

        let chapters: Vec<SourceItem> = chap_stmt
            .query_map(rusqlite::params![&book_id], |row| {
                let id: String = row.get(0)?;
                let html: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
                Ok(SourceItem {
                    source_type: "chapter".into(),
                    source_id: id,
                    plain_text: truncate_for_embedding(&strip_html(&html)),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let tc = chapters.len();

        // 收集世界观卡片
        let mut card_stmt = conn
            .prepare(
                "SELECT id, content_html FROM world_cards WHERE book_id = ?1 AND content_html != ''",
            )
            .map_err(|e| e.to_string())?;

        let cards: Vec<SourceItem> = card_stmt
            .query_map(rusqlite::params![&book_id], |row| {
                let id: String = row.get(0)?;
                let html: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
                Ok(SourceItem {
                    source_type: "world_card".into(),
                    source_id: id,
                    plain_text: truncate_for_embedding(&strip_html(&html)),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let twc = cards.len();

        let mut all: Vec<SourceItem> = chapters;
        all.extend(cards);
        // 过滤空文本
        all.retain(|item| !item.plain_text.trim().is_empty());

        (all, tc, twc)
    }; // conn + statements 在此释放

    if items.is_empty() {
        return Ok(EmbeddingProgress {
            chapters_embedded: 0,
            world_cards_embedded: 0,
            total_chapters,
            total_world_cards,
            model: embedding_model,
        });
    }

    // 批量调用 Embedding API（每次最多 20 条）
    const BATCH_SIZE: usize = 20;
    let mut chapters_embedded = 0usize;
    let mut world_cards_embedded = 0usize;

    // 预分配结果容器，避免每次获取新连接
    let mut results: Vec<(String, String, Vec<u8>)> = Vec::with_capacity(items.len());

    for batch in items.chunks(BATCH_SIZE) {
        let texts: Vec<String> = batch.iter().map(|item| item.plain_text.clone()).collect();
        let embeddings = call_embedding_api(&endpoint, &api_key, &embedding_model, &texts).await?;

        if embeddings.len() != batch.len() {
            return Err(format!(
                "Embedding API 返回数量不匹配: 期望 {} 条，实际 {} 条",
                batch.len(),
                embeddings.len()
            ));
        }

        for (item, emb) in batch.iter().zip(embeddings.iter()) {
            let blob = floats_to_bytes(emb);
            match item.source_type.as_str() {
                "chapter" => chapters_embedded += 1,
                "world_card" => world_cards_embedded += 1,
                _ => {}
            }
            results.push((item.source_type.clone(), item.source_id.clone(), blob));
        }
    }

    // 批量写入数据库
    {
        let conn = db.pool.get().map_err(|e| format!("获取写入连接失败: {}", e))?;
        for (stype, sid, blob) in &results {
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (source_type, source_id, embedding, model)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![stype, sid, blob, embedding_model],
            )
            .map_err(|e| format!("写入 embedding 失败: {}", e))?;

            if stype == "world_card" {
                let _ = conn.execute(
                    "UPDATE world_cards SET vectorized = 1 WHERE id = ?1",
                    rusqlite::params![sid],
                );
            }
        }
    }

    Ok(EmbeddingProgress {
        chapters_embedded,
        world_cards_embedded,
        total_chapters,
        total_world_cards,
        model: embedding_model,
    })
}

// ---- AI 流式对话 ----

/// 单条消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 流式对话请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChatArgs {
    /// 服务商标识（如 "sse" 等，前端传入，后端不再做提供者路由）
    pub provider: String,
    /// API 端点 URL（不含路径）
    pub endpoint: String,
    /// 模型名
    pub model: String,
    /// 温度
    pub temperature: f64,
    /// max_tokens
    pub max_tokens: Option<u32>,
    /// API Key
    pub api_key: Option<String>,
    /// 消息列表（system + history + user）
    pub messages: Vec<ChatMessage>,
    /// DeepSeek 思考模式开关
    pub thinking_enabled: Option<bool>,
}

/// Token/字数用量统计
#[derive(Debug, Clone, Serialize)]
pub struct UsageInfo {
    #[serde(rename = "inputTokens")]
    pub input_tokens: u32,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u32,
    #[serde(rename = "inputChars")]
    pub input_chars: usize,
    #[serde(rename = "outputChars")]
    pub output_chars: usize,
}

/// 向前端推送的流式事件负载
#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    /// 当前累积的正式输出文本
    pub content: String,
    /// 当前累积的思考过程（智谱/DeepSeek 推理模型的 reasoning_content）
    pub thinking: String,
    /// 当前阶段："thinking" | "answering" | "done"
    pub phase: String,
    /// 是否完成
    pub done: bool,
    /// 错误信息（仅出错时非空）
    pub error: Option<String>,
    /// 用量统计（仅 done 事件有值）
    pub usage: Option<UsageInfo>,
}

/// AI 流式对话命令（SSE 流式协议，兼容智谱等 API）
///
/// 通过 reqwest 发起流式 HTTP 请求，将增量文本通过 Tauri 事件
/// `ai-stream-chunk` 实时推送到前端。返回最终的完整文本。
///
/// 内置自动重试机制：当流请求因网络抖动、连接中断等可恢复错误
/// 失败（且未收到任何生成内容）时，最多自动重试 2 次，采用指数退避。
#[tauri::command]
pub async fn stream_ai_chat(
    app: AppHandle,
    args: StreamChatArgs,
) -> Result<String, String> {
    // 流式对话不设 total/read timeout，允许 AI 长时间思考与生成
    // 仅保留 connect_timeout 防止无法连上服务
    // 禁用自动解压：AI 流式响应的每个 chunk 通常为纯文本 JSON，
    // 服务端一般不压缩 SSE 流，若开启 gzip/brotli 自动解压，
    // 流中断时会导致 "error decoding response body" 无法恢复部分内容
    // TCP keepalive 120s：防止 GLM-5.1 等推理模型长思考期间被中间代理断连
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .tcp_keepalive(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    const MAX_RETRIES: u32 = 2;
    let mut last_error = String::new();

    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            let delay_ms = 1000 * 2u64.pow(attempt - 1);
            eprintln!(
                "AI 流式对话失败（{}），{}ms 后第 {} 次重试（共 {} 次）",
                last_error, delay_ms, attempt, MAX_RETRIES
            );
            let _ = app.emit("ai-stream-chunk", StreamEvent {
                content: String::new(),
                thinking: String::new(),
                phase: "retrying".into(),
                done: false,
                error: Some(format!(
                    "网络波动，正在自动重试 ({}/{})...",
                    attempt, MAX_RETRIES
                )),
                usage: None,
            });
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }

        match stream_sse(app.clone(), client.clone(), args.clone()).await {
            // 成功拿到内容（含网络中断后保留的部分内容）
            Ok(content) if !content.is_empty() => {
                return Ok(content);
            }
            // 空内容（服务端连接成功但无输出），值得重试
            Ok(_) => {
                last_error = "AI 返回空内容".to_string();
            }
            // 流请求失败，根据错误类型决定是否重试
            Err(e) => {
                last_error = e;
                if !is_retryable_error(&last_error) {
                    return Err(last_error);
                }
            }
        }
    }

    Err(last_error)
}

/// 判断流式请求错误是否可重试（网络抖动/临时性错误），排除认证、权限等永久性错误
fn is_retryable_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    // 网络相关：超时、连接中断、EOF、管道断裂
    lower.contains("timeout")
    || lower.contains("超时")
    || lower.contains("connection")
    || lower.contains("connect")
    || lower.contains("network")
    || lower.contains("eof")
    || lower.contains("reset")
    || lower.contains("broken pipe")
    || lower.contains("unexpected eof")
    // 服务端临时错误
    || lower.contains("500") || lower.contains("502")
    || lower.contains("503") || lower.contains("504")
    || lower.contains("temporary")
    || lower.contains("unavailable")
    || lower.contains("too many requests")
    || lower.contains("429")
    // 业务层：空内容
    || lower.contains("空内容")
    || lower.contains("读取超时")
}

/// 刷新 SSE buffer 中的残留数据（流中断或正常结束时调用）
/// 尝试提取最后不完整的 SSE 行中的 content/reasoning_content/usage
fn flush_sse_buffer(
    accumulated: &mut String,
    accumulated_thinking: &mut String,
    buffer: &mut String,
    sse_usage: &mut Option<(u32, u32)>,
    app: &AppHandle,
) {
    let remaining = buffer.trim().to_string();
    buffer.clear();
    if remaining.is_empty() || !remaining.starts_with("data:") {
        return;
    }
    let json_str = remaining[5..].trim();
    if json_str == "[DONE]" {
        return;
    }
    if let Ok(data) = serde_json::from_str::<serde_json::Value>(json_str) {
        if let Some(u) = data["usage"].as_object() {
            let prompt_tokens = u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let completion_tokens = u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            *sse_usage = Some((prompt_tokens, completion_tokens));
        }
        if let Some(reasoning) = data["choices"][0]["delta"]["reasoning_content"].as_str() {
            accumulated_thinking.push_str(reasoning);
        }
        if let Some(delta) = data["choices"][0]["delta"]["content"].as_str() {
            accumulated.push_str(delta);
            let _ = app.emit("ai-stream-chunk", StreamEvent {
                content: accumulated.clone(),
                thinking: accumulated_thinking.clone(),
                phase: "answering".into(),
                done: false,
                error: None,
                usage: None,
            });
        }
    }
}

/// SSE 流式调用（智谱等兼容 API）
async fn stream_sse(
    app: AppHandle,
    client: reqwest::Client,
    args: StreamChatArgs,
) -> Result<String, String> {
    let url = format!(
        "{}/chat/completions",
        args.endpoint.trim_end_matches('/')
    );

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");  // SSE 流式规范（智谱等需要此头）

    if let Some(ref key) = args.api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let mut body = serde_json::json!({
        "model": args.model,
        "messages": args.messages,
        "stream": true,
        "temperature": args.temperature,
    });

    if let Some(max_tokens) = args.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }

    // DeepSeek 思考模式：注入 thinking 参数
    if args.thinking_enabled.unwrap_or(false) {
        body["thinking"] = serde_json::json!({"type": "enabled"});
    }

    let response = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("AI 服务返回错误 ({}): {}", status, text));
    }

    let mut stream = response.bytes_stream();
    let mut accumulated = String::new();
    let mut accumulated_thinking = String::new();
    let mut buffer = String::new();
    let mut sse_usage: Option<(u32, u32)> = None; // (prompt_tokens, completion_tokens)
    let mut phase: &str = "thinking"; // 初始阶段为 thinking，收到第一个 content 后切换为 answering

    // SSE 流读取超时：若超过 60 秒无任何数据到达，
    // 判定为网络抖动导致连接中断（半开连接），尝试保留已生成内容
    const SSE_READ_TIMEOUT_SECS: u64 = 60;

    loop {
        let chunk = match timeout(
            std::time::Duration::from_secs(SSE_READ_TIMEOUT_SECS),
            stream.next()
        ).await {
            // 正常收到数据块
            Ok(Some(Ok(c))) => c,
            // 流读取错误（网络中断、连接重置等）
            Ok(Some(Err(e))) => {
                flush_sse_buffer(&mut accumulated, &mut accumulated_thinking, &mut buffer, &mut sse_usage, &app);
                let has_content = !accumulated.is_empty() || !accumulated_thinking.is_empty();
                if has_content {
                    eprintln!("流读取意外中断: {}", e);
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(),
                        thinking: accumulated_thinking.clone(),
                        phase: "done".into(),
                        done: true,
                        error: Some("AI 服务连接中断，已保留部分生成内容（可检查网络或切换更稳定的 API）".into()),
                        usage: None,
                    });
                    return Ok(accumulated);
                }
                return Err(format!("无法连接 AI 服务流式响应: {}. 请检查网络或 API 地址后重试", e));
            }
            // 流正常结束
            Ok(None) => break,
            // 读取超时：超过 60 秒无数据，判定网络抖动导致连接中断
            Err(_elapsed) => {
                flush_sse_buffer(&mut accumulated, &mut accumulated_thinking, &mut buffer, &mut sse_usage, &app);
                let has_content = !accumulated.is_empty() || !accumulated_thinking.is_empty();
                if has_content {
                    eprintln!("SSE 读取超时（{}s 无数据），已保留部分生成内容", SSE_READ_TIMEOUT_SECS);
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(),
                        thinking: accumulated_thinking.clone(),
                        phase: "done".into(),
                        done: true,
                        error: Some("AI 服务响应超时（网络抖动导致连接中断），已保留部分生成内容".into()),
                        usage: None,
                    });
                    return Ok(accumulated);
                }
                return Err(format!(
                    "AI 服务读取超时（{} 秒无数据响应），请检查网络连接是否稳定",
                    SSE_READ_TIMEOUT_SECS
                ));
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // 处理完整的 SSE 行
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            // SSE 格式: "data: {...}"
            if !line.starts_with("data:") {
                continue;
            }

            let json_str = line[5..].trim();
            if json_str == "[DONE]" {
                // 计算字数并发送带用量的结束事件
                let input_chars: usize = args.messages.iter().map(|m| m.content.chars().count()).sum();
                let output_chars = accumulated.chars().count();
                let (input_tokens, output_tokens) = sse_usage.unwrap_or((0, 0));
                let _ = app.emit("ai-stream-chunk", StreamEvent {
                    content: accumulated.clone(),
                    thinking: accumulated_thinking.clone(),
                    phase: "done".into(),
                    done: true,
                    error: None,
                    usage: Some(UsageInfo { input_tokens, output_tokens, input_chars, output_chars }),
                });
                return Ok(accumulated);
            }

            match serde_json::from_str::<serde_json::Value>(json_str) {
                Ok(data) => {
                    // 尝试提取 usage（部分服务商如 DeepSeek 在最后 chunk 携带）
                    if let Some(u) = data["usage"].as_object() {
                        let prompt_tokens = u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        let completion_tokens = u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        sse_usage = Some((prompt_tokens, completion_tokens));
                    }

                    // 检测 reasoning_content（智谱/DeepSeek 推理模型的思考过程）
                    if let Some(reasoning) = data["choices"][0]["delta"]["reasoning_content"].as_str() {
                        accumulated_thinking.push_str(reasoning);
                        let _ = app.emit("ai-stream-chunk", StreamEvent {
                            content: String::new(),
                            thinking: accumulated_thinking.clone(),
                            phase: "thinking".into(),
                            done: false,
                            error: None,
                            usage: None,
                        });
                    }

                    // 检测正式输出 content
                    if let Some(delta) = data["choices"][0]["delta"]["content"].as_str() {
                        accumulated.push_str(delta);
                        // 从 thinking 切换到 answering 阶段（仅第一次 content 时）
                        if phase == "thinking" {
                            phase = "answering";
                        }
                        let _ = app.emit("ai-stream-chunk", StreamEvent {
                            content: accumulated.clone(),
                            thinking: accumulated_thinking.clone(),
                            phase: phase.into(),
                            done: false,
                            error: None,
                            usage: None,
                        });
                    }
                }
                Err(e) => {
                    eprintln!("SSE JSON 解析失败: {} | 原始数据: {}", e, json_str);
                }
            }
        }
    }

    // 流正常结束（服务端关闭连接但未发送 [DONE]），刷出 buffer 残留
    flush_sse_buffer(&mut accumulated, &mut accumulated_thinking, &mut buffer, &mut sse_usage, &app);

    let input_chars: usize = args.messages.iter().map(|m| m.content.chars().count()).sum();
    let output_chars = accumulated.chars().count();
    let (input_tokens, output_tokens) = sse_usage.unwrap_or((0, 0));

    let _ = app.emit("ai-stream-chunk", StreamEvent {
        content: accumulated.clone(),
        thinking: accumulated_thinking.clone(),
        phase: "done".into(),
        done: true,
        error: None,
        usage: Some(UsageInfo { input_tokens, output_tokens, input_chars, output_chars }),
    });

    Ok(accumulated)
}

// ---- 章节内容总结 ----

/// 章节总结结果
#[derive(Debug, Clone, Serialize)]
pub struct ChapterSummary {
    /// 总结后的文本
    pub summary: String,
    /// 原始字数
    pub original_chars: usize,
    /// 总结后字数
    pub summary_chars: usize,
    /// 思考过程
    pub thinking: String,
}

/// 章节总结请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeArgs {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: f64,
    pub max_tokens: Option<u32>,
    pub chapter_title: String,
    pub chapter_content: String,
    pub thinking_enabled: Option<bool>,
    /// 用户自定义 system prompt，为空时使用默认提示
    pub system_prompt: Option<String>,
}

/// 总结章节内容（非流式，返回完整总结）
#[tauri::command]
pub async fn summarize_chapter(
    app: AppHandle,
    args: SummarizeArgs,
) -> Result<ChapterSummary, String> {
    let system_prompt = args.system_prompt.unwrap_or_else(|| {
        "你是一位专业的小说创作助手。请仔细阅读以下章节内容，然后进行简洁的总结。\n\n总结要求：\n1. 提炼出章节的主要情节、关键事件和重要人物\n2. 保留故事的核心脉络和转折点\n3. 字数控制在300字以内\n4. 使用流畅的段落形式，不要使用列表格式\n\n请直接输出总结内容，不需要任何前缀说明。".to_string()
    });

    let user_content = format!("章节标题：{}\n\n章节内容：\n{}", args.chapter_title, args.chapter_content);

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .tcp_keepalive(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let url = format!(
        "{}/chat/completions",
        args.endpoint.trim_end_matches('/')
    );

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json");

    if let Some(ref key) = args.api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let mut body = serde_json::json!({
        "model": args.model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ],
        "stream": false,
        "temperature": args.temperature,
    });

    if let Some(max_tokens) = args.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }

    if args.thinking_enabled.unwrap_or(false) {
        body["thinking"] = serde_json::json!({"type": "enabled"});
    }

    // 发送总结请求
    let response = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("总结请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("AI 服务返回错误 ({}): {}", status, text));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

    // 提取返回内容
    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // 提取思考过程（如果有）
    let thinking = data["choices"][0]["message"]["reasoning_content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let original_chars = args.chapter_content.chars().count();
    let summary_chars = content.chars().count();

    // 发送完成事件
    let _ = app.emit("chapter-summary-done", ());

    Ok(ChapterSummary {
        summary: content,
        original_chars,
        summary_chars,
        thinking,
    })
}
