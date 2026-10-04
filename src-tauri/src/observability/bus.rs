//! Telemetry 进程内事件总线 + 单一入口
//!
//! 替代散落的 4 套记录点:`emit_sql_log` / `agent_trace_repo::insert_trace` /
//! `try_acquire_io_lock` 静默 / 错误日志。提供 `emit_sql` / `emit_agent_trace`
//! / `emit_io` / `emit_error` 四个类型化入口。
//!
//! - 内存缓冲:最近 1000 条供调试控制台即时回放
//! - 事件总线:`telemetry-event` + 兼容旧 `debug-log`(只对 SQL 事件别名)
//! - 持久化:可选写 `telemetry_events` 表(调用方传 `&Connection`)
//! - 开关:`TELEMETRY_BROADCAST_ENABLED` 控制是否广播(默认关,调试窗口打开时启用)
//!
//! 失败静默:`emit_xxx` 永不阻塞业务流(用 `let _ =` 容错)。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use super::event::{TelemetryEvent, TelemetryKind};
use super::persist;

/// 内存缓冲上限(滚动)
const BUFFER_CAPACITY: usize = 1000;

static TELEMETRY_BUFFER: OnceLock<Mutex<Vec<TelemetryEvent>>> = OnceLock::new();

fn buffer() -> &'static Mutex<Vec<TelemetryEvent>> {
    TELEMETRY_BUFFER.get_or_init(|| Mutex::new(Vec::with_capacity(BUFFER_CAPACITY)))
}

/// 全局广播开关(默认关闭,调试窗口打开时启用)
static TELEMETRY_BROADCAST_ENABLED: AtomicBool = AtomicBool::new(false);

/// 启用事件总线广播(调试窗口打开时调用)
pub fn enable_broadcast() {
    TELEMETRY_BROADCAST_ENABLED.store(true, Ordering::Release);
}

/// 禁用事件总线广播(调试窗口关闭时调用)
pub fn disable_broadcast() {
    TELEMETRY_BROADCAST_ENABLED.store(false, Ordering::Release);
}

/// 是否启用事件总线广播
pub fn is_broadcast_enabled() -> bool {
    TELEMETRY_BROADCAST_ENABLED.load(Ordering::Acquire)
}

/// 主入口:记录一条事件(缓冲 + 可选持久化 + 受控广播)
///
/// - `app` 为 None 时不广播(如纯 service 调用)
/// - `conn` 为 None 时不持久化(如 SQL 审计高频率,默认不写表)
/// - 广播受 `TELEMETRY_BROADCAST_ENABLED` 开关控制
pub fn emit(
    app: Option<&AppHandle>,
    conn: Option<&rusqlite::Connection>,
    mut event: TelemetryEvent,
) {
    // 1. 内存缓冲(总是执行)
    if let Ok(mut buf) = buffer().lock() {
        if buf.len() >= BUFFER_CAPACITY {
            buf.remove(0);
        }
        buf.push(event.clone());
    }
    // 2. 持久化(可选)
    if let Some(conn) = conn {
        let _ = persist::insert(conn, &mut event);
    }
    // 3. 广播(受开关控制)
    if !TELEMETRY_BROADCAST_ENABLED.load(Ordering::Acquire) {
        return;
    }
    if let Some(app) = app {
        let _ = app.emit("telemetry-event", &event);
        // 向后兼容:SQL 事件同时 emit 旧 `debug-log` 别名,
        // 让未迁移的前端组件继续工作
        if event.kind == TelemetryKind::Sql {
            let _ = app.emit("debug-log", &event);
        }
    }
}

// ─── 类型化便捷入口 ───

/// SQL 审计事件(替代 `emit_sql_log`)
///
/// 与旧 `emit_sql_log` 签名兼容(便于 wrapper 委托),不持久化(高频)。
pub fn emit_sql(
    app: Option<&AppHandle>,
    operation: &str,
    table: &str,
    detail: &str,
    file: &str,
    line: u32,
) {
    let payload = serde_json::json!({
        "operation": operation,
        "table": table,
        "detail": detail,
    });
    let mut event = TelemetryEvent::new(
        TelemetryKind::Sql,
        "info",
        format!("[SQL] {} → {} | {}", operation, table, detail),
    );
    event.file = Some(file.to_string());
    event.file_name = Some(file.split('/').next_back().unwrap_or(file).to_string());
    event.line = Some(line);
    event.payload = Some(payload);
    emit(app, None, event);
}

/// Agent 轨迹事件:写 `agent_traces` 表 + emit 事件(实时推送前端)
///
/// 调用方传 `&Connection`,本函数同时写表与广播。原 `engine.rs` 三点调用
/// `agent_trace_repo::insert_trace` 改为本函数,行为等价 + 增加事件广播。
pub fn emit_agent_trace(
    app: Option<&AppHandle>,
    conn: &rusqlite::Connection,
    request_id: &str,
    skill: &str,
    round: usize,
    role: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_args: Option<&str>,
    tool_result: Option<&str>,
) {
    // 写 agent_traces 表(保持原行为)
    let _ = crate::repository::agent_trace_repo::insert_trace(
        conn,
        request_id,
        skill,
        round,
        role,
        content,
        tool_name,
        tool_args,
        tool_result,
    );
    // emit 事件(供前端实时查看)
    let payload = serde_json::json!({
        "requestId": request_id,
        "skill": skill,
        "round": round,
        "role": role,
        "toolName": tool_name,
        "toolArgs": tool_args,
        "toolResult": tool_result,
    });
    let mut event = TelemetryEvent::new(
        TelemetryKind::Agent,
        "info",
        format!("[Agent] {} #{} {}: {}", skill, round, role, content),
    );
    event.payload = Some(payload);
    emit(app, None, event);
}

/// IO 通道事件(acquire / release / busy)
pub fn emit_io(app: Option<&AppHandle>, op: &str, detail: &str, file: &str, line: u32) {
    let payload = serde_json::json!({"operation": op, "detail": detail});
    let mut event = TelemetryEvent::new(
        TelemetryKind::Io,
        "info",
        format!("[IO] {} | {}", op, detail),
    );
    event.file = Some(file.to_string());
    event.file_name = Some(file.split('/').next_back().unwrap_or(file).to_string());
    event.line = Some(line);
    event.payload = Some(payload);
    emit(app, None, event);
}

/// 错误事件(关键路径失败时记录)
pub fn emit_error(app: Option<&AppHandle>, code: &str, message: &str, source: Option<&str>) {
    let payload = serde_json::json!({"code": code, "raw": message});
    let mut event = TelemetryEvent::new(
        TelemetryKind::Error,
        "error",
        format!("[Error] {} | {}", code, message),
    );
    event.source = source.map(String::from);
    event.payload = Some(payload);
    emit(app, None, event);
}

/// 系统事件(启动 / 关闭 / 调度 / 后台任务)
#[allow(dead_code)] // 预留：系统级遥测入口，后续接入启动/调度事件
pub fn emit_system(app: Option<&AppHandle>, level: &str, message: &str) {
    let event = TelemetryEvent::new(TelemetryKind::System, level, message);
    emit(app, None, event);
}

// ─── 缓冲查询入口(供调试控制台 IPC 命令使用) ───

/// 列出缓冲的事件(可选 kind 过滤)
pub fn list_buffered(kind: Option<TelemetryKind>) -> Vec<TelemetryEvent> {
    let buf = match buffer().lock() {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    match kind {
        Some(k) => buf.iter().filter(|e| e.kind == k).cloned().collect(),
        None => buf.clone(),
    }
}

/// 清空内存缓冲
pub fn clear_buffer() {
    if let Ok(mut buf) = buffer().lock() {
        buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_caps_at_capacity() {
        // 清空(并发测试可能仍在写入,但本测试只验证上界)
        clear_buffer();
        for i in 0..BUFFER_CAPACITY + 50 {
            emit(
                None,
                None,
                TelemetryEvent::new(TelemetryKind::System, "info", format!("e{i}")),
            );
        }
        let all = list_buffered(None);
        // 上界断言:并发测试可能让其它 kind 的事件也写入,但总长度不应超容量
        assert!(
            all.len() <= BUFFER_CAPACITY,
            "buffer 长度 {} 超过容量上限 {}",
            all.len(),
            BUFFER_CAPACITY
        );
    }

    #[test]
    fn list_filters_by_kind() {
        clear_buffer();
        emit(
            None,
            None,
            TelemetryEvent::new(TelemetryKind::Sql, "info", "sql1"),
        );
        emit(
            None,
            None,
            TelemetryEvent::new(TelemetryKind::Error, "error", "err1"),
        );
        emit(
            None,
            None,
            TelemetryEvent::new(TelemetryKind::Agent, "info", "ag1"),
        );

        let sqls = list_buffered(Some(TelemetryKind::Sql));
        assert_eq!(sqls.len(), 1);
        assert_eq!(sqls[0].message, "sql1");
    }

    #[test]
    fn broadcast_disabled_by_default() {
        assert!(!is_broadcast_enabled());
        enable_broadcast();
        assert!(is_broadcast_enabled());
        disable_broadcast();
        assert!(!is_broadcast_enabled());
    }
}
