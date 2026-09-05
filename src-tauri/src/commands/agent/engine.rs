//! Agent Skill 执行引擎（ReAct 循环 · SSE 流式）
//!
//! 自 Python agent/skills/engine.py + server/sse.py + python/client.rs 迁移。
//! 原实现由 Rust 转发 HTTP(9877) → Python(LangGraph) 执行，现改为 Rust 内
//! 直接与模型 API 对话：OpenAI function calling 协议 + 数据库工具循环。
//!
//! 事件契约与旧 Python 完全一致（事件名 `agent-stream-chunk`，事件体
//! `{ event, data, requestId }`，event ∈ chunk / done / error / cancelled）。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use futures_util::StreamExt;
use r2d2::Pool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::timeout;

use crate::commands::agent::{memory, prompts, tools};
use crate::db::SqliteConnectionManager;
use crate::error::AppError;
use crate::utils::get_sse_client;

/// SSE 流事件（推送到前端，契约与 python::client::AgentStreamEvent 一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub event: String,
    pub data: String,
    /// 请求 ID，前端用于过滤属于自己的事件
    pub request_id: String,
}

/// AI 模型配置（与前端 aiConfig / 原 AiModelConfig 字段一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelConfig {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub thinking_enabled: Option<bool>,
    pub reasoning_effort: Option<String>,
}

/// 对话历史项（role ∈ user / assistant）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMsg {
    pub role: String,
    pub content: String,
}

/// Agent 最大工具推理轮数（对齐 Python config.max_iterations）
const MAX_ITERATIONS: usize = 15;
/// 单轮 SSE 无数据读取超时（秒）
const SSE_READ_TIMEOUT_SECS: u64 = 60;
/// 整个 Agent 执行总超时（秒）
const SSE_TOTAL_TIMEOUT_SECS: u64 = 600;
/// 历史消息最多保留条数（对齐 Python 的最近 10 条）
const MAX_HISTORY_ITEMS: usize = 10;
/// 单条历史消息最大字符数
const MAX_HISTORY_CHARS: usize = 2000;
/// 单条工具结果最大长度（防御异常数据）
const MAX_TOOL_RESULT_CHARS: usize = 30_000;

// ─── 取消管理 ───
// 全局只保留一个"当前任务"的取消令牌（前端同一时刻仅执行一个 Agent 任务，
// 与 Python 端 /skills/cancel 的全局语义一致）。
// CancelToken = 原子标志 + tokio::Notify：
// cancel() 置位标志并 notify_waiters()，引擎在任意阻塞点（SSE 流读取 /
// HTTP 发送等待响应头）通过 tokio::select! 与其竞争，实现即时中断——
// 不必等待 60s 行超时或下一个 chunk 到达。

struct CancelToken {
    flag: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// 取消通知 future（供 tokio::select! 与业务 await 竞争）
    fn notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.notify.notified()
    }
}

static CURRENT_CANCEL: StdMutex<Option<Arc<CancelToken>>> = StdMutex::new(None);

fn register_cancel_token() -> Arc<CancelToken> {
    let token = Arc::new(CancelToken::new());
    if let Ok(mut guard) = CURRENT_CANCEL.lock() {
        *guard = Some(token.clone());
    }
    token
}

fn unregister_cancel_token(token: &Arc<CancelToken>) {
    if let Ok(mut guard) = CURRENT_CANCEL.lock() {
        if let Some(cur) = guard.as_ref() {
            if Arc::ptr_eq(cur, token) {
                *guard = None;
            }
        }
    }
}

/// 取消当前正在执行的 Agent 任务（IPC cancel_agent_skill 调用）：
/// 置位取消标志并唤醒引擎阻塞中的等待，使任务在下个 await 点立即以
/// cancelled 事件收尾，正在进行的 SSE 流随即被丢弃、连接关闭。
pub fn cancel_current_task() {
    if let Ok(guard) = CURRENT_CANCEL.lock() {
        if let Some(token) = guard.as_ref() {
            token.cancel();
        }
    }
}

// ─── 工具调用累积（SSE delta 增量拼接） ───

struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

type PendingToolCalls = BTreeMap<usize, PendingToolCall>;

// ─── 主入口 ───

/// 流式执行 Agent Skill（模型 API 直连），返回最终完整文本。
#[allow(clippy::too_many_arguments)]
pub async fn run_skill(
    app: AppHandle,
    pool: Pool<SqliteConnectionManager>,
    skill: String,
    book_id: String,
    message: String,
    conversation_history: Option<Vec<HistoryMsg>>,
    ai_config: Option<AiModelConfig>,
    request_id: String,
    conversation_summary: Option<String>,
) -> Result<String, AppError> {
    let cancel_token = register_cancel_token();

    let result = run_skill_inner(
        app.clone(),
        pool.clone(),
        &skill,
        &book_id,
        &message,
        conversation_history.as_deref(),
        ai_config.as_ref(),
        &request_id,
        conversation_summary.as_deref(),
        &cancel_token,
    )
    .await;

    unregister_cancel_token(&cancel_token);

    // cancelled：不保存记忆，返回已累积文本（若提示词中文本为空则返回空串）
    if cancel_token.is_cancelled() {
        return result;
    }

    // 成功路径下异步保存记忆（阻塞调用很快，失败不阻断响应）
    if let Ok(text) = &result {
        if !text.is_empty() {
            let conn = match pool.get() {
                Ok(c) => c,
                Err(e) => {
                    crate::app_log_error!("[Agent] 获取连接保存记忆失败: {}", e);
                    return result;
                }
            };
            if let Err(e) = memory::extract_and_save(&conn, &book_id, &skill, &message, text) {
                crate::app_log_error!("[Agent] 记忆保存失败（不阻断）: {}", e);
            }
        }
    }

    result
}

#[allow(clippy::too_many_arguments)]
async fn run_skill_inner(
    app: AppHandle,
    pool: Pool<SqliteConnectionManager>,
    skill: &str,
    book_id: &str,
    message: &str,
    conversation_history: Option<&[HistoryMsg]>,
    ai_config: Option<&AiModelConfig>,
    request_id: &str,
    conversation_summary: Option<&str>,
    cancel_token: &Arc<CancelToken>,
) -> Result<String, AppError> {
    // ========== 1. 组装 System Prompt ==========
    let dynamic_prompt = prompts::get_dynamic_prompt(skill, message);

    let memory_section = {
        let conn = pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
        memory::memory_prompt(&conn, book_id, skill, message)
    };

    let summary_section = conversation_summary
        .map(|s| format!("\n## 历史对话摘要\n{s}\n"))
        .unwrap_or_default();

    let now = chrono::Local::now().format("%Y年%m月%d日 %H:%M");
    let system_prompt = format!(
        "{dynamic_prompt}\n{memory_section}{summary_section}当前书籍 ID: {book_id}\n当前时间: {now}\n\n重要提示：\n- 使用工具读取数据时，务必传入正确的 book_id\n- 优先使用 read_chapter_summary 了解概况，只在需要细节时才用完整读取\n- 大章节（超过 2000 字）请使用 read_chapter_chunk 分段读取\n- 生成内容保持与原著风格一致\n"
    );

    // ========== 2. 组装消息列表 ==========
    let mut messages: Vec<Value> = Vec::new();
    messages.push(serde_json::json!({ "role": "system", "content": system_prompt }));

    if let Some(history) = conversation_history {
        // 只取最近 10 条；单条超长截断
        let start = history.len().saturating_sub(MAX_HISTORY_ITEMS);
        for item in &history[start..] {
            if item.role != "user" && item.role != "assistant" {
                continue;
            }
            let mut content = item.content.clone();
            if content.chars().count() > MAX_HISTORY_CHARS {
                content = content.chars().take(MAX_HISTORY_CHARS).collect();
                content.push_str("\n... [内容过长，已截断]");
            }
            messages.push(serde_json::json!({ "role": item.role, "content": content }));
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": message }));

    // ========== 3. 模型端点与参数 ==========
    let cfg = ai_config;
    let endpoint = cfg
        .map(|c| c.endpoint.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.deepseek.com".to_string());
    let model = cfg
        .map(|c| c.model.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "deepseek-chat".to_string());
    let api_key = cfg.and_then(|c| c.api_key.clone()).map(|k| k.trim().to_string());
    if api_key.as_deref().map_or(true, |k| k.is_empty()) {
        let hint = if endpoint.to_lowercase().contains("deepseek") {
            "（当前使用 DeepSeek，可在 https://platform.deepseek.com 获取）"
        } else if endpoint.to_lowercase().contains("bigmodel") {
            "（当前使用智谱 AI，可在 https://open.bigmodel.cn 获取）"
        } else {
            ""
        };
        return Err(AppError::Business(format!(
            "未配置云端 API Key{hint}。请在设置页面中配置 AI 模型的 API Key"
        )));
    }
    let temperature = cfg.and_then(|c| c.temperature).unwrap_or(0.7);
    let max_tokens = cfg.and_then(|c| c.max_tokens).unwrap_or(8192);

    let tools_schema = tools::build_tools_schema(skill);

    let url = format!("{endpoint}/chat/completions");

    // ========== 4. SSE ReAct 循环 ==========
    let mut full_response = String::new();
    let mut tool_rounds = 0usize;

    let total_guard = timeout(
        std::time::Duration::from_secs(SSE_TOTAL_TIMEOUT_SECS),
        react_loop(
            app.clone(),
            pool.clone(),
            url,
            api_key.as_deref().unwrap_or(""),
            model,
            temperature,
            max_tokens,
            tools_schema,
            &mut messages,
            &mut full_response,
            &mut tool_rounds,
            request_id,
            cancel_token,
        ),
    )
    .await;

    match total_guard {
        Ok(Ok(())) => {
            // 取消路径已由 react_loop 发出 cancelled 事件，这里不再补发 done
            if !cancel_token.is_cancelled() {
                let _ = emit_event(&app, "done", "", request_id);
            }
            Ok(full_response)
        }
        Ok(Err(e)) => {
            let _ = emit_event(&app, "error", &e.to_string(), request_id);
            Err(e)
        }
        Err(_) => {
            let msg = format!(
                "Agent 执行超时（超过 {} 秒），请检查网络或 API 配置后重试",
                SSE_TOTAL_TIMEOUT_SECS
            );
            let _ = emit_event(&app, "error", &msg, request_id);
            Err(AppError::Business(msg))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn react_loop(
    app: AppHandle,
    pool: Pool<SqliteConnectionManager>,
    url: String,
    api_key: &str,
    model: String,
    temperature: f64,
    max_tokens: u32,
    tools_schema: Vec<Value>,
    messages: &mut Vec<Value>,
    full_response: &mut String,
    tool_rounds: &mut usize,
    request_id: &str,
    cancel_token: &Arc<CancelToken>,
) -> Result<(), AppError> {
    loop {
        if cancel_token.is_cancelled() {
            let _ = emit_event(&app, "cancelled", "任务已被用户取消", request_id);
            return Ok(());
        }
        if *tool_rounds >= MAX_ITERATIONS {
            crate::app_log!(
                "[Agent] 达到最大推理轮数 ({}), 结束工具循环",
                MAX_ITERATIONS
            );
            break;
        }
        *tool_rounds += 1;

        // DeepSeek thinking 参数：Python SDK 无法透传，Rust 直连亦不传，保持行为一致
        //（如需思考模式可在此按 ai_config.thinking_enabled 显式开启）
        let body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "tools": tools_schema,
            "tool_choice": "auto",
        });

        let client = get_sse_client().clone();
        let req = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("Authorization", format!("Bearer {api_key}"));

        // 发送阶段也与取消信号竞争：客户端仅配 connect_timeout（30s），
        // 若服务端迟迟不返回响应头，取消可在此即时退出而不被长时间挂起
        let send_fut = req.json(&body).send();
        tokio::pin!(send_fut);
        let send_notified = cancel_token.notified();
        tokio::pin!(send_notified);
        let send_result = tokio::select! {
            biased;
            _ = &mut send_notified => {
                if cancel_token.is_cancelled() {
                    let _ = emit_event(&app, "cancelled", "任务已被用户取消", request_id);
                    return Ok(());
                }
                // 非取消通知（理论上不发生）：继续完成原请求
                send_fut.await
            }
            resp = &mut send_fut => resp,
        };

        let response = send_result.map_err(|e| {
            let err_str = e.to_string();
            let hint = if err_str.contains("dns") || err_str.contains("resolve") {
                "\n诊断：DNS 解析失败，请检查网络连接或尝试配置代理"
            } else if err_str.contains("refused") {
                "\n诊断：连接被拒绝，请确认 API 地址正确且服务可用"
            } else if err_str.contains("timeout") || err_str.contains("timed out") {
                "\n诊断：连接超时，请检查网络稳定性或尝试使用代理"
            } else if err_str.contains("tls")
                || err_str.contains("certificate")
                || err_str.contains("ssl")
            {
                "\n诊断：TLS/证书验证失败，请检查系统时间是否正确，或尝试设置 HTTPS_PROXY 环境变量"
            } else if err_str.contains("502") || err_str.contains("503") || err_str.contains("504")
            {
                "\n诊断：AI 服务暂时不可用，请稍后重试"
            } else {
                "\n诊断：无法连接到 AI 服务（可能是代理/防火墙阻止），请在系统中设置 HTTPS_PROXY 环境变量后重启应用"
            };
            AppError::Business(format!("请求失败: {err_str}{hint}"))
        })?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("(无法读取错误响应体: {e})"));
            return Err(AppError::Business(format!(
                "AI 服务返回错误 ({status}): {text}"
            )));
        }

        // 解析一轮 SSE 流：收集正文增量 + 工具调用
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut round_content = String::new();
        let mut tool_calls: PendingToolCalls = BTreeMap::new();
        let mut stream_finished = false;

        'outer: loop {
            // 等待下一个 SSE chunk 与取消信号竞争：用户取消可即时打断阻塞的
            // 流读取（含 60s 行超时窗口与流已结束的静默期），无需等待超时或
            // 下一个 chunk 到达；被放弃的 stream.next() future 随即 drop，
            // 底层 reqwest 连接中止，服务端感知后停止继续生成。
            let notified = cancel_token.notified();
            tokio::pin!(notified);
            let next_chunk = timeout(
                std::time::Duration::from_secs(SSE_READ_TIMEOUT_SECS),
                stream.next(),
            );
            let chunk = tokio::select! {
                biased;
                _ = &mut notified => {
                    if cancel_token.is_cancelled() {
                        let _ = emit_event(&app, "cancelled", "任务已被用户取消", request_id);
                        return Ok(());
                    }
                    continue; // 非取消通知：回到等待
                }
                chunk = next_chunk => chunk,
            };

            let chunk = match chunk {
                Ok(Some(Ok(c))) => c,
                Ok(Some(Err(e))) => {
                    // 流中断：若已输出内容，则当作"无工具结果"正常收尾
                    crate::app_log_error!("[Agent] SSE 流读取错误: {}", e);
                    break 'outer;
                }
                Ok(None) => {
                    // 正常 EOF（服务端未发送 [DONE]）
                    flush_remaining_line(
                        &mut buffer,
                        &mut round_content,
                        &mut tool_calls,
                        &app,
                        full_response,
                        request_id,
                        &mut stream_finished,
                    );
                    break 'outer;
                }
                Err(_elapsed) => {
                    // 60s 无数据：按有内容收尾处理
                    crate::app_log_error!(
                        "[Agent] SSE 读取超时 ({}s 无数据)",
                        SSE_READ_TIMEOUT_SECS
                    );
                    flush_remaining_line(
                        &mut buffer,
                        &mut round_content,
                        &mut tool_calls,
                        &app,
                        full_response,
                        request_id,
                        &mut stream_finished,
                    );
                    break 'outer;
                }
            };

            if cancel_token.is_cancelled() {
                let _ = emit_event(&app, "cancelled", "任务已被用户取消", request_id);
                return Ok(());
            }

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
                let json_str = line[5..].trim().to_string();
                if json_str == "[DONE]" {
                    stream_finished = true;
                    break 'outer;
                }
                parse_sse_data(
                    &json_str,
                    &mut round_content,
                    &mut tool_calls,
                    &app,
                    full_response,
                    request_id,
                );
            }
        }

        // 处理后事（EOF/中断时缓冲残留行）
        if !stream_finished && !buffer.is_empty() {
            flush_remaining_line(
                &mut buffer,
                &mut round_content,
                &mut tool_calls,
                &app,
                full_response,
                request_id,
                &mut stream_finished,
            );
        }

        // ========== 工具调用判断 ==========
        let collected: Vec<(usize, PendingToolCall)> = tool_calls.into_iter().collect();
        if collected.is_empty() {
            // 无工具调用 → 本回合即最终答案
            break;
        }

        // 构造 assistant 消息（含 tool_calls），追加到历史
        let tc_json: Vec<Value> = collected
            .iter()
            .map(|(_, tc)| {
                let args = if tc.arguments.trim().is_empty() {
                    "{}".to_string()
                } else {
                    tc.arguments.clone()
                };
                serde_json::json!({
                    "id": tc.id,
                    "type": "function",
                    "function": { "name": tc.name, "arguments": args },
                })
            })
            .collect();

        messages.push(serde_json::json!({
            "role": "assistant",
            "content": round_content,
            "tool_calls": tc_json,
        }));

        // 逐个执行工具并回填 Tool 消息（连接在本回合内使用后即归还）
        let conn = pool
            .get()
            .map_err(|e| AppError::DbPool(e.to_string()))?;
        for (_, tc) in &collected {
            if cancel_token.is_cancelled() {
                let _ = emit_event(&app, "cancelled", "任务已被用户取消", request_id);
                return Ok(());
            }
            let args_value: Value =
                serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
            let result = match tools::execute_tool(&conn, &tc.name, &args_value) {
                Ok(text) => text,
                Err(e) => {
                    crate::app_log_error!("[Agent] 工具 {} 执行失败: {}", tc.name, e);
                    format!("工具执行错误：{}", e)
                }
            };
            let result = clamp_text(&result, MAX_TOOL_RESULT_CHARS);
            messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            }));
        }
        // 连接使用完毕即释放（drop），避免跨 await 持锁
    }

    Ok(())
}

fn clamp_text(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        let mut out: String = s.chars().take(max).collect();
        out.push_str("\n...[结果过长，已截断]");
        out
    } else {
        s.to_string()
    }
}

// ─── SSE 行解析 ───

#[allow(clippy::too_many_arguments)]
fn parse_sse_data(
    json_str: &str,
    round_content: &mut String,
    tool_calls: &mut PendingToolCalls,
    app: &AppHandle,
    full_response: &mut String,
    request_id: &str,
) {
    let data: Value = match serde_json::from_str(json_str) {
        Ok(d) => d,
        Err(e) => {
            crate::app_log_error!("[Agent] SSE JSON 解析失败: {} | {}", e, json_str);
            return;
        }
    };

    let choice = &data["choices"][0];

    // DeepSeek 思考内容（reasoning_content）不转发（与 Python 行为一致）
    // 仅透出正文 content

    if let Some(delta) = choice["delta"]["content"].as_str() {
        if !delta.is_empty() {
            round_content.push_str(delta);
            full_response.push_str(delta);
            let _ = emit_chunk(app, delta, request_id);
        }
    }

    if let Some(tc_arr) = choice["delta"]["tool_calls"].as_array() {
        for tc in tc_arr {
            let idx = tc["index"].as_u64().unwrap_or(0) as usize;
            let slot = tool_calls.entry(idx).or_insert_with(|| PendingToolCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
            if let Some(id) = tc["id"].as_str() {
                if slot.id.is_empty() && !id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            if let Some(name) = tc["function"]["name"].as_str() {
                if slot.name.is_empty() && !name.is_empty() {
                    slot.name = name.to_string();
                }
            }
            if let Some(args) = tc["function"]["arguments"].as_str() {
                slot.arguments.push_str(args);
            }
        }
    }
}

/// 流结束（EOF / 中断 / 超时）后处理缓冲区内残留的最后一行
#[allow(clippy::too_many_arguments)]
fn flush_remaining_line(
    buffer: &mut String,
    round_content: &mut String,
    tool_calls: &mut PendingToolCalls,
    app: &AppHandle,
    full_response: &mut String,
    request_id: &str,
    stream_finished: &mut bool,
) {
    let remaining = buffer.trim().to_string();
    buffer.clear();
    if remaining.is_empty() {
        return;
    }
    if !remaining.starts_with("data:") {
        return;
    }
    let json_str = remaining[5..].trim().to_string();
    if json_str == "[DONE]" {
        *stream_finished = true;
        return;
    }
    parse_sse_data(
        &json_str, round_content, tool_calls, app, full_response, request_id,
    );
}

// ─── 事件推送 ───

fn emit_chunk(app: &AppHandle, delta: &str, request_id: &str) -> bool {
    app.emit(
        "agent-stream-chunk",
        AgentStreamEvent {
            event: "chunk".into(),
            data: delta.to_string(),
            request_id: request_id.to_string(),
        },
    )
    .is_ok()
}

fn emit_event(app: &AppHandle, event: &str, data: &str, request_id: &str) -> bool {
    app.emit(
        "agent-stream-chunk",
        AgentStreamEvent {
            event: event.into(),
            data: data.to_string(),
            request_id: request_id.to_string(),
        },
    )
    .is_ok()
}
