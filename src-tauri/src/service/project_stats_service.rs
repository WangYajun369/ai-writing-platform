//! 项目统计服务（任务卡 P2 周报）
//!
//! 依据操作日志（task_activity_logs）按自然周（周一为一周开始，本地时区）统计
//! 项目的「新增任务」与「完成任务」数量，供项目周报可视化。动作日志在
//! 发生时冗余记录了当时所属项目，跨项目迁移不影响统计口径。
//!
//! 时区口径：日志 created_at 为 UTC RFC3339 文本；统计时先把区间起点换算为
//! UTC 做数据库过滤，再在 Rust 侧逐条换算为本地日期按「本地周一」分桶，
//! 避免跨时区用户（如 UTC+8 周一 08:00 前）的周归属错位。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::ProjectWeeklyStat;
use crate::repository::{activity_log_repo, project_repo};
use chrono::{DateTime, Datelike, Duration, Local, Utc};
use std::collections::HashMap;
use tauri::AppHandle;

/// 查询某项目最近 N 周（含本周）的新增/完成统计，按周开始日期升序返回
pub fn project_weekly_stats(
    app: &AppHandle,
    db: &AppDb,
    project_id: &str,
    weeks: u32,
) -> Result<Vec<ProjectWeeklyStat>, AppError> {
    let weeks = weeks.clamp(4, 26);
    let conn = db.pool.get()?;
    project_repo::find_active(&conn, project_id)
        .map_err(|_| AppError::NotFound("未找到该项目或项目已删除".into()))?;

    // 本周周一（本地时区）与统计起点（最早一周的周一）
    let today = Local::now().date_naive();
    let offset = today.weekday().num_days_from_monday();
    let this_monday = today - Duration::days(offset as i64);
    let first_monday = this_monday - Duration::days(((weeks - 1) * 7) as i64);
    // 本地零点 → UTC RFC3339（与日志 created_at 同一时钟域比较）
    let from_utc = local_midnight_utc(first_monday);

    emit_sql_log(
        app,
        "SELECT",
        "task_activity_logs",
        &format!("weekly project_id={project_id}"),
        file!(),
        line!(),
    );

    // 单条查询取回区间日志，Rust 侧按本地周分桶（替代逐周串行 COUNT 的 2N 查询）
    let rows = activity_log_repo::list_weekly_actions_since(&conn, project_id, &from_utc)?;
    let buckets = bucket_by_local_week(rows);

    // (0..weeks).rev()：从最远一周写到本周，保证返回数组按周升序（oldest → newest）
    let mut stats = Vec::with_capacity(weeks as usize);
    for w in (0..weeks).rev() {
        let start = this_monday - Duration::days((w * 7) as i64);
        let (created, completed) = buckets.get(&start).copied().unwrap_or((0, 0));
        // 未来周（数据为空）不做特殊处理，前端会正确显示 0
        stats.push(ProjectWeeklyStat {
            week_start: start.format("%Y-%m-%d").to_string(),
            created,
            completed,
        });
    }
    Ok(stats)
}

/// 本地日期零点 → UTC RFC3339 文本（DST 歧义取最早时刻；兜底退化为 UTC 零点）
fn local_midnight_utc(d: chrono::NaiveDate) -> String {
    let Some(dt) = d.and_hms_opt(0, 0, 0) else {
        return String::new();
    };
    dt.and_local_timezone(Local)
        .earliest()
        .map(|ld| ld.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|| dt.and_utc().to_rfc3339())
}

/// 将 (action, created_at RFC3339) 日志行按「本地周一」分桶为 (created, completed)。
/// 解析失败的行跳过；action 只认 task.created / task.completed 全名
/// （v1.8.0 修复：曾以 'completed' 计数导致周报恒为 0）。
fn bucket_by_local_week(rows: Vec<(String, String)>) -> HashMap<chrono::NaiveDate, (i64, i64)> {
    let mut buckets: HashMap<chrono::NaiveDate, (i64, i64)> = HashMap::new();
    for (action, created_at) in rows {
        let Ok(ts) = DateTime::parse_from_rfc3339(&created_at) else {
            continue;
        };
        let local_date = ts.with_timezone(&Local).date_naive();
        let monday =
            local_date - Duration::days(local_date.weekday().num_days_from_monday() as i64);
        let entry = buckets.entry(monday).or_default();
        match action.as_str() {
            "task.created" => entry.0 += 1,
            "task.completed" => entry.1 += 1,
            _ => {}
        }
    }
    buckets
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本地零点转 UTC：UTC+8 时区下本地周一 00:00 应对应周日 16:00 UTC
    /// （用固定偏移模拟，不依赖测试机时区）
    #[test]
    fn local_midnight_converts_by_offset() {
        // 直接验证换算逻辑：本地 2026-09-28 00:00 +08:00 → 2026-09-27T16:00:00Z
        let local = chrono::NaiveDate::from_ymd_opt(2026, 9, 28)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let fixed = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let utc = local
            .and_local_timezone(fixed)
            .earliest()
            .unwrap()
            .with_timezone(&Utc)
            .to_rfc3339();
        assert_eq!(utc, "2026-09-27T16:00:00+00:00");
    }

    /// 分桶：同一条 UTC 日志在 UTC+8 下可能属于下一周（周日 16:00 UTC = 本地周一 00:00）
    #[test]
    fn utc_log_buckets_to_local_week() {
        // 2026-09-27 是周日；UTC 16:30 在 UTC+8 下已是 2026-09-28（周一）00:30
        let ts = DateTime::parse_from_rfc3339("2026-09-27T16:30:00+00:00").unwrap();
        let fixed = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let local_date = ts.with_timezone(&fixed).date_naive();
        assert_eq!(local_date, chrono::NaiveDate::from_ymd_opt(2026, 9, 28).unwrap());
        let monday =
            local_date - Duration::days(local_date.weekday().num_days_from_monday() as i64);
        assert_eq!(monday, chrono::NaiveDate::from_ymd_opt(2026, 9, 28).unwrap());
    }

    // ── 周报统计集成测试（repo 查询 + 分桶，一次锁定 P1-1 / P1-2 两个历史 bug）──

    /// 最小 task_activity_logs 表（与 db/mod.rs DDL 等价）
    fn test_log_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE task_activity_logs (
                id         TEXT PRIMARY KEY,
                task_id    TEXT,
                project_id TEXT,
                action     TEXT NOT NULL,
                summary    TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    /// P1-1 回归：动作名必须全量匹配 task.completed——旧 bug 里的裸 'completed'
    /// 以及其他动作（task.updated 等）都不得计入；正确动作名正常计数。
    /// P1-2 回归：UTC 日志按测试机本地时区换算后落入正确的周（周三正午 UTC
    /// 在任何 ±12h 时区下都仍是周三，周一恒为 2026-09-21，断言与时区无关）。
    #[test]
    fn weekly_actions_filter_and_bucket_integration() {
        use crate::repository::activity_log_repo;

        let conn = test_log_db();
        // 2026-09-23 是周三；正午 UTC 在任意民用时区（UTC±12 内）仍是 2026-09-23
        let wed_utc = "2026-09-23T12:00:00+00:00";
        activity_log_repo::insert(&conn, "1", Some("t1"), Some("p1"), "task.created", "", wed_utc).unwrap();
        activity_log_repo::insert(&conn, "2", Some("t2"), Some("p1"), "task.completed", "", wed_utc).unwrap();
        activity_log_repo::insert(&conn, "3", Some("t3"), Some("p1"), "task.completed", "", wed_utc).unwrap();
        // 历史遗留的错误动作名（v1.8.0 前曾按 'completed' 计数，现在必须排除）
        activity_log_repo::insert(&conn, "4", Some("t4"), Some("p1"), "completed", "", wed_utc).unwrap();
        // 无关动作与其他项目，均不得混入
        activity_log_repo::insert(&conn, "5", Some("t5"), Some("p1"), "task.updated", "", wed_utc).unwrap();
        activity_log_repo::insert(&conn, "6", Some("t6"), Some("p2"), "task.completed", "", wed_utc).unwrap();
        // 区间之外的旧日志不得计入
        activity_log_repo::insert(&conn, "7", Some("t7"), Some("p1"), "task.completed", "", "2020-01-01T00:00:00+00:00").unwrap();

        let rows = activity_log_repo::list_weekly_actions_since(&conn, "p1", "2026-09-21T00:00:00+00:00").unwrap();
        assert_eq!(rows.len(), 3, "只应取回 p1 的 created×1 + completed×2，实际 {rows:?}");

        let buckets = bucket_by_local_week(rows);
        let monday = chrono::NaiveDate::from_ymd_opt(2026, 9, 21).unwrap();
        let (created, completed) = buckets.get(&monday).copied().unwrap_or((0, 0));
        assert_eq!(created, 1, "task.created 应计 1");
        assert_eq!(completed, 2, "task.completed 应计 2，裸 'completed' 不得计入");
    }

    /// 分桶对非法时间戳静默跳过（不 panic、不影响其余行）
    #[test]
    fn bucket_skips_invalid_timestamp() {
        let rows = vec![
            ("task.created".to_string(), "not-a-timestamp".to_string()),
            ("task.completed".to_string(), "2026-09-23T12:00:00+00:00".to_string()),
        ];
        let buckets = bucket_by_local_week(rows);
        let monday = chrono::NaiveDate::from_ymd_opt(2026, 9, 21).unwrap();
        assert_eq!(buckets.get(&monday).copied().unwrap_or((0, 0)), (0, 1));
    }
}
