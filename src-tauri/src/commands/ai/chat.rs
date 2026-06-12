//! AI 流式对话（SSE 协议）
//!
//! 通过 reqwest 发起流式 HTTP 请求，将增量文本通过 Tauri 事件 `ai-stream-chunk`
//! 实时推送到前端。支持自动重试和网络中断部分内容保留。

use tauri::{AppHandle, Emitter};
use futures_util::StreamExt;
use tokio::time::timeout;
use serde::{Deserialize, Serialize};
use crate::error::AppError;
use crate::utils::get_sse_client;
use super::{ChatMessage, UsageInfo, StreamEvent};

/// 流式对话请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChatArgs {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: Option<u32>,
    pub api_key: Option<String>,
    pub messages: Vec<ChatMessage>,
    /// DeepSeek 思考模式开关（thinking: { type: "enabled"/"disabled" }）
    pub thinking_enabled: Option<bool>,
    /// DeepSeek 思考强度：high（默认）或 max（Agent/复杂任务推荐）
    /// 参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
    pub reasoning_effort: Option<String>,
}

/// AI 流式对话命令（SSE 流式协议，兼容智谱等 API）
#[tauri::command]
pub async fn stream_ai_chat(
    app: AppHandle,
    args: StreamChatArgs,
) -> Result<String, AppError> {
    let client = get_sse_client().clone();

    const MAX_RETRIES: u32 = 2;
    let mut last_error = String::new();

    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            let delay_ms = 1000 * 2u64.pow(attempt - 1);
            eprintln!(
                "AI 流式对话失败（{}），{}ms 后第 {} 次重试（共 {} 次）",
                last_error, delay_ms, attempt, MAX_RETRIES
            );
            let _ = app.emit(
                "ai-stream-chunk",
                StreamEvent {
                    content: String::new(),
                    thinking: String::new(),
                    phase: "retrying".into(),
                    done: false,
                    error: Some(format!(
                        "网络波动，正在自动重试 ({}/{})...",
                        attempt, MAX_RETRIES
                    )),
                    usage: None,
                },
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }

        match stream_sse(app.clone(), client.clone(), args.clone()).await {
            Ok(content) if !content.is_empty() => {
                return Ok(content);
            }
            Ok(_) => {
                last_error = "AI 返回空内容".to_string();
            }
            Err(e) => {
                last_error = e.to_string();
                if !is_retryable_error(&last_error) {
                    return Err(AppError::Business(last_error));
                }
            }
        }
    }

    Err(AppError::Business(last_error))
}

/// 判断流式请求错误是否可重试（网络抖动/临时性错误），排除认证、权限等永久性错误
fn is_retryable_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("timeout")
        || lower.contains("超时")
        || lower.contains("connection")
        || lower.contains("connect")
        || lower.contains("network")
        || lower.contains("eof")
        || lower.contains("reset")
        || lower.contains("broken pipe")
        || lower.contains("unexpected eof")
        || lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("temporary")
        || lower.contains("unavailable")
        || lower.contains("too many requests")
        || lower.contains("429")
        || lower.contains("空内容")
        || lower.contains("读取超时")
}

/// 刷新 SSE buffer 中的残留数据（流中断或正常结束时调用）
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
            let prompt_tokens = u
                .get("prompt_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let completion_tokens = u
                .get("completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            *sse_usage = Some((prompt_tokens, completion_tokens));
        }
        if let Some(reasoning) = data["choices"][0]["delta"]["reasoning_content"].as_str() {
            accumulated_thinking.push_str(reasoning);
        }
        if let Some(delta) = data["choices"][0]["delta"]["content"].as_str() {
            accumulated.push_str(delta);
            let _ = app.emit(
                "ai-stream-chunk",
                StreamEvent {
                    content: accumulated.clone(),
                    thinking: accumulated_thinking.clone(),
                    phase: "answering".into(),
                    done: false,
                    error: None,
                    usage: None,
                },
            );
        }
    }
}

/// SSE 流式调用（智谱等兼容 API，含总超时保护防止无限挂起）
async fn stream_sse(
    app: AppHandle,
    client: reqwest::Client,
    args: StreamChatArgs,
) -> Result<String, AppError> {
    /// 整个 SSE 数据流的全局超时（10 分钟），防止缓慢输出时无限挂起
    const SSE_TOTAL_TIMEOUT_SECS: u64 = 600;

    let result = timeout(
        std::time::Duration::from_secs(SSE_TOTAL_TIMEOUT_SECS),
        sse_loop_inner(app, client, args),
    )
    .await;

    match result {
        Ok(inner_result) => inner_result,
        Err(_) => Err(AppError::Business(format!(
            "AI 服务响应超时（超过 {} 秒未完成），请检查网络或 API 配置",
            SSE_TOTAL_TIMEOUT_SECS
        ))),
    }
}

async fn sse_loop_inner(
    app: AppHandle,
    client: reqwest::Client,
    args: StreamChatArgs,
) -> Result<String, AppError> {
    let url = format!(
        "{}/chat/completions",
        args.endpoint.trim_end_matches('/')
    );

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");

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

    if args.thinking_enabled.unwrap_or(false) {
        body["thinking"] = serde_json::json!({"type": "enabled"});
        // reasoning_effort: DeepSeek 思考强度，默认 high，Agent 场景推荐 max
        // 参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
        let effort = args.reasoning_effort.as_deref().unwrap_or("high");
        body["reasoning_effort"] = serde_json::json!(effort);
    }

    let response = req
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Business(format!("请求失败: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_else(|e| format!("(无法读取错误响应体: {e})"));
        return Err(AppError::Business(format!("AI 服务返回错误 ({}): {}", status, text)));
    }

    let mut stream = response.bytes_stream();
    let mut accumulated = String::new();
    let mut accumulated_thinking = String::new();
    let mut buffer = String::new();
    let mut sse_usage: Option<(u32, u32)> = None;
    let mut phase: &str = "thinking";

    const SSE_READ_TIMEOUT_SECS: u64 = 60;

    loop {
        let chunk = match timeout(
            std::time::Duration::from_secs(SSE_READ_TIMEOUT_SECS),
            stream.next(),
        )
        .await
        {
            Ok(Some(Ok(c))) => c,
            Ok(Some(Err(e))) => {
                flush_sse_buffer(
                    &mut accumulated,
                    &mut accumulated_thinking,
                    &mut buffer,
                    &mut sse_usage,
                    &app,
                );
                let has_content = !accumulated.is_empty() || !accumulated_thinking.is_empty();
                if has_content {
                    eprintln!("流读取意外中断: {}", e);
                    let _ = app.emit(
                        "ai-stream-chunk",
                        StreamEvent {
                            content: accumulated.clone(),
                            thinking: accumulated_thinking.clone(),
                            phase: "done".into(),
                            done: true,
                            error: Some(
                                "AI 服务连接中断，已保留部分生成内容（可检查网络或切换更稳定的 API）"
                                    .into(),
                            ),
                            usage: None,
                        },
                    );
                    return Ok(accumulated);
                }
                return Err(AppError::Business(format!(
                    "无法连接 AI 服务流式响应: {}. 请检查网络或 API 地址后重试",
                    e
                )));
            }
            Ok(None) => break,
            Err(_elapsed) => {
                flush_sse_buffer(
                    &mut accumulated,
                    &mut accumulated_thinking,
                    &mut buffer,
                    &mut sse_usage,
                    &app,
                );
                let has_content = !accumulated.is_empty() || !accumulated_thinking.is_empty();
                if has_content {
                    eprintln!(
                        "SSE 读取超时（{}s 无数据），已保留部分生成内容",
                        SSE_READ_TIMEOUT_SECS
                    );
                    let _ = app.emit(
                        "ai-stream-chunk",
                        StreamEvent {
                            content: accumulated.clone(),
                            thinking: accumulated_thinking.clone(),
                            phase: "done".into(),
                            done: true,
                            error: Some(
                                "AI 服务响应超时（网络抖动导致连接中断），已保留部分生成内容"
                                    .into(),
                            ),
                            usage: None,
                        },
                    );
                    return Ok(accumulated);
                }
                return Err(AppError::Business(format!(
                    "AI 服务读取超时（{} 秒无数据响应），请检查网络连接是否稳定",
                    SSE_READ_TIMEOUT_SECS
                )));
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if !line.starts_with("data:") {
                continue;
            }

            let json_str = line[5..].trim();
            if json_str == "[DONE]" {
                let input_chars: usize = args
                    .messages
                    .iter()
                    .map(|m| m.content.chars().count())
                    .sum();
                let output_chars = accumulated.chars().count();
                let (input_tokens, output_tokens) = sse_usage.unwrap_or((0, 0));
                let _ = app.emit(
                    "ai-stream-chunk",
                    StreamEvent {
                        content: accumulated.clone(),
                        thinking: accumulated_thinking.clone(),
                        phase: "done".into(),
                        done: true,
                        error: None,
                        usage: Some(UsageInfo {
                            input_tokens,
                            output_tokens,
                            input_chars,
                            output_chars,
                        }),
                    },
                );
                return Ok(accumulated);
            }

            match serde_json::from_str::<serde_json::Value>(json_str) {
                Ok(data) => {
                    if let Some(u) = data["usage"].as_object() {
                        let prompt_tokens = u
                            .get("prompt_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32;
                        let completion_tokens = u
                            .get("completion_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32;
                        sse_usage = Some((prompt_tokens, completion_tokens));
                        // KV Cache 命中统计（DeepSeek 自动启用，无需配置）
                        // 参考：https://api-docs.deepseek.com/zh-cn/guides/kv_cache
                        if let (Some(hit), Some(miss)) = (
                            u.get("prompt_cache_hit_tokens").and_then(|v| v.as_u64()),
                            u.get("prompt_cache_miss_tokens").and_then(|v| v.as_u64()),
                        ) {
                            if hit > 0 {
                                eprintln!(
                                    "[KV Cache] 命中: {} tokens, 未命中: {} tokens, 命中率: {:.1}%",
                                    hit,
                                    miss,
                                    hit as f64 / (hit + miss).max(1) as f64 * 100.0
                                );
                            }
                        }
                    }

                    if let Some(reasoning) =
                        data["choices"][0]["delta"]["reasoning_content"].as_str()
                    {
                        accumulated_thinking.push_str(reasoning);
                        let _ = app.emit(
                            "ai-stream-chunk",
                            StreamEvent {
                                content: String::new(),
                                thinking: accumulated_thinking.clone(),
                                phase: "thinking".into(),
                                done: false,
                                error: None,
                                usage: None,
                            },
                        );
                    }

                    if let Some(delta) = data["choices"][0]["delta"]["content"].as_str() {
                        accumulated.push_str(delta);
                        if phase == "thinking" {
                            phase = "answering";
                        }
                        let _ = app.emit(
                            "ai-stream-chunk",
                            StreamEvent {
                                content: accumulated.clone(),
                                thinking: accumulated_thinking.clone(),
                                phase: phase.into(),
                                done: false,
                                error: None,
                                usage: None,
                            },
                        );
                    }
                }
                Err(e) => {
                    eprintln!("SSE JSON 解析失败: {} | 原始数据: {}", e, json_str);
                }
            }
        }
    }

    // 流正常结束（服务端关闭连接但未发送 [DONE]），刷出 buffer 残留
    flush_sse_buffer(
        &mut accumulated,
        &mut accumulated_thinking,
        &mut buffer,
        &mut sse_usage,
        &app,
    );

    let input_chars: usize = args
        .messages
        .iter()
        .map(|m| m.content.chars().count())
        .sum();
    let output_chars = accumulated.chars().count();
    let (input_tokens, output_tokens) = sse_usage.unwrap_or((0, 0));

    let _ = app.emit(
        "ai-stream-chunk",
        StreamEvent {
            content: accumulated.clone(),
            thinking: accumulated_thinking.clone(),
            phase: "done".into(),
            done: true,
            error: None,
            usage: Some(UsageInfo {
                input_tokens,
                output_tokens,
                input_chars,
                output_chars,
            }),
        },
    );

    Ok(accumulated)
}
