//! AI 内容总结
//!
//! 包含：对话上下文总结（滑动窗口管理）、章节内容总结。

use tauri::{AppHandle, Emitter};
use crate::error::AppError;
use crate::utils::get_sse_client;
use super::{SummarizeConversationArgs, ConversationSummary, SummarizeArgs, ChapterSummary};

/// 总结历史对话内容（用于滑动窗口 context 管理）
#[tauri::command]
pub async fn summarize_conversation(
    app: AppHandle,
    args: SummarizeConversationArgs,
) -> Result<ConversationSummary, AppError> {
    let previous_hint = if let Some(ref prev) = args.previous_summary {
        format!(
            "\n\n对话此前已有部分历史摘要，请将新内容与历史摘要整合：\n\n【历史摘要】\n{}",
            prev
        )
    } else {
        String::new()
    };

    let system_prompt = format!(
        "你是一个对话摘要助手。请将以下用户与 AI 助手的多轮对话压缩为精炼摘要。\n\n\
         总结要求：\n\
         1. 保留用户的核心需求、关键问题和重要决策\n\
         2. 记录 AI 给出的重要建议、情节方向、人物设定等创作相关内容\n\
         3. 忽略闲聊内容和客套话\n\
         4. 使用简洁的段落形式，300字以内\n\
         5. 新对话的内容在前，旧内容在后（时间倒序）\n\
         请直接输出总结内容，不需要任何前缀说明。{}",
        previous_hint
    );

    let conversation_text: String = args
        .messages
        .iter()
        .filter(|m| !m.content.trim().is_empty())
        .map(|m| format!("[{}]: {}", m.role, m.content))
        .collect::<Vec<_>>()
        .join("\n\n");

    let client = get_sse_client().clone();

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
            { "role": "user", "content": conversation_text }
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

    let response = req
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Business(format!("对话总结请求失败: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_else(|e| format!("(无法读取错误响应体: {e})"));
        return Err(AppError::Business(format!("AI 服务返回错误 ({}): {}", status, text)));
    }

    let data: serde_json::Value = response.json().await
        .map_err(|e| AppError::Business(format!("解析 AI 响应失败: {}", e)))?;

    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let thinking = data["choices"][0]["message"]["reasoning_content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let covered_count = args
        .messages
        .iter()
        .filter(|m| !m.content.trim().is_empty())
        .count();
    let summary_chars = content.chars().count();

    let _ = app.emit("conversation-summary-done", ());

    Ok(ConversationSummary {
        summary: content,
        covered_count,
        summary_chars,
        thinking,
    })
}

/// 总结章节内容（非流式，返回完整总结）
#[tauri::command]
pub async fn summarize_chapter(
    app: AppHandle,
    args: SummarizeArgs,
) -> Result<ChapterSummary, AppError> {
    let system_prompt = args.system_prompt.unwrap_or_else(|| {
        "你是一位专业的小说创作助手。请仔细阅读以下章节内容，然后进行简洁的总结。\n\n总结要求：\n1. 提炼出章节的主要情节、关键事件和重要人物\n2. 保留故事的核心脉络和转折点\n3. 字数控制在300字以内\n4. 使用流畅的段落形式，不要使用列表格式\n\n请直接输出总结内容，不需要任何前缀说明。".to_string()
    });

    let user_content = format!(
        "章节标题：{}\n\n章节内容：\n{}",
        args.chapter_title, args.chapter_content
    );

    let client = get_sse_client().clone();

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

    let response = req
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Business(format!("总结请求失败: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_else(|e| format!("(无法读取错误响应体: {e})"));
        return Err(AppError::Business(format!("AI 服务返回错误 ({}): {}", status, text)));
    }

    let data: serde_json::Value = response.json().await
        .map_err(|e| AppError::Business(format!("解析 AI 响应失败: {}", e)))?;

    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let thinking = data["choices"][0]["message"]["reasoning_content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let original_chars = args.chapter_content.chars().count();
    let summary_chars = content.chars().count();

    let _ = app.emit("chapter-summary-done", ());

    Ok(ChapterSummary {
        summary: content,
        original_chars,
        summary_chars,
        thinking,
    })
}
