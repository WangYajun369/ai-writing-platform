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
