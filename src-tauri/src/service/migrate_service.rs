//! 个人日程 → 任务卡迁移服务（PRD 第 13 节）
//!
//! 幂等迁移：读取全部未删除日程，写入默认项目「个人事务」下；
//! 完成标记在 task_meta 中，重复执行直接返回 already=true。

use tauri::AppHandle;
use uuid::Uuid;
use rusqlite::OptionalExtension;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::MigrateResult;
use crate::commands::window::emit_sql_log;
use crate::utils::{now, local_now, local_today};
use crate::repository::{project_repo, task_repo, schedule_repo, task_meta_repo};

/// 迁移幂等标记 key
pub const MIGRATION_META_KEY: &str = "taskcard:migrate_schedules";
/// 默认项目名（固定「个人事务」）
pub const DEFAULT_PROJECT_NAME: &str = "个人事务";
/// 默认项目主题色
const DEFAULT_PROJECT_COLOR: &str = "#6366f1";
/// 任务标题长度上限（截断超长日程）
const TITLE_MAX: usize = 100;

fn truncate_title(content: &str) -> String {
    let t = content.trim();
    if t.is_empty() {
        return "（未命名日程）".to_string();
    }
    let count = t.chars().count();
    if count > TITLE_MAX {
        let cut: String = t.chars().take(TITLE_MAX).collect();
        format!("{cut}…")
    } else {
        t.to_string()
    }
}

/// 执行迁移（幂等）
pub fn migrate_schedules(app: &AppHandle, db: &AppDb) -> Result<MigrateResult, AppError> {
    let today = local_today();
    let now_local = local_now();
    let ts = now();
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;

    let already = task_meta_repo::get(&tx, MIGRATION_META_KEY)?.as_deref() == Some("1");

    // 默认项目：优先复用「个人事务」，否则新建
    let project_id: Option<String> = tx
        .query_row(
            "SELECT id FROM projects WHERE name=?1 AND deleted_at IS NULL LIMIT 1",
            rusqlite::params![DEFAULT_PROJECT_NAME],
            |r| r.get(0),
        )
        .optional()?;

    if already {
        return Ok(MigrateResult {
            migrated: 0,
            completed: 0,
            project_id: project_id.unwrap_or_default(),
            already: true,
        });
    }

    let pid = match project_id {
        Some(p) => p,
        None => {
            let pid = Uuid::new_v4().to_string();
            project_repo::insert(
                &tx,
                &pid,
                DEFAULT_PROJECT_NAME,
                "",
                DEFAULT_PROJECT_COLOR,
                "",
                "active",
                None,
                None,
                0,
                &ts,
            )?;
            pid
        }
    };

    let schedules = schedule_repo::list_all(&tx)?;
    let mut migrated: i64 = 0;
    let mut completed: i64 = 0;
    for s in &schedules {
        let id = Uuid::new_v4().to_string();
        let status = if s.done { "done" } else { "todo" };
        let due = format!("{}T23:59:59", s.schedule_date);
        let planned = if s.schedule_date == today { 1 } else { 0 };
        let sort_order = task_repo::next_sort_order(&tx, &pid, status)?;
        task_repo::insert(
            &tx, &id, &pid, &truncate_title(&s.content), "", status, "medium",
            None, Some(&due), planned, "", sort_order, &ts,
        )?;
        if s.done {
            task_repo::update_status(&tx, &id, "done", Some(now_local.as_str()), &ts)?;
        }
        migrated += 1;
        if s.done {
            completed += 1;
        }
    }
    emit_sql_log(
        app,
        "INSERT",
        "tasks",
        &format!("migrate {migrated} schedules -> project {pid}"),
        file!(),
        line!(),
    );
    task_meta_repo::set(&tx, MIGRATION_META_KEY, "1", &ts)?;
    tx.commit()?;

    crate::app_log!("[TaskCards] 日程迁移完成：{migrated} 条（已完成 {completed} 条）");
    Ok(MigrateResult {
        migrated,
        completed,
        project_id: pid,
        already: false,
    })
}
