//! 项目统计服务（任务卡 P2 周报）
//!
//! 依据操作日志（task_activity_logs）按自然周（周一为一周开始）统计
//! 项目的「新增任务」与「完成任务」数量，供项目周报可视化。动作日志在
//! 发生时冗余记录了当时所属项目，跨项目迁移不影响统计口径。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::ProjectWeeklyStat;
use crate::repository::{activity_log_repo, project_repo};
use chrono::{Datelike, Duration, Local};
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

    // 本周周一（本地时区）
    let today = Local::now().date_naive();
    let offset = today.weekday().num_days_from_monday();
    let this_monday = today - Duration::days(offset as i64);

    emit_sql_log(
        app,
        "SELECT",
        "task_activity_logs",
        &format!("weekly project_id={project_id}"),
        file!(),
        line!(),
    );
    let mut stats = Vec::with_capacity(weeks as usize);
    for w in (0..weeks).rev() {
        let start = this_monday - Duration::days((w * 7) as i64);
        let end = start + Duration::days(7);
        let from = start.format("%Y-%m-%dT00:00:00").to_string();
        let to = end.format("%Y-%m-%dT00:00:00").to_string();
        // 未来周（数据为空）不做特殊处理，前端会正确显示 0
        stats.push(ProjectWeeklyStat {
            week_start: start.format("%Y-%m-%d").to_string(),
            created: activity_log_repo::count_created_between(&conn, project_id, &from, &to)?,
            completed: activity_log_repo::count_completed_between(&conn, project_id, &from, &to)?,
        });
    }
    Ok(stats)
}
