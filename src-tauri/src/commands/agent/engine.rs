//! Agent Skill 执行引擎（ReAct 循环 · SSE 流式）
//!
//! 自 Python agent/skills/engine.py + server/sse.py + python/client.rs 迁移。
//! 原实现由 Rust 转发 HTTP(9877) → Python(LangGraph) 执行，现改为 Rust 内
//! 直接与模型 API 对话：OpenAI function calling 协议 + 数据库工具循环。
//!
//! 事件契约与旧 Python 完全一致（事件名 `agent-stream-chunk`，事件体
//! `{ event, data, requestId }`，event ∈ chunk / done / error / cancelled）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use futures_util::StreamExt;
use r2d2::Pool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::timeout;

use crate::commands::agent::sse_parser::{
    flush_remaining_line, next_line, parse_sse_data, LineParse, PendingToolCall, PendingToolCalls,
};
use crate::commands::agent::{memory, pipeline, profiles, prompts, tools};
use crate::commands::agent::profiles::RuntimeMode;
use crate::db::SqliteConnectionManager;
use crate::error::AppError;
use crate::repository;
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

/// Agent 最大工具推理轮数（兜底默认值；优先使用 `AgentBudget::from_effective` 的自适应值）
const MAX_ITERATIONS: usize = 15;
/// 单轮 SSE 无数据读取超时（秒）
const SSE_READ_TIMEOUT_SECS: u64 = 60;
/// 整个 Agent 执行总超时（秒）
const SSE_TOTAL_TIMEOUT_SECS: u64 = 600;

/// Agent 执行预算：可控性与成本约束。
///
/// v1.9：取代硬编码 15 轮上限，按 Skill 自适应。
/// v1.20：数值改为查 L1 画像注册表（profiles.rs），本文件不再维护各 Skill 的预算：
/// - writing：创作场景，少工具调用，5 轮足够
/// - analysis：分析场景，中等工具调用，10 轮
/// - research：研究场景，多工具调用，20 轮
/// - polish：润色场景，几乎不调工具，3 轮
///
/// 未知**能力** id 回退 `MAX_ITERATIONS` / `SSE_TOTAL_TIMEOUT_SECS`（**不是** writing 的预算）。
///
/// 后续可由调用方（命令层）传入自定义预算覆盖 Skill 默认值。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct AgentBudget {
    /// 最大工具推理轮数
    pub max_rounds: usize,
    /// 单轮 SSE 无数据读取超时（秒）
    pub sse_read_timeout_secs: u64,
    /// 整个 Agent 执行总超时（秒）
    pub sse_total_timeout_secs: u64,
}

impl AgentBudget {
    /// 由已合并的有效画像构造预算（阶段四起 engine 走此路径）
    ///
    /// ⚠️ 未知能力 id 走 `Default`（`MAX_ITERATIONS` / `SSE_TOTAL_TIMEOUT_SECS`），
    /// **不是** writing 的 (5 轮 / 300s)——与改造前 `for_skill` 的语义一致。
    /// `merge` 虽已把能力兜底为 writing（提示词与工具需要），但预算必须保留这层区分，
    /// 故 `EffectiveProfile::ability_matched` 不可省。
    pub fn from_effective(eff: &crate::commands::agent::profiles::EffectiveProfile) -> Self {
        if !eff.ability_matched {
            return Self::default();
        }
        Self {
            max_rounds: eff.max_rounds,
            sse_read_timeout_secs: SSE_READ_TIMEOUT_SECS,
            sse_total_timeout_secs: eff.timeout_secs,
        }
    }
}

impl Default for AgentBudget {
    fn default() -> Self {
        Self {
            max_rounds: MAX_ITERATIONS,
            sse_read_timeout_secs: SSE_READ_TIMEOUT_SECS,
            sse_total_timeout_secs: SSE_TOTAL_TIMEOUT_SECS,
        }
    }
}
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

/// 取消令牌（阶段六起由 pipeline.rs 共享：流水线每一步都要能即时中断）
pub(crate) struct CancelToken {
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

    /// 阶段六起由 pipeline.rs 共享：流水线每步开始前都要检查一次取消
    pub(crate) fn is_cancelled(&self) -> bool {
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

/// ReAct 循环的不变运行时上下文。
///
/// 收拢原 react_loop 的 9 个标量参数（url / api_key / model / temperature /
/// max_tokens / request_id / cancel_token / budget / skill），使签名从 15 个
/// 参数降到 7 个（app / pool / tools_schema / &mut messages / &mut full_response /
/// &mut tool_rounds / ctx），消除 `clippy::too_many_arguments`。
///
/// pipeline.rs 的调用点只需把 `PipelineCtx` 的对应字段 collect 后传入。
pub(crate) struct ReactCtx {
    pub url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub request_id: String,
    pub cancel_token: Arc<CancelToken>,
    pub budget: AgentBudget,
    pub skill: String,
}

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
    // 插件 JS 生成的编排计划（`None` = 不接管编排，按画像默认方式跑）
    plan: Option<Vec<profiles::OwnedStep>>,
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
        plan.as_deref(),
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
    plan: Option<&[profiles::OwnedStep]>,
) -> Result<String, AppError> {
    // ========== 1. 解析有效画像（领域 × 能力）==========
    // 领域由作品的 book_type 决定，在 Rust 侧反查——前端不传参，
    // 避免「前端忘了传 / 传错」导致模型用错画像（阶段四任务 3）。
    let book_type = {
        let conn = pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
        repository::book_repo::find_by_id(&conn, book_id)
            .map(|b| b.book_type)
            // 作品不存在（如已彻底删除）时按空处理，领域回退 novel
            .unwrap_or_default()
    };
    // 插件画像必须**先于** merge 查找：插件 id 不在内置注册表里，
    // 直接走 merge 会被兜底成 writing——用户明明选了插件画像，跑的却是 writing。
    let plugin_hit = crate::plugin::profile::find(&app, skill);
    let mut effective = match &plugin_hit {
        Some((p, _)) => crate::plugin::profile::to_effective(p, &book_type),
        None => profiles::merge(skill, &book_type),
    };

    // 插件 JS 生成的编排计划只在「本次确实命中了插件画像」时生效——
    // 避免内置画像被外部传入的 plan 意外改写成流水线。
    // 权限在此再校验一次：前端那遍只是 UX，IPC 边界不可信。
    if let (Some((_, grants)), Some(steps)) = (&plugin_hit, plan) {
        crate::plugin::profile::plan_is_allowed(steps, grants)?;
        effective.runtime = RuntimeMode::DynamicPipeline(steps.to_vec());
    }
    // v1.9：按 Skill 自适应预算（取代硬编码 15 轮上限）
    // 阶段四起取「领域 × 能力」合并后的预算（取较大值）
    let budget = AgentBudget::from_effective(&effective);
    // 阶段四任务 7：输出「解析后的最终画像」，便于排查「模型用了错画像」类问题
    let effective_tokens = prompts::estimate_prompt_tokens(&effective.base_prompt);
    crate::app_log!(
        "[Agent] 有效画像: 能力={}({}) 领域={}(book_type=`{}`) 工具={} 预算={}轮/{}s 基准提示≈{}tok",
        // 用入参 skill 而非 effective.ability.id：后者在插件画像场景下是
        // writing 占位，打出来会让人误以为跑了 writing
        skill,
        if effective.ability_matched {
            "内置命中"
        } else if plugin_hit.is_some() {
            "插件"
        } else {
            "兜底"
        },
        effective.domain.id,
        book_type,
        effective.tools.len(),
        budget.max_rounds,
        budget.sse_total_timeout_secs,
        effective_tokens,
    );

    // ========== 2. 组装 System Prompt ==========
    // 四段拼接：领域基准 → 能力基准 → 领域动态提示 → 能力动态提示
    let dynamic_prompt = prompts::compose_system_prompt(&effective, message);

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

    // ========== 3. 组装消息列表 ==========
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

    // ========== 4. 模型端点与参数 ==========
    let cfg = ai_config;
    let endpoint = cfg
        .map(|c| c.endpoint.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.deepseek.com".to_string());
    let model = cfg
        .map(|c| c.model.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "deepseek-chat".to_string());
    let api_key = cfg
        .and_then(|c| c.api_key.clone())
        .map(|k| k.trim().to_string());
    if api_key.as_deref().is_none_or(|k| k.is_empty()) {
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

    // 工具集取「能力 ∪ 领域」并集（阶段四）
    let tools_schema = tools::build_tools_schema(&effective.tools);

    let url = format!("{endpoint}/chat/completions");

    // ========== 5. 按 L2 执行模式分发 ==========
    // 两种模式共用同一套 SSE / 取消 / trace 链路，差别只在「跑一个循环」还是
    // 「按步骤跑多个收窄的循环」；因此超时守卫仍只需在外面套一层。
    let mut full_response = String::new();
    let mut tool_rounds = 0usize;

    let total_guard = timeout(
        std::time::Duration::from_secs(SSE_TOTAL_TIMEOUT_SECS),
        async {
            // 先把两种流水线变体归一成 owned 步骤：`Pipeline` 是编译期常量表
            // （内置画像），`DynamicPipeline` 是插件运行时生成的计划（ADR-006）。
            // 归一之后两者走**同一段执行代码**，行为不会随来源而分叉。
            let plan_steps: Option<Vec<profiles::OwnedStep>> = match &effective.runtime {
                RuntimeMode::ReAct => None,
                RuntimeMode::Pipeline(steps) => {
                    Some(steps.iter().map(profiles::OwnedStep::from).collect())
                }
                RuntimeMode::DynamicPipeline(steps) => Some(steps.clone()),
            };

            match plan_steps {
                // ReAct：与改造前完全一致的单一循环，行为零变化（回归安全）
                None => {
                    let ctx = ReactCtx {
                        url,
                        api_key: api_key.unwrap_or_default(),
                        model,
                        temperature,
                        max_tokens,
                        request_id: request_id.to_string(),
                        cancel_token: cancel_token.clone(),
                        budget,
                        skill: skill.to_string(),
                    };
                    react_loop(
                        app.clone(),
                        pool.clone(),
                        tools_schema,
                        &mut messages,
                        &mut full_response,
                        &mut tool_rounds,
                        ctx,
                    )
                    .await?;
                    Ok::<String, AppError>(std::mem::take(&mut full_response))
                }
                // Pipeline：按步骤依次执行，上一步产物喂给下一步。
                // 步骤可能来自内置画像常量，也可能来自插件运行时生成的计划——
                // 后者的工具权限已在入口校验过（见 `plugin::profile::plan_is_allowed`）。
                Some(steps) => {
                    crate::app_log!(
                        "[Agent] 流水线模式：{} 步（{}）",
                        steps.len(),
                        steps
                            .iter()
                            .map(|s| s.name.as_str())
                            .collect::<Vec<_>>()
                            .join(" → ")
                    );
                    let ctx = pipeline::PipelineCtx {
                        app: &app,
                        pool: &pool,
                        url: &url,
                        api_key: api_key.as_deref().unwrap_or(""),
                        model: &model,
                        temperature,
                        max_tokens,
                        request_id,
                        cancel_token,
                        budget: &budget,
                        skill,
                    };
                    let outcome =
                        pipeline::run_pipeline(&ctx, &steps, &system_prompt, message).await;
                    // 步骤头 / 收尾已在 run_pipeline 内逐段推送，此处只把同样的
                    // 文本作为返回值，保证「前端累积文本 == IPC 返回值」
                    full_response.push_str(&outcome.render());
                    Ok(full_response.clone())
                }
            }
        },
    )
    .await;

    match total_guard {
        Ok(Ok(text)) => {
            // 取消路径已由 react_loop 发出 cancelled 事件，这里不再补发 done
            if !cancel_token.is_cancelled() {
                let _ = emit_event(&app, "done", "", request_id);
            }
            Ok(text)
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

/// 开放给 `pipeline.rs`：流水线的每一步就是一个「工具与轮数被收窄」的 ReAct，
/// 复用本函数可避免把 SSE 解析 / 取消竞争 / trace 上报再抄一遍。
pub(crate) async fn react_loop(
    app: AppHandle,
    pool: Pool<SqliteConnectionManager>,
    tools_schema: Vec<Value>,
    messages: &mut Vec<Value>,
    full_response: &mut String,
    tool_rounds: &mut usize,
    ctx: ReactCtx,
) -> Result<(), AppError> {
    loop {
        if ctx.cancel_token.is_cancelled() {
            let _ = emit_event(&app, "cancelled", "任务已被用户取消", &ctx.request_id);
            return Ok(());
        }
        if *tool_rounds >= ctx.budget.max_rounds {
            crate::app_log!(
                "[Agent] 达到最大推理轮数 ({}), 结束工具循环",
                ctx.budget.max_rounds
            );
            break;
        }
        *tool_rounds += 1;

        // DeepSeek thinking 参数：Python SDK 无法透传，Rust 直连亦不传，保持行为一致
        //（如需思考模式可在此按 ai_config.thinking_enabled 显式开启）
        let body = serde_json::json!({
            "model": &ctx.model,
            "messages": messages,
            "stream": true,
            "temperature": ctx.temperature,
            "max_tokens": ctx.max_tokens,
            "tools": tools_schema,
            "tool_choice": "auto",
        });

        let client = get_sse_client().clone();
        let req = client
            .post(&ctx.url)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .header("Authorization", format!("Bearer {}", ctx.api_key));

        // 发送阶段也与取消信号竞争：客户端仅配 connect_timeout（30s），
        // 若服务端迟迟不返回响应头，取消可在此即时退出而不被长时间挂起
        let send_fut = req.json(&body).send();
        tokio::pin!(send_fut);
        let send_notified = ctx.cancel_token.notified();
        tokio::pin!(send_notified);
        let send_result = tokio::select! {
            biased;
            _ = &mut send_notified => {
                if ctx.cancel_token.is_cancelled() {
                    let _ = emit_event(&app, "cancelled", "任务已被用户取消", &ctx.request_id);
                    return Ok(());
                }
                // 非取消通知（理论上不发生）：继续完成原请求
                send_fut.await
            }
            resp = &mut send_fut => resp,
        };

        let response = send_result.map_err(|e| {
            let err_str = e.to_string();
            let hint = classify_http_error(&err_str);
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
        let mut tool_calls: PendingToolCalls = Default::default();
        let mut stream_finished = false;

        'outer: loop {
            // 等待下一个 SSE chunk 与取消信号竞争：用户取消可即时打断阻塞的
            // 流读取（含 60s 行超时窗口与流已结束的静默期），无需等待超时或
            // 下一个 chunk 到达；被放弃的 stream.next() future 随即 drop，
            // 底层 reqwest 连接中止，服务端感知后停止继续生成。
            let notified = ctx.cancel_token.notified();
            tokio::pin!(notified);
            let next_chunk = timeout(
                std::time::Duration::from_secs(SSE_READ_TIMEOUT_SECS),
                stream.next(),
            );
            let chunk = tokio::select! {
                biased;
                _ = &mut notified => {
                    if ctx.cancel_token.is_cancelled() {
                        let _ = emit_event(&app, "cancelled", "任务已被用户取消", &ctx.request_id);
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
                    let (_done, deltas) = flush_remaining_line(
                        &mut buffer,
                        &mut round_content,
                        &mut tool_calls,
                        full_response,
                    );
                    for d in deltas {
                        let _ = emit_event(&app, "chunk", &d, &ctx.request_id);
                    }
                    break 'outer;
                }
                Err(_elapsed) => {
                    // 60s 无数据：按有内容收尾处理
                    crate::app_log_error!(
                        "[Agent] SSE 读取超时 ({}s 无数据)",
                        SSE_READ_TIMEOUT_SECS
                    );
                    let (_done, deltas) = flush_remaining_line(
                        &mut buffer,
                        &mut round_content,
                        &mut tool_calls,
                        full_response,
                    );
                    for d in deltas {
                        let _ = emit_event(&app, "chunk", &d, &ctx.request_id);
                    }
                    break 'outer;
                }
            };

            // 竞态兜底：若取消信号恰在 select 选中 chunk 分支之后到达，
            // 此复查保证在解析该批 buffer 前立即中断退出，无需等下一轮循环。
            if ctx.cancel_token.is_cancelled() {
                let _ = emit_event(&app, "cancelled", "任务已被用户取消", &ctx.request_id);
                return Ok(());
            }

            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // 逐行取出并解析
            while let Some(line) = next_line(&mut buffer) {
                if line.is_empty() || !line.starts_with("data:") {
                    continue;
                }
                let json_str = line[5..].trim().to_string();
                let LineParse { done, deltas } = parse_sse_data(
                    &json_str,
                    &mut round_content,
                    &mut tool_calls,
                    full_response,
                );
                if done {
                    stream_finished = true;
                    break 'outer;
                }
                for d in deltas {
                    let _ = emit_event(&app, "chunk", &d, &ctx.request_id);
                }
            }
        }

        // 处理后事（流中断时缓冲残留行）
        if !stream_finished && !buffer.is_empty() {
            let (_done, deltas) = flush_remaining_line(
                &mut buffer,
                &mut round_content,
                &mut tool_calls,
                full_response,
            );
            for d in deltas {
                let _ = emit_event(&app, "chunk", &d, &ctx.request_id);
            }
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
        let conn = pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
        // v1.9：trace 持久化 — 记录本轮 assistant 响应（含 tool_calls 计划）
        // v1.9+：通过 telemetry::bus::emit_agent_trace 写表 + 实时推 telemetry-event 事件,
        // 前端调试控制台无需轮询 list_agent_traces 即可看到推理过程
        crate::observability::bus::emit_agent_trace(
            Some(&app),
            &conn,
            &ctx.request_id,
            &ctx.skill,
            *tool_rounds,
            "assistant",
            &round_content,
            None,
            None,
            None,
        );
        for (_, tc) in &collected {
            if ctx.cancel_token.is_cancelled() {
                let _ = emit_event(&app, "cancelled", "任务已被用户取消", &ctx.request_id);
                return Ok(());
            }
            let args_value: Value =
                serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
            // v1.9：trace 持久化 — 记录工具调用
            crate::observability::bus::emit_agent_trace(
                Some(&app),
                &conn,
                &ctx.request_id,
                &ctx.skill,
                *tool_rounds,
                "tool_call",
                &tc.name,
                Some(&tc.name),
                Some(&tc.arguments),
                None,
            );
            let result = match tools::execute_tool(&conn, &tc.name, &args_value) {
                Ok(text) => text,
                Err(e) => {
                    crate::app_log_error!("[Agent] 工具 {} 执行失败: {}", tc.name, e);
                    format!("工具执行错误：{}", e)
                }
            };
            let result = clamp_text(&result, MAX_TOOL_RESULT_CHARS);
            // v1.9：trace 持久化 — 记录工具结果
            crate::observability::bus::emit_agent_trace(
                Some(&app),
                &conn,
                &ctx.request_id,
                &ctx.skill,
                *tool_rounds,
                "tool_result",
                &result,
                Some(&tc.name),
                None,
                Some(&result),
            );
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

/// 对 HTTP 层错误字符串做模式匹配，返回对应的中文诊断提示。
///
/// 覆盖 DNS、连接拒绝、超时、TLS/证书、上游 5xx 等常见场景；无法识别时
/// 返回"通用代理/防火墙"兜底提示。返回值不含 `\n` 前缀，由调用方决定拼接方式。
fn classify_http_error(err_str: &str) -> &'static str {
    if err_str.contains("dns") || err_str.contains("resolve") {
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
    } else if err_str.contains("502") || err_str.contains("503") || err_str.contains("504") {
        "\n诊断：AI 服务暂时不可用，请稍后重试"
    } else {
        "\n诊断：无法连接到 AI 服务（可能是代理/防火墙阻止），请在系统中设置 HTTPS_PROXY 环境变量后重启应用"
    }
}

// ─── 事件推送 ───

/// 推一个 SSE 事件。开放给 `pipeline.rs`（推步骤进度头）。
///
/// 事件契约见文件头：`event ∈ chunk / done / error / cancelled`。流水线额外推的
/// 仍是 `chunk`（步骤标题行），**不引入新事件类型**——既保持契约稳定，也让前端
/// 累积到的文本与最终返回值天然一致。
pub(crate) fn emit_event(app: &AppHandle, event: &str, data: &str, request_id: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_text_truncates_with_marker() {
        let short = "正常结果";
        assert_eq!(clamp_text(short, 100), short);

        let long = "字".repeat(100);
        let out = clamp_text(&long, 50);
        assert!(out.starts_with(&"字".repeat(50)));
        assert!(out.contains("已截断"));
        assert!(out.chars().count() < long.chars().count());
    }

    #[test]
    fn cancel_token_flag_semantics() {
        let token = CancelToken::new();
        assert!(!token.is_cancelled());
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn global_cancel_registry_roundtrip() {
        // 注册 → cancel_current_task 命中 → 注销（ptr_eq 防误删新令牌）
        let token = register_cancel_token();
        cancel_current_task();
        assert!(token.is_cancelled(), "全局取消应作用于当前注册令牌");

        unregister_cancel_token(&token);
        // 注销后全局取消不再影响该令牌（语义：无当前任务时调用为空操作）
        let token2 = CancelToken::new();
        cancel_current_task();
        assert!(!token2.is_cancelled());
    }

    /// cancel() 的 notify_waiters 能即时唤醒 select! 中的等待方（即时中断语义）
    #[tokio::test]
    async fn cancel_notifies_waiters_immediately() {
        let token = Arc::new(CancelToken::new());
        let waiter = token.clone();
        // oneshot 以 await 等待就绪（让出执行权），避免阻塞 current_thread 运行时造成死锁
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            // enable() 在任务内注册等待者并通知主线程，确保 cancel 发生在注册之后（确定性）
            let notified = waiter.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let _ = ready_tx.send(());
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => "timeout",
                _ = notified => "cancelled",
            }
        });
        ready_rx.await.expect("waiter registered");
        token.cancel();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("取消唤醒应在 2s 内完成")
            .unwrap();
        assert_eq!(outcome, "cancelled");
    }

    /// 按「能力 × 领域」合并后取预算
    fn budget_for(ability: &str, domain: &str) -> AgentBudget {
        AgentBudget::from_effective(&profiles::merge(ability, domain))
    }

    #[test]
    fn agent_budget_writing_is_conservative() {
        let b = budget_for("writing", "novel");
        assert_eq!(b.max_rounds, 5);
        assert_eq!(b.sse_total_timeout_secs, 300);
        assert_eq!(b.sse_read_timeout_secs, SSE_READ_TIMEOUT_SECS);
    }

    #[test]
    fn agent_budget_research_is_generous() {
        let b = budget_for("research", "thesis");
        assert_eq!(b.max_rounds, 20);
        assert_eq!(b.sse_total_timeout_secs, 600);
    }

    #[test]
    fn agent_budget_analysis_and_polish() {
        assert_eq!(budget_for("analysis", "breakdown").max_rounds, 10);
        assert_eq!(budget_for("polish", "note").max_rounds, 3);
    }

    /// 领域画像预算为 0（不约束），故预算与领域无关、只由能力决定
    #[test]
    fn agent_budget_is_independent_of_domain() {
        for d in ["novel", "thesis", "breakdown", "note"] {
            assert_eq!(budget_for("research", d).max_rounds, 20);
        }
    }

    /// ⚠️ 未知能力回退 `(MAX_ITERATIONS, SSE_TOTAL_TIMEOUT_SECS)`，
    /// **不是** writing 的 (5, 300)——这是改造前的既有语义，不可漂移
    #[test]
    fn agent_budget_for_unknown_ability_falls_back_to_max_iterations() {
        let b = budget_for("unknown_ability", "novel");
        assert_eq!(b.max_rounds, MAX_ITERATIONS);
        assert_eq!(b.sse_total_timeout_secs, SSE_TOTAL_TIMEOUT_SECS);
        // 与显式选 writing 的结果**必须不同**，否则 ability_matched 标记形同虚设
        assert_ne!(b.max_rounds, budget_for("writing", "novel").max_rounds);
    }

    #[test]
    fn agent_budget_default_matches_constants() {
        let b = AgentBudget::default();
        assert_eq!(b.max_rounds, MAX_ITERATIONS);
        assert_eq!(b.sse_read_timeout_secs, SSE_READ_TIMEOUT_SECS);
        assert_eq!(b.sse_total_timeout_secs, SSE_TOTAL_TIMEOUT_SECS);
    }
}
