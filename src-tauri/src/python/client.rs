//! Rust ↔ Python Agent 通信层
//!
//! Rust → Python: HTTP POST 调用 Agent Skills（SSE 流式响应）
//! Python → Rust: 数据桥接由 bridge.rs 的 HTTP Server 处理

use std::sync::Arc;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::python::manager::AgentManager;

/// Skill 执行请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRequest {
    pub skill: String,
    pub book_id: String,
    pub message: String,
    pub conversation_history: Option<Vec<ChatHistoryItem>>,
    /// AI 模型配置（API Key、Endpoint、Model 等）
    pub ai_config: Option<AiModelConfig>,
    /// 前端已生成的对话摘要（超过窗口的旧消息已压缩）
    pub conversation_summary: Option<String>,
}

/// AI 模型配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelConfig {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub thinking_enabled: Option<bool>,
    /// DeepSeek 思考强度：high（默认）或 max（Agent 推荐）
    pub reasoning_effort: Option<String>,
}

/// 对话历史项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryItem {
    pub role: String,
    pub content: String,
}

/// SSE 流事件（推送到前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub event: String,
    pub data: String,
    /// 请求 ID，前端用于过滤属于自己的事件
    pub request_id: String,
}

// ─── Rust → Python: 调用 Agent Skills ───

/// 执行 Agent Skill（SSE 流式），使用前端传入的 request_id
pub async fn execute_skill_with_id(
    app: AppHandle,
    manager: Arc<AgentManager>,
    req: SkillRequest,
    request_id: Option<String>,
) -> Result<String, AppError> {
    let client = reqwest::Client::new();
    let url = format!("{}/skills/execute", manager.base_url());

    // 使用前端传入的 request_id，若无则自动生成
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    eprintln!(
        "[Agent] 调用 Skill: skill={}, book={}, request_id={}, ai_config_provider={:?}, ai_config_model={:?}, ai_config_has_key={}",
        req.skill,
        req.book_id,
        request_id,
        req.ai_config.as_ref().map(|c| &c.provider),
        req.ai_config.as_ref().map(|c| &c.model),
        req.ai_config.as_ref().map_or(false, |c| c.api_key.as_ref().map_or(false, |k| !k.is_empty())),
    );

    // 调试：打印完整请求体（脱敏 api_key）
    if let Ok(body) = serde_json::to_string(&req) {
        eprintln!("[Agent] 请求体长度: {} bytes", body.len());
    }

    let response = client
        .post(&url)
        .json(&req)
        .header("Accept", "text/event-stream")
        .timeout(std::time::Duration::from_secs(600)) // 10 分钟总超时
        .send()
        .await
        .map_err(|e| AppError::Business(format!("Agent 请求失败: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::Business(format!(
            "Agent 服务返回错误 ({}): {}",
            status, text
        )));
    }

    // 读取 SSE 流
    let mut stream = response.bytes_stream();
    let mut accumulated = String::new();
    let mut current_event = String::new();
    let mut current_data = String::new();

    // 辅助：构造带 request_id 的事件
    let make_event = |event: &str, data: &str| AgentStreamEvent {
        event: event.to_string(),
        data: data.to_string(),
        request_id: request_id.clone(),
    };

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Business(format!("流读取错误: {}", e)))?;
        let text = String::from_utf8_lossy(&chunk);

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                // 空行表示一个 SSE 事件结束，触发事件
                if !current_data.is_empty() || !current_event.is_empty() {
                    let event_type = if current_event.is_empty() {
                        "chunk".to_string()
                    } else {
                        current_event.clone()
                    };

                    match event_type.as_str() {
                        "chunk" => {
                            accumulated.push_str(&current_data);
                            let _ = app.emit(
                                "agent-stream-chunk",
                                make_event("chunk", &current_data),
                            );
                        }
                        "done" => {
                            let _ = app.emit(
                                "agent-stream-chunk",
                                make_event("done", ""),
                            );
                        }
                        "error" => {
                            let _ = app.emit(
                                "agent-stream-chunk",
                                make_event("error", &current_data),
                            );
                            return Err(AppError::Business(current_data.clone()));
                        }
                        "cancelled" => {
                            let _ = app.emit(
                                "agent-stream-chunk",
                                make_event("cancelled", &current_data),
                            );
                        }
                        _ => {
                            eprintln!("[Agent] 未知 SSE 事件: {}", event_type);
                        }
                    }

                    current_event.clear();
                    current_data.clear();
                }
                continue;
            }

            if let Some(value) = line.strip_prefix("event:") {
                current_event = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                let value = value.trim();
                if !current_data.is_empty() {
                    current_data.push('\n');
                }
                current_data.push_str(value);
            }
        }
    }

    Ok(accumulated)
}

/// 取消当前 Agent 任务
pub async fn cancel_skill(manager: Arc<AgentManager>) -> Result<(), AppError> {
    let client = reqwest::Client::new();
    let url = format!("{}/skills/cancel", manager.base_url());

    client
        .post(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| AppError::Business(format!("取消任务失败: {}", e)))?;

    Ok(())
}
