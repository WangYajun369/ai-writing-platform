use tauri::{AppHandle, Emitter, State};
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;
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

/// AI 连接测试结果
#[derive(Debug, Serialize)]
pub struct ConnectionTestResult {
    /// 是否连接成功
    pub ok: bool,
    /// 成功时返回可用模型列表（Ollama），失败时返回错误信息
    pub detail: String,
}

/// 测试 AI 服务连接
///
/// - Ollama: GET /api/tags 获取已拉取模型列表
/// - OpenAI 兼容: GET /models，验证可达性和认证
#[tauri::command]
pub async fn test_ai_connection(
    provider: String,
    endpoint: String,
    api_key: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(10))
        .http1_only()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let endpoint = endpoint.trim_end_matches('/');

    match provider.as_str() {
        "ollama" => test_ollama_connection(client, endpoint).await,
        _ => test_openai_compatible_connection(client, endpoint, api_key).await,
    }
}

/// Ollama 连接测试：GET /api/tags
async fn test_ollama_connection(
    client: reqwest::Client,
    endpoint: &str,
) -> Result<ConnectionTestResult, String> {
    let url = format!("{}/api/tags", endpoint);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("无法连接到 Ollama 服务: {}\n请确保 Ollama 正在运行", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Ok(ConnectionTestResult {
            ok: false,
            detail: format!("Ollama 服务返回错误 ({}): {}", status, text),
        });
    }

    // 解析模型列表
    match response.json::<serde_json::Value>().await {
        Ok(data) => {
            let models: Vec<String> = data["models"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m["name"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            let detail = if models.is_empty() {
                "Ollama 已连接，暂无可用模型".to_string()
            } else {
                format!("Ollama 已连接，可用模型: {}", models.join(", "))
            };
            Ok(ConnectionTestResult { ok: true, detail })
        }
        Err(e) => Ok(ConnectionTestResult {
            ok: true,
            detail: format!("Ollama 已连接（解析模型列表失败: {}）", e),
        }),
    }
}

/// OpenAI 兼容连接测试：GET /models
async fn test_openai_compatible_connection(
    client: reqwest::Client,
    endpoint: &str,
    api_key: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let url = format!("{}/models", endpoint);

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
        // 尝试解析模型列表
        match response.json::<serde_json::Value>().await {
            Ok(data) => {
                let models: Vec<String> = data["data"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m["id"].as_str().map(String::from))
                            .take(10) // 限制显示前10个
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

/// 调用智谱/OpenAI 兼容的 Embedding API
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
        return Err(format!("Embedding API 返回错误 ({}): {}", status, err_text));
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
/// 当 embeddings 表有数据时使用向量搜索，否则降级为 SQL LIKE。
/// 智谱 bigmodel 使用 OpenAI 兼容的 /embeddings 端点。
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
        // 检查是否有已生成的 embedding
        let emb_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM embeddings e
                 INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
                 WHERE c.book_id = ?1 AND c.deleted_at IS NULL",
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

    // 降级：SQL LIKE 关键词搜索
    like_search(&conn, &book_id, &query, top_n)
}

/// 向量相似度搜索
fn vector_search(
    conn: &rusqlite::Connection,
    book_id: &str,
    query_vec: &[f32],
    top_n: usize,
) -> Result<Vec<RagResult>, String> {
    // 查询该书籍所有章节的 embedding
    let mut stmt = conn
        .prepare(
            "SELECT e.source_id, e.embedding, c.title, c.content_html
             FROM embeddings e
             INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
             WHERE c.book_id = ?1 AND c.deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;

    struct EmbRow {
        source_id: String,
        embedding: Vec<u8>,
        title: String,
        content_html: String,
    }

    let rows: Vec<EmbRow> = stmt
        .query_map(rusqlite::params![book_id], |row| {
            Ok(EmbRow {
                source_id: row.get(0)?,
                embedding: row.get(1)?,
                title: row.get(2)?,
                content_html: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // 计算余弦相似度并排序
    let mut scored: Vec<(f64, String, String, String)> = Vec::new();
    for row in &rows {
        let emb_vec = bytes_to_floats(&row.embedding);
        let sim = cosine_similarity(query_vec, &emb_vec);
        let plain = strip_html(&row.content_html);
        let snip = snippet(&plain, 200);
        scored.push((sim, snip, row.source_id.clone(), row.title.clone()));
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_n);

    Ok(scored
        .into_iter()
        .map(|(dist, snip, sid, title)| RagResult {
            snippet: snip,
            source_type: "chapter".into(),
            source_id: sid,
            source_title: title,
            distance: dist,
        })
        .collect())
}

/// 降级的 SQL LIKE 搜索
fn like_search(
    conn: &rusqlite::Connection,
    book_id: &str,
    query: &str,
    top_n: usize,
) -> Result<Vec<RagResult>, String> {
    let pattern = format!("%{}%", query.chars().take(20).collect::<String>());
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content_html FROM chapters
             WHERE book_id=?1 AND content_html LIKE ?2 AND deleted_at IS NULL LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map(rusqlite::params![book_id, pattern, top_n as i64], |row| {
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
        })
        .map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
             WHERE c.book_id = ?1 AND c.deleted_at IS NULL",
            rusqlite::params![&book_id],
            |row| row.get::<_, i64>(0).map(|v| v as usize),
        )
        .unwrap_or(0);

    let indexed_world_cards: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM embeddings e
             INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
             WHERE w.book_id = ?1",
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
/// 调用智谱/OpenAI 兼容的 /embeddings API，批量生成后写入 embeddings 表。
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
                    plain_text: strip_html(&html),
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
                    plain_text: strip_html(&html),
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
    /// "ollama" | "openai_compatible"
    pub provider: String,
    /// API 端点 URL（不含路径，如 http://localhost:11434）
    pub endpoint: String,
    /// 模型名
    pub model: String,
    /// 温度
    pub temperature: f64,
    /// max_tokens（仅 openai_compatible 使用）
    pub max_tokens: Option<u32>,
    /// API Key（仅 openai_compatible 使用）
    pub api_key: Option<String>,
    /// 消息列表（system + history + user）
    pub messages: Vec<ChatMessage>,
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

/// AI 流式对话命令
///
/// 通过 reqwest 发起流式 HTTP 请求，将增量文本通过 Tauri 事件
/// `ai-stream-chunk` 实时推送到前端。返回最终的完整文本。
#[tauri::command]
pub async fn stream_ai_chat(
    app: AppHandle,
    args: StreamChatArgs,
) -> Result<String, String> {
    // 流式对话不设 total/read timeout，允许 AI 长时间思考与生成
    // 仅保留 connect_timeout 防止无法连上服务
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .http1_only()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    match args.provider.as_str() {
        "ollama" => stream_ollama(app, client, args).await,
        _ => stream_openai_compatible(app, client, args).await,
    }
}

/// Ollama 协议流式调用（NDJSON 格式）
async fn stream_ollama(
    app: AppHandle,
    client: reqwest::Client,
    args: StreamChatArgs,
) -> Result<String, String> {
    let url = format!("{}/api/chat", args.endpoint.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "model": args.model,
        "messages": args.messages,
        "stream": true,
        "options": { "temperature": args.temperature },
    });

    // Ollama 默认 num_predict=128，必须显式设置才能支持长文输出
    // -1 表示不限制，正数表示最大生成 token 数
    if let Some(max_tokens) = args.max_tokens {
        body["options"]["num_predict"] = serde_json::json!(max_tokens);
    } else {
        body["options"]["num_predict"] = serde_json::json!(-1);
    }

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
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
    let mut buffer = String::new();
    let mut ollama_usage: Option<(u32, u32)> = None; // (prompt_eval_count, eval_count)

    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                if !accumulated.is_empty() {
                    eprintln!("流读取意外中断: {}", e);
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(),
                        thinking: String::new(),
                        phase: "done".into(),
                        done: true,
                        error: Some(format!("流读取意外中断（已接收部分内容）: {}", e)),
                        usage: None,
                    });
                    return Ok(accumulated);
                }
                return Err(format!("读取响应流失败: {}", e));
            }
            None => break,
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // NDJSON 按行处理，保留跨 chunk 的未完成行
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                // 检测 Ollama 流结束事件（done: true），提取 token 计数
                if data["done"].as_bool() == Some(true) {
                    let input_tokens = data["prompt_eval_count"].as_u64().unwrap_or(0) as u32;
                    let output_tokens = data["eval_count"].as_u64().unwrap_or(0) as u32;
                    ollama_usage = Some((input_tokens, output_tokens));
                    // done 事件中可能还有最后一点 content
                    if let Some(content) = data["message"]["content"].as_str() {
                        if !content.is_empty() {
                            accumulated.push_str(content);
                        }
                    }
                    continue; // 跳过本条，不发送增量事件
                }

                if let Some(content) = data["message"]["content"].as_str() {
                    accumulated.push_str(content);
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(),
                        thinking: String::new(),
                        phase: "answering".into(),
                        done: false,
                        error: None,
                        usage: None,
                    });
                }
            }
        }

        // 收到 done 事件后退出主循环
        if ollama_usage.is_some() {
            break;
        }
    }

    // 处理流结束后 buffer 中残留的未完成行（不以 \n 结尾的最后一行）
    // 仅当尚未收到 done 事件时处理
    if ollama_usage.is_none() {
        let remaining = buffer.trim().to_string();
        if !remaining.is_empty() {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&remaining) {
                if let Some(content) = data["message"]["content"].as_str() {
                    accumulated.push_str(content);
                }
            }
        }
    }

    // 计算字数
    let input_chars: usize = args.messages.iter().map(|m| m.content.chars().count()).sum();
    let output_chars = accumulated.chars().count();
    let (input_tokens, output_tokens) = ollama_usage.unwrap_or((0, 0));

    // 发送结束事件（带用量统计）
    let _ = app.emit("ai-stream-chunk", StreamEvent {
        content: accumulated.clone(),
        thinking: String::new(),
        phase: "done".into(),
        done: true,
        error: None,
        usage: Some(UsageInfo { input_tokens, output_tokens, input_chars, output_chars }),
    });

    Ok(accumulated)
}

/// OpenAI 兼容协议流式调用（SSE 格式）
async fn stream_openai_compatible(
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
        .header("Content-Type", "application/json");

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
    let mut openai_usage: Option<(u32, u32)> = None; // (prompt_tokens, completion_tokens)
    let mut phase: &str = "thinking"; // 初始阶段为 thinking，收到第一个 content 后切换为 answering

    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                let has_content = !accumulated.is_empty() || !accumulated_thinking.is_empty();
                if has_content {
                    eprintln!("流读取意外中断: {}", e);
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(),
                        thinking: accumulated_thinking.clone(),
                        phase: "done".into(),
                        done: true,
                        error: Some(format!("流读取意外中断（已接收部分内容）: {}", e)),
                        usage: None,
                    });
                    return Ok(accumulated);
                }
                return Err(format!("读取响应流失败: {}", e));
            }
            None => break,
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
                let (input_tokens, output_tokens) = openai_usage.unwrap_or((0, 0));
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
                        openai_usage = Some((prompt_tokens, completion_tokens));
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

    // 流正常结束（服务端关闭连接但未发送 [DONE]）
    let remaining = buffer.trim().to_string();
    if !remaining.is_empty() && remaining.starts_with("data:") {
        let json_str = remaining[5..].trim();
        if json_str != "[DONE]" {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(json_str) {
                // 检查残留行是否有 usage
                if let Some(u) = data["usage"].as_object() {
                    let prompt_tokens = u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let completion_tokens = u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    openai_usage = Some((prompt_tokens, completion_tokens));
                }
                // 残留行中也可能有 reasoning_content
                if let Some(reasoning) = data["choices"][0]["delta"]["reasoning_content"].as_str() {
                    accumulated_thinking.push_str(reasoning);
                }
                if let Some(delta) = data["choices"][0]["delta"]["content"].as_str() {
                    accumulated.push_str(delta);
                }
            }
        }
    }

    let input_chars: usize = args.messages.iter().map(|m| m.content.chars().count()).sum();
    let output_chars = accumulated.chars().count();
    let (input_tokens, output_tokens) = openai_usage.unwrap_or((0, 0));

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
