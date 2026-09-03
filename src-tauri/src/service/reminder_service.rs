//! 任务卡提醒服务
//!
//! 依赖系统通知（tauri-plugin-notification），在应用运行时由 lib.rs 的后台循环
//! 每分钟调用 `run_once`：
//!   1. 读取提醒偏好（task_meta 键 taskcard:reminder_prefs，JSON）；
//!   2. 每日待办提醒（偏好 daily_enabled + daily_time，默认 09:00）：到点汇总
//!      今日待办（逾期 / 今天到期 / 计划今日）发送一条，日级去重；
//!   3. 任务级自定义单点提醒（remind_type='custom' + remind_at）：到点触发一次
//!      后自动清除（PRD 12.2「触发后清除」）；
//!   4. 截止类提醒：全局偏好（before/due/overdue）或任务级指定
//!      （remind_type='due_before'|'due_day'|'overdue'，只按该类别）；
//!      任务级 remind_type='off' 关闭该任务的全部截止提醒；
//!   5. 以 `taskcard:remind:{taskId}:{kind}:{date}` 写入 task_meta 做日级去重；
//!      每次发送追加一条记录到 `taskcard:remind_log`（站内铃铛列表，见 9.11.3）。
//!
//! 全部时间基于本地时区（本地单机应用，见 utils::local_today / local_now）。

use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{Duration, Local, NaiveDate, Timelike};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{task_meta_repo, task_repo};
use crate::service::task_meta_service;
use crate::utils::local_now;

/// 提醒偏好 JSON（与前端 SettingsDrawer 保持一致，camelCase）
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderPrefs {
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub due_before_day: bool,
    #[serde(default = "default_true")]
    pub due_day: bool,
    #[serde(default = "default_true")]
    pub overdue_daily: bool,
    /// 每日待办提醒开关（9.11.1-4；新增字段，旧 JSON 缺省为关）
    #[serde(default)]
    pub daily_enabled: bool,
    /// 每日待办提醒时间 HH:MM（默认 09:00，9.11.3 可配置）
    #[serde(default = "default_daily_time")]
    pub daily_time: String,
}

fn default_true() -> bool {
    true
}

fn default_daily_time() -> String {
    "09:00".into()
}

/// 解析 "HH:MM" 为当天分钟数；非法返回 None
fn parse_hhmm(s: &str) -> Option<i32> {
    let t = s.trim();
    if t.len() != 5 {
        return None;
    }
    let h: i32 = t[..2].parse().ok()?;
    let m: i32 = t[3..].parse().ok()?;
    if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
        return None;
    }
    Some(h * 60 + m)
}

/// 站内提醒记录存储键（task_meta，JSON 数组，最新在前，上限 100 条）
const KEY_REMIND_LOG: &str = "taskcard:remind_log";
const REMIND_LOG_CAP: usize = 100;

/// 追加一条站内提醒记录（前端铃铛中心读取展示；task_id 与 project_id 用于点击定位任务）
fn append_log(
    conn: &rusqlite::Connection,
    kind: &str,
    title: &str,
    task_id: Option<&str>,
    project_id: Option<&str>,
    time: &str,
) -> Result<(), AppError> {
    let existing = task_meta_repo::get(conn, KEY_REMIND_LOG)?;
    let mut logs: Vec<serde_json::Value> = existing
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let entry = serde_json::json!({
        "id": Uuid::new_v4().to_string(),
        "kind": kind,
        "title": title,
        "taskId": task_id,
        "projectId": project_id,
        "time": time,
    });
    logs.insert(0, entry);
    logs.truncate(REMIND_LOG_CAP);
    task_meta_repo::set(
        conn,
        KEY_REMIND_LOG,
        &serde_json::to_string(&logs).unwrap_or_else(|_| "[]".into()),
        time,
    )?;
    Ok(())
}

/// 权限已请求标记（进程内只请求一次）
static PERMISSION_REQUESTED: AtomicBool = AtomicBool::new(false);

/// 单次扫描：返回本次实际发送的系统通知条数
pub fn run_once(app: &AppHandle) -> Result<usize, AppError> {
    let db = app.state::<AppDb>();
    let conn = db.pool.get()?;

    // 1. 偏好：总开关未启用则全部跳过（含任务级自定义）
    let raw_prefs = task_meta_repo::get(&conn, task_meta_service::KEY_REMINDER_PREFS)?;
    let prefs: ReminderPrefs = match raw_prefs {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => ReminderPrefs::default(),
    };
    if !prefs.enabled {
        return Ok(0);
    }

    // 2. 时间基准（本地）
    let now = Local::now();
    let now_str = local_now();
    let now_minutes = now.hour() as i32 * 60 + now.minute() as i32;
    let today = now.format("%Y-%m-%d").to_string();
    let today_date = NaiveDate::parse_from_str(&today, "%Y-%m-%d")
        .map_err(|_| AppError::Business("日期解析失败".into()))?;
    let tomorrow_date = today_date + Duration::days(1);
    // 截止类提醒的 9:00 闸门（custom 单点提醒不受此限）
    let gate_due = now_minutes >= 9 * 60;

    // 3. 一次性取全部未删除任务（所属项目未删）
    let tasks = task_repo::list_all(&conn)?;
    let mut sent = 0usize;

    // 4. 每日待办提醒（按 daily_time，独立闸门；当日已发过则跳过）
    if prefs.daily_enabled {
        if let Some(daily_minutes) = parse_hhmm(&prefs.daily_time) {
            if now_minutes >= daily_minutes {
                let daily_key = format!("taskcard:remind:daily:{}", today);
                if task_meta_repo::get(&conn, &daily_key)?.is_none() {
                    // 今日待办：未完成且（今天到期 | 计划今日 | 已逾期）
                    let mut items: Vec<&crate::models::TaskCard> = tasks
                        .iter()
                        .filter(|t| {
                            t.status != "done"
                                &&                                 (t.planned_today
                                    || t.due_time.as_deref().map_or(false, |d| {
                                        d.len() >= 10 && &d[..10] <= today.as_str()
                                    }))
                        })
                        .collect();
                    if !items.is_empty() {
                        items.sort_by_key(|t| {
                            t.due_time.clone().unwrap_or_else(|| "9999-99-99".into())
                        });
                        let names: Vec<&str> = items.iter().map(|t| t.title.as_str()).collect();
                        let preview = if names.len() <= 6 {
                            names.join("、")
                        } else {
                            format!("{} 等{}项", names[..5].join("、"), names.len())
                        };
                        let body = format!("今日待办 {} 项：{}", names.len(), preview);
                        if send_notification(app, "今日任务待办", &body) {
                            task_meta_repo::set(&conn, &daily_key, "1", &now_str)?;
                            append_log(&conn, "daily", &body, None, None, &now_str)?;
                            sent += 1;
                        }
                    }
                }
            }
        }
    }

    // 5. 遍历任务：自定义单点 + 截止类
    for task in &tasks {
        if task.status == "done" {
            continue;
        }
        let rt = task.remind_type.as_str();
        let due = task.due_time.as_deref();

        // 5.1 任务级「不提醒」：关闭该任务全部截止提醒
        if rt == "off" {
            continue;
        }

        // 5.2 自定义单点提醒：到点触发一次，随即清除任务级提醒
        if rt == "custom" {
            let Some(ra_raw) = task.remind_at.as_deref() else {
                continue;
            };
            let ra = ra_raw.trim();
            if ra.is_empty() || ra > now_str.as_str() {
                continue;
            }
            let key = format!("taskcard:remind:{}:custom:{}", task.id, ra);
            if task_meta_repo::get(&conn, &key)?.is_some() {
                continue;
            }
            let body = format!("「{}」你设定的提醒时间到了", task.title);
            if send_notification(app, "任务提醒", &body) {
                task_meta_repo::set(&conn, &key, "1", &now_str)?;
                // 单次提醒触发后清除任务级字段（PRD 12.2）
                task_repo::update_remind(&conn, &task.id, None, "", &now_str)?;
                append_log(&conn, "custom", &task.title, Some(&task.id), Some(&task.project_id), &now_str)?;
                sent += 1;
            }
            continue;
        }

        // 5.3 截止类（09:00 闸门）：全局偏好或任务级指定类别
        if !gate_due {
            continue;
        }
        let Some(due) = due else { continue };
        if due.len() < 10 {
            continue;
        }
        let Ok(due_date) = NaiveDate::parse_from_str(&due[..10], "%Y-%m-%d") else {
            continue;
        };
        let force: Option<&str> = match rt {
            "due_before" | "due_day" | "overdue" => Some(rt),
            _ => None,
        };

        // 截止时间 HH:mm（展示用，due_time 形如 2026-09-04T09:00）
        let due_hhmm: String = due
            .chars()
            .skip(11)
            .take(5)
            .collect::<String>()
            .trim()
            .to_string();
        let due_md = format_date_cn(&due[..10]);

        // 判定提醒类别
        let kind = if due_date == tomorrow_date
            && (force == Some("due_before") || (force.is_none() && prefs.due_before_day))
        {
            Some("before")
        } else if due_date == today_date
            && (force == Some("due_day") || (force.is_none() && prefs.due_day))
        {
            Some("due")
        } else if due_date < today_date
            && (force == Some("overdue") || (force.is_none() && prefs.overdue_daily))
        {
            Some("overdue")
        } else {
            None
        };
        let Some(kind) = kind else { continue };

        // 日级去重
        let key = format!("taskcard:remind:{}:{}:{}", task.id, kind, today);
        if task_meta_repo::get(&conn, &key)?.is_some() {
            continue;
        }

        // 构造文案
        let (title, body) = match kind {
            "before" => {
                let when = if due_hhmm.len() == 5 {
                    format!("明天 {} 截止", &due_hhmm[..5])
                } else {
                    "明天截止".to_string()
                };
                ("任务即将截止", format!("「{}」{when}", task.title))
            }
            "due" => {
                let when = if due_hhmm.len() == 5 {
                    format!("今天 {} 截止", &due_hhmm[..5])
                } else {
                    "今天截止".to_string()
                };
                ("任务今日截止", format!("「{}」{when}，记得完成", task.title))
            }
            _ => (
                "任务已逾期",
                format!("「{}」原定 {} 截止，请尽快处理", task.title, due_md),
            ),
        };

        if send_notification(app, &title, &body) {
            task_meta_repo::set(&conn, &key, "1", &now_str)?;
            append_log(&conn, kind, &task.title, Some(&task.id), Some(&task.project_id), &now_str)?;
            sent += 1;
        }
    }
    Ok(sent)
}

/// 发送系统通知；权限不可用或失败时返回 false（不中断扫描）
fn send_notification(app: &AppHandle, title: &str, body: &str) -> bool {
    use tauri_plugin_notification::NotificationExt;
    if !PERMISSION_REQUESTED.swap(true, Ordering::SeqCst) {
        if let Err(e) = app.notification().request_permission() {
            crate::app_log!("[提醒] 请求通知权限失败: {e}");
            return false;
        }
    }
    let result = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
    match result {
        Ok(_) => true,
        Err(e) => {
            crate::app_log!("[提醒] 发送通知失败: {e}");
            false
        }
    }
}

/// 手动触发一次（调试 / 设置页「立即检查」），返回发送条数
pub fn check_now(app: &AppHandle) -> Result<usize, AppError> {
    run_once(app)
}

/// 2026-09-04 → 9月4日
fn format_date_cn(date: &str) -> String {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() == 3 {
        let m = parts[1].trim_start_matches('0');
        let d = parts[2].trim_start_matches('0');
        format!("{m}月{d}日")
    } else {
        date.to_string()
    }
}
