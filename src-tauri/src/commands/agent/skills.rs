//! Agent Skill IPC 层
//!
//! Python Agent 已迁移为纯 Rust 实现（engine/memory/tools/prompts）。
//! 本模块负责前端命令入口：Skill 执行、记忆 CRUD。
//! （原生引擎无外部进程，Python 时代兼容用的 get_agent_status/start_agent/
//! stop_agent 命令已随迁移一并移除）

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::agent::{engine, memory};
use crate::db::AppDb;
use crate::error::AppError;

// ══════ Skill 执行 ══════

/// 对话历史消息项（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillHistoryItem {
    pub role: String,
    pub content: String,
}

/// AI 配置参数（前端传入，camelCase 与 aiSlice 一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigParams {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub thinking_enabled: Option<bool>,
    /// DeepSeek 思考强度：high（默认）或 max（Agent 推荐）
    /// 参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
    pub reasoning_effort: Option<String>,
}

impl From<AiConfigParams> for engine::AiModelConfig {
    fn from(v: AiConfigParams) -> Self {
        engine::AiModelConfig {
            provider: v.provider,
            endpoint: v.endpoint,
            model: v.model,
            api_key: v.api_key,
            temperature: v.temperature,
            max_tokens: v.max_tokens,
            thinking_enabled: v.thinking_enabled,
            reasoning_effort: v.reasoning_effort,
        }
    }
}

/// 执行 Agent Skill（SSE 流式）
///
/// 结果通过 Tauri 事件 `agent-stream-chunk` 推送到前端，事件体携带 request_id。
/// 返回值为最终累积的完整文本。
#[tauri::command]
pub async fn execute_agent_skill(
    app: AppHandle,
    db: State<'_, AppDb>,
    skill: String,
    book_id: String,
    message: String,
    conversation_history: Option<Vec<SkillHistoryItem>>,
    ai_config: Option<AiConfigParams>,
    request_id: Option<String>,
    conversation_summary: Option<String>,
) -> Result<String, AppError> {
    let history: Vec<engine::HistoryMsg> = conversation_history
        .unwrap_or_default()
        .into_iter()
        .map(|h| engine::HistoryMsg {
            role: h.role,
            content: h.content,
        })
        .collect();

    let history = if history.is_empty() {
        None
    } else {
        Some(history)
    };

    let config = ai_config.map(engine::AiModelConfig::from);
    let request_id = request_id.unwrap_or_default();

    engine::run_skill(
        app,
        db.pool.clone(),
        skill,
        book_id,
        message,
        history,
        config,
        request_id,
        conversation_summary,
    )
    .await
}

/// 取消当前 Agent Skill 任务
#[tauri::command]
pub fn cancel_agent_skill() -> Result<(), AppError> {
    engine::cancel_current_task();
    Ok(())
}

// ══════ 记忆管理命令 ══════

/// 列出指定书籍的记忆
#[tauri::command]
pub fn list_agent_memories(
    db: State<'_, AppDb>,
    book_id: String,
    skill_type: Option<String>,
) -> Result<memory::MemoryListResponse, AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    let memories = memory::get_memories(&conn, &book_id, skill_type.as_deref(), None, 200)?;
    let total = memories.len();
    Ok(memory::MemoryListResponse { memories, total })
}

/// 更新一条记忆
#[tauri::command]
pub fn update_agent_memory(
    db: State<'_, AppDb>,
    memory_id: i64,
    content: Option<String>,
    keywords: Option<String>,
    memory_type: Option<String>,
) -> Result<(), AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    memory::update_memory(
        &conn,
        memory_id,
        content.as_deref(),
        keywords.as_deref(),
        memory_type.as_deref(),
    )
}

/// 删除一条记忆
#[tauri::command]
pub fn delete_agent_memory(
    db: State<'_, AppDb>,
    memory_id: i64,
) -> Result<(), AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    memory::delete_memory(&conn, memory_id)
}

/// 清空指定书籍的所有记忆，返回删除条数
#[tauri::command]
pub fn clear_agent_memories(db: State<'_, AppDb>, book_id: String) -> Result<i64, AppError> {
    let conn = db.pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;
    memory::clear_memories(&conn, &book_id)
}
