//! Agent 推理轨迹服务层
//!
//! 调试控制台按 request_id 查询回放 + 批量清理。
//! 写入由 [`crate::commands::agent::engine`] 的 react_loop 自动完成，
//! 本服务只提供查询与清理两个对外能力。
//!
//! 分层职责：service 负责连接获取 + 审计日志，SQL 由 [`crate::repository::agent_trace_repo`] 执行。

use tauri::AppHandle;

use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::agent_trace_repo::{self, AgentTrace};
use crate::service::uow::UnitOfWork;

/// 按 request_id 列出 Agent 推理轨迹（按 round + created_at 升序，便于回放）
pub fn list_traces(
    app: &AppHandle,
    db: &AppDb,
    request_id: &str,
) -> Result<Vec<AgentTrace>, AppError> {
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "agent_traces",
        format!("request_id={request_id}"),
        file!(),
        line!(),
    );
    let traces = agent_trace_repo::list_traces_by_request(uow.conn(), request_id)?;
    // 只读查询无事务，但 commit() 用于 emit 累积的审计条目
    uow.commit()?;
    Ok(traces)
}

/// 清理 Agent 轨迹：传入 request_id 清指定会话，不传清全部
///
/// 返回被删除的记录数。
pub fn clear_traces(
    app: &AppHandle,
    db: &AppDb,
    request_id: Option<&str>,
) -> Result<usize, AppError> {
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    let detail = request_id
        .map(|rid| format!("request_id={rid}"))
        .unwrap_or_else(|| "ALL".to_string());
    uow.audit("DELETE", "agent_traces", detail, file!(), line!());
    let affected = match request_id {
        Some(rid) => agent_trace_repo::delete_traces_by_request(uow.conn(), rid)?,
        None => agent_trace_repo::clear_all_traces(uow.conn())?,
    };
    uow.commit()?;
    Ok(affected)
}
