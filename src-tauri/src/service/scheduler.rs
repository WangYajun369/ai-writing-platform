//! 后台任务调度器
//!
//! 取代 `lib.rs` 中耦合在 setup 闭包里的轮询循环。每个后台 job 独立 `spawn`，
//! 互不影响；连续失败 N 次后自动延长间隔（指数退避式简单实现），
//! 成功后重置；每轮通过 `scheduler-tick` 事件暴露状态供调试控制台观察。
//!
//! 当前接入的 job：
//! - `reminder`：任务卡到期提醒扫描（`reminder_service::run_once`）
//! - `trash_purge`：回收站 30 天自动清理（`task_service::purge_expired_trash`）
//!
//! 新增 job 步骤：在 [`register_all`] 末尾追加一行 `spawn_job(...)` 即可，
//! 无需改动 `lib.rs`。

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::AppDb;

/// 启动全部后台 job。在 `lib.rs` 的 `setup` 钩子中调用一次。
///
/// 每个 job 在独立的 `tauri::async_runtime` 任务里循环；应用退出时随进程一起结束。
pub fn register_all(app: &AppHandle) {
    spawn_job(app.clone(), "reminder", 20, 60, run_reminder);
    spawn_job(app.clone(), "trash_purge", 20, 60, run_trash_purge);
}

/// 单个 job 的运行签名：返回 Ok 视为成功，Err 携带错误描述。
type Job = fn(&AppHandle) -> Result<(), String>;

/// 启动一个 job：`startup_secs` 秒后开始，每 `base_interval_secs` 秒一轮；
/// 连续失败达到 `BACKOFF_THRESHOLD` 后切换到 `BACKOFF_INTERVAL_SECS`，成功重置。
fn spawn_job(
    app: AppHandle,
    name: &'static str,
    startup_secs: u64,
    base_interval_secs: u64,
    job: Job,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(startup_secs)).await;
        let mut failures: u32 = 0;
        loop {
            let started_at = std::time::Instant::now();
            let result = job(&app);
            let elapsed_ms = started_at.elapsed().as_millis() as u64;
            let (ok, err_msg) = match &result {
                Ok(_) => (true, String::new()),
                Err(e) => {
                    failures += 1;
                    crate::app_log_error!(
                        "[scheduler:{name}] 第 {failures} 次失败（自动忽略）: {e}"
                    );
                    (false, e.clone())
                }
            };
            if ok {
                failures = 0;
            }
            // 暴露运行态供调试控制台观察（不阻塞主流程）
            let _ = app.emit(
                "scheduler-tick",
                serde_json::json!({
                    "job": name,
                    "ok": ok,
                    "failures": failures,
                    "elapsedMs": elapsed_ms,
                    "error": err_msg,
                }),
            );
            // 退避策略：连续失败达到阈值切到长间隔，避免故障期间高频重试
            let interval = if failures >= BACKOFF_THRESHOLD {
                BACKOFF_INTERVAL_SECS
            } else {
                base_interval_secs
            };
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

/// 连续失败次数达到该阈值后切换到退避间隔。
const BACKOFF_THRESHOLD: u32 = 3;
/// 退避间隔（秒）。故障期间降到 5 分钟一次，避免高频重试雪崩。
const BACKOFF_INTERVAL_SECS: u64 = 300;

fn run_reminder(app: &AppHandle) -> Result<(), String> {
    let sent = crate::service::reminder_service::run_once(app).map_err(|e| e.to_string())?;
    if sent > 0 {
        crate::app_log!("[scheduler:reminder] 本轮发出 {sent} 条到期提醒");
    }
    Ok(())
}

fn run_trash_purge(app: &AppHandle) -> Result<(), String> {
    let db = app.state::<AppDb>();
    let purged =
        crate::service::task_service::purge_expired_trash(app, &db).map_err(|e| e.to_string())?;
    if purged > 0 {
        crate::app_log!("[scheduler:trash_purge] 本轮清理 {purged} 条过期回收站记录");
    }
    Ok(())
}
