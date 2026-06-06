use tauri::{AppHandle, Emitter, State};
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;
use crate::db::AppDb;

#[derive(Serialize)]
pub struct RagResult {
    pub snippet: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    pub distance: f64,
}

/// RAG 语义检索（Phase 4 占位实现，待接入 sqlite-vec）
#[tauri::command]
pub async fn rag_search(
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
    top_n: usize,
) -> Result<Vec<RagResult>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let pattern = format!("%{}%", query.chars().take(20).collect::<String>());
    let mut stmt = conn.prepare(
        "SELECT id, title, content_html FROM chapters WHERE book_id=?1 AND content_html LIKE ?2 AND deleted_at IS NULL LIMIT ?3"
    ).map_err(|e| e.to_string())?;

    let results = stmt.query_map(rusqlite::params![book_id, pattern, top_n as i64], |row| {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let html: String = row.get(2)?;
        let snippet: String = html.chars().filter(|&c| c != '<' && c != '>').take(200).collect();
        Ok(RagResult { snippet, source_id: id, source_title: title, distance: 0.5 })
    }).map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 触发 Embedding 生成（Phase 4 占位）
#[tauri::command]
pub async fn trigger_embedding(_db: State<'_, AppDb>, book_id: String) -> Result<(), String> {
    println!("触发 Embedding 生成：book_id={}", book_id);
    Ok(())
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

/// 向前端推送的流式事件负载
#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    /// 当前累积的完整响应文本
    pub content: String,
    /// 是否完成
    pub done: bool,
    /// 错误信息（仅出错时非空）
    pub error: Option<String>,
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
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

    let body = serde_json::json!({
        "model": args.model,
        "messages": args.messages,
        "stream": true,
        "options": { "temperature": args.temperature },
    });

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

    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                if !accumulated.is_empty() {
                    eprintln!("流读取结束（非关键错误）: {}", e);
                    break;
                }
                return Err(format!("读取响应流失败: {}", e));
            }
            None => break,
        };

        let text = String::from_utf8_lossy(&chunk);

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(content) = data["message"]["content"].as_str() {
                    accumulated.push_str(content);
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(),
                        done: false,
                        error: None,
                    });
                }
            }
        }
    }

    // 发送结束事件
    let _ = app.emit("ai-stream-chunk", StreamEvent {
        content: accumulated.clone(),
        done: true,
        error: None,
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
    let mut buffer = String::new();

    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                // 流末尾 gzip 解码错误（服务端关闭连接时 gzip 流可能未正确收尾）
                // 此时 AI 完整回复已收到，视为正常结束
                if !accumulated.is_empty() {
                    eprintln!("流读取结束（非关键错误）: {}", e);
                    break;
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
                let _ = app.emit("ai-stream-chunk", StreamEvent {
                    content: accumulated.clone(),
                    done: true,
                    error: None,
                });
                return Ok(accumulated);
            }

            match serde_json::from_str::<serde_json::Value>(json_str) {
                Ok(data) => {
                    if let Some(delta) = data["choices"][0]["delta"]["content"].as_str() {
                        accumulated.push_str(delta);
                        let _ = app.emit("ai-stream-chunk", StreamEvent {
                            content: accumulated.clone(),
                            done: false,
                            error: None,
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
    let _ = app.emit("ai-stream-chunk", StreamEvent {
        content: accumulated.clone(),
        done: true,
        error: None,
    });

    Ok(accumulated)
}
