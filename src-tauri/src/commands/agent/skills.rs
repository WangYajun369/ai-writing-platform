//! Agent Skills IPC 命令
//!
//! 暴露给前端的 Tauri 命令，用于与 Python Agent Server 交互。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::python::{self, client::SkillRequest, client::AiModelConfig, client::MemoryListResponse, manager::AgentManager, AgentState};

/// Agent 状态信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub state: String,
    pub base_url: String,
}

/// 获取 Agent Server 状态
#[tauri::command]
pub async fn get_agent_status(
    agent: State<'_, Arc<AgentManager>>,
) -> Result<AgentStatus, AppError> {
    let state = agent.state().await;
    Ok(AgentStatus {
        state: match state {
            AgentState::Stopped => "stopped".into(),
            AgentState::Starting => "starting".into(),
            AgentState::Running => "running".into(),
            AgentState::Crashed(reason) => format!("crashed: {}", reason),
        },
        base_url: agent.base_url().to_string(),
    })
}

/// 启动 Agent Server
#[tauri::command]
pub async fn start_agent(
    agent: State<'_, Arc<AgentManager>>,
) -> Result<AgentStatus, AppError> {
    agent.start().await?;
    let state = agent.state().await;
    Ok(AgentStatus {
        state: match state {
            AgentState::Running => "running".into(),
            _ => "unknown".into(),
        },
        base_url: agent.base_url().to_string(),
    })
}

/// 停止 Agent Server
#[tauri::command]
pub async fn stop_agent(
    agent: State<'_, Arc<AgentManager>>,
) -> Result<(), AppError> {
    agent.stop().await
}

/// 执行 Agent Skill（SSE 流式）
///
/// 结果通过 Tauri 事件 `agent-stream-chunk` 推送到前端。
/// 每个事件携带 request_id，前端据此过滤属于自己的事件。
/// 返回值为最终累积的完整文本。
#[tauri::command]
pub async fn execute_agent_skill(
    app: AppHandle,
    agent: State<'_, Arc<AgentManager>>,
    skill: String,
    book_id: String,
    message: String,
    conversation_history: Option<Vec<SkillHistoryItem>>,
    ai_config: Option<AiConfigParams>,
    request_id: Option<String>,
    conversation_summary: Option<String>,
) -> Result<String, AppError> {
    // 确保 Agent 在运行
    let state = agent.state().await;
    if state != AgentState::Running {
        return Err(AppError::Business(
            "Agent 服务未运行，请先启动 Agent".into(),
        ));
    }

    let history = conversation_history.map(|h| {
        h.into_iter()
            .map(|item| python::client::ChatHistoryItem {
                role: item.role,
                content: item.content,
            })
            .collect()
    });

    let req = SkillRequest {
        skill,
        book_id,
        message,
        conversation_history: history,
        ai_config: ai_config.map(|c| AiModelConfig {
            provider: c.provider,
            endpoint: c.endpoint,
            model: c.model,
            api_key: c.api_key.clone(),
            temperature: c.temperature,
            max_tokens: c.max_tokens,
            thinking_enabled: c.thinking_enabled,
            reasoning_effort: c.reasoning_effort.clone(),
        }),
        conversation_summary,
    };

    python::client::execute_skill_with_id(app, agent.inner().clone(), req, request_id).await
}

/// 对话历史项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillHistoryItem {
    pub role: String,
    pub content: String,
}

/// AI 配置参数（前端传入）
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

/// 取消当前 Agent 任务
#[tauri::command]
pub async fn cancel_agent_skill(
    agent: State<'_, Arc<AgentManager>>,
) -> Result<(), AppError> {
    python::client::cancel_skill(agent.inner().clone()).await
}

// ══════ 记忆管理命令 ══════

/// 列出指定书籍的记忆
#[tauri::command]
pub async fn list_agent_memories(
    agent: State<'_, Arc<AgentManager>>,
    book_id: String,
    skill_type: Option<String>,
) -> Result<MemoryListResponse, AppError> {
    python::client::list_memories(
        agent.inner().clone(),
        &book_id,
        skill_type.as_deref(),
    )
    .await
}

/// 更新一条记忆
#[tauri::command]
pub async fn update_agent_memory(
    agent: State<'_, Arc<AgentManager>>,
    memory_id: i64,
    content: Option<String>,
    keywords: Option<String>,
    memory_type: Option<String>,
) -> Result<(), AppError> {
    python::client::update_memory(
        agent.inner().clone(),
        memory_id,
        content.as_deref(),
        keywords.as_deref(),
        memory_type.as_deref(),
    )
    .await
}

/// 删除一条记忆
#[tauri::command]
pub async fn delete_agent_memory(
    agent: State<'_, Arc<AgentManager>>,
    memory_id: i64,
) -> Result<(), AppError> {
    python::client::delete_memory(agent.inner().clone(), memory_id).await
}

/// 清空指定书籍的所有记忆
#[tauri::command]
pub async fn clear_agent_memories(
    agent: State<'_, Arc<AgentManager>>,
    book_id: String,
) -> Result<i64, AppError> {
    python::client::clear_memories(agent.inner().clone(), &book_id).await
}
