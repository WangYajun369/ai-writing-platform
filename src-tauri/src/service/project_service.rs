//! 项目业务服务（任务卡模块）
//!
//! 封装项目的 CRUD / 软删回收 / 实时统计，事务性联动任务（删除项目连带
//! 软删任务；恢复时一并恢复）。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Project, ProjectStats, ProjectView};
use crate::repository::{activity_log_repo, project_repo, task_repo};
use crate::utils::{local_now, now, validate_len};
use tauri::AppHandle;
use uuid::Uuid;

/// 项目名称长度上限（PRD 9.2.1）
pub const MAX_PROJECT_NAME: usize = 50;
/// 项目状态合法取值
const VALID_STATUS: [&str; 3] = ["active", "completed", "archived"];
/// 未指定颜色时的系统分配色板（PRD 9.2.1「默认系统分配」）
const DEFAULT_COLORS: [&str; 8] = [
    "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
];

fn valid_status(s: &str) -> bool {
    VALID_STATUS.contains(&s)
}

/// 空串归一为 None（可空字段清除）
fn normalize_opt(v: Option<String>) -> Option<String> {
    match v {
        None => None,
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
    }
}

/// 校验「开始 ≤ 结束」；两值均非空且开始晚于结束时返回错误
fn check_date_range(start: &Option<String>, end: &Option<String>) -> Result<(), AppError> {
    if let (Some(s), Some(e)) = (start, end) {
        if !s.is_empty() && !e.is_empty() && s > e {
            return Err(AppError::Validation(
                "计划开始日期不能晚于计划结束日期".into(),
            ));
        }
    }
    Ok(())
}

// ── 更新参数 ──

/// 项目部分更新参数：None 表示不修改该字段；空串（经 normalize_opt）表示清空对应可空字段
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectParams {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub status: Option<String>,
    pub plan_start_date: Option<String>,
    pub plan_end_date: Option<String>,
    pub pinned: Option<bool>,
}

// ── 查询 ──

/// 列出项目（可按状态过滤），返回含实时统计的 ProjectView 列表
pub fn list_projects(
    app: &AppHandle,
    db: &AppDb,
    status: Option<String>,
) -> Result<Vec<ProjectView>, AppError> {
    if let Some(ref s) = status {
        if !valid_status(s) {
            return Err(AppError::Validation(format!("无效的项目状态: {s}")));
        }
    }
    let now_local = local_now();
    emit_sql_log(
        app,
        "SELECT",
        "projects",
        status.as_deref().unwrap_or("all"),
        file!(),
        line!(),
    );
    let conn = db.pool.get()?;
    let projects = project_repo::list(&conn, status.as_deref())?;
    // 一次 GROUP BY 聚合取全量统计，避免逐项目查询的 N+1
    let stats_map = task_repo::project_counts_all(&conn, &now_local)?;
    let mut views = Vec::with_capacity(projects.len());
    for p in projects {
        let (total, todo, doing, done, overdue) =
            stats_map.get(&p.id).copied().unwrap_or_default();
        views.push(ProjectView {
            stats: ProjectStats {
                total,
                todo,
                doing,
                done,
                overdue,
            },
            project: p,
        });
    }
    Ok(views)
}

/// 根据 ID 获取单个项目（含统计）
pub fn get_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<ProjectView, AppError> {
    let now_local = local_now();
    emit_sql_log(
        app,
        "SELECT",
        "projects",
        &format!("id={id}"),
        file!(),
        line!(),
    );
    let conn = db.pool.get()?;
    let project = project_repo::find_active(&conn, id)
        .map_err(|_| AppError::NotFound("未找到该项目或项目已删除".into()))?;
    let stats = fetch_stats(&conn, &project.id, &now_local)?;
    Ok(ProjectView { project, stats })
}

/// 查询项目任务实时统计
fn fetch_stats(
    conn: &rusqlite::Connection,
    project_id: &str,
    now_local: &str,
) -> Result<ProjectStats, AppError> {
    let (total, todo, doing, done, overdue) =
        task_repo::project_counts(conn, project_id, now_local)?;
    Ok(ProjectStats {
        total,
        todo,
        doing,
        done,
        overdue,
    })
}

// ── 写入 ──

/// 创建项目；未指定颜色时按现有项目数轮询色板自动分配
#[allow(clippy::too_many_arguments)]
pub fn create_project(
    app: &AppHandle,
    db: &AppDb,
    name: &str,
    description: &str,
    color: &str,
    icon: &str,
    status: &str,
    plan_start_date: Option<String>,
    plan_end_date: Option<String>,
    pinned: bool,
) -> Result<Project, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("项目名称不能为空".into()));
    }
    validate_len("项目名称", name, MAX_PROJECT_NAME)?;
    if !valid_status(status) {
        return Err(AppError::Validation(format!("无效的项目状态: {status}")));
    }
    let start = normalize_opt(plan_start_date);
    let end = normalize_opt(plan_end_date);
    check_date_range(&start, &end)?;

    let id = Uuid::new_v4().to_string();
    let ts = now();

    let conn = db.pool.get()?;

    // 默认颜色：按现有项目总数轮询色板
    let count = project_repo::count_active(&conn)?;
    let color = if color.trim().is_empty() {
        DEFAULT_COLORS[(count as usize) % DEFAULT_COLORS.len()].to_string()
    } else {
        color.trim().to_string()
    };

    emit_sql_log(
        app,
        "INSERT",
        "projects",
        &format!("id={id}, name={name}"),
        file!(),
        line!(),
    );
    project_repo::insert(
        &conn,
        &id,
        name,
        description,
        &color,
        icon,
        status,
        start.as_deref(),
        end.as_deref(),
        pinned as i64,
        &ts,
    )?;
    Ok(project_repo::find_by_id(&conn, &id)?)
}

/// 更新项目字段（部分更新）；空串的可空字段会清空
pub fn update_project(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    params: UpdateProjectParams,
) -> Result<Project, AppError> {
    // 前置校验
    if let Some(ref name) = params.name {
        if name.trim().is_empty() {
            return Err(AppError::Validation("项目名称不能为空".into()));
        }
        validate_len("项目名称", name.trim(), MAX_PROJECT_NAME)?;
    }
    if let Some(ref s) = params.status {
        if !valid_status(s) {
            return Err(AppError::Validation(format!("无效的项目状态: {s}")));
        }
    }
    let has_start = params.plan_start_date.is_some();
    let has_end = params.plan_end_date.is_some();
    let new_start = normalize_opt(params.plan_start_date);
    let new_end = normalize_opt(params.plan_end_date);
    // 日期范围校验以「更新后的最终值」为准：未传字段回退到现有值，
    // 只校验两个新值会在部分更新时绕过校验（如只把开始日期改到结束日期之后）。
    let conn = db.pool.get()?;
    let current = project_repo::find_active(&conn, id)
        .map_err(|_| AppError::NotFound("未找到该项目或项目已删除".into()))?;
    let eff_start = if has_start {
        new_start.clone()
    } else {
        current.plan_start_date.clone()
    };
    let eff_end = if has_end {
        new_end.clone()
    } else {
        current.plan_end_date.clone()
    };
    check_date_range(&eff_start, &eff_end)?;

    // 动态 UPDATE 由统一的 DynamicUpdate 构建器生成（列名均为代码字面量）
    let mut upd = crate::utils::DynamicUpdate::new("projects");

    if let Some(v) = params.name {
        upd.push("name", v.trim().to_string());
    }
    if let Some(v) = params.description {
        upd.push("description", v);
    }
    if let Some(v) = params.color {
        upd.push("color", v.trim().to_string());
    }
    if let Some(v) = params.icon {
        upd.push("icon", v);
    }
    if let Some(v) = params.status {
        upd.push("status", v);
    }
    if has_start {
        upd.push("plan_start_date", new_start);
    }
    if has_end {
        upd.push("plan_end_date", new_end);
    }
    if let Some(v) = params.pinned {
        upd.push("pinned", if v { 1 } else { 0 });
    }

    let ts = now();
    let Some((sql, values)) = upd.build_guarded(id, &ts, "AND deleted_at IS NULL") else {
        return Err(AppError::Validation("没有需要更新的字段".into()));
    };

    emit_sql_log(
        app,
        "UPDATE",
        "projects",
        &format!("id={id}"),
        file!(),
        line!(),
    );
    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        values.iter().map(|p| p.as_ref()).collect();
    let affected = conn.execute(&sql, params_refs.as_slice())?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该项目或项目已删除".into()));
    }
    Ok(project_repo::find_by_id(&conn, id)?)
}

/// 软删除项目（连同其下全部任务一并软删除，事务保证）
pub fn delete_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口。
    let pooled = db.pool.get()?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    let ts = now();
    uow.audit(
        "UPDATE",
        "projects",
        format!("id={id}, soft delete (+tasks)"),
        file!(),
        line!(),
    );
    let affected = project_repo::soft_delete(uow.conn(), id, &ts)?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该项目或项目已删除".into()));
    }
    let task_count = project_repo::soft_delete_tasks(uow.conn(), id, &ts)?;
    crate::app_log!("[TaskCards] 删除项目 {id} 连带软删任务 {task_count} 条");
    uow.commit()?;
    Ok(())
}

/// 恢复项目（仅连带恢复「随项目一并删除」的任务，事务保证）
///
/// 删除项目前已单独进回收站的任务（deleted_at 与项目不同）保持原状，
/// 由用户在任务回收站自行决定是否恢复。
pub fn restore_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口。
    let pooled = db.pool.get()?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    // restore 前置读取项目的删除时间戳（restore 后 deleted_at 置空），
    // 用它精确匹配「随项目一并删除」的任务子集
    let project_deleted_at = project_repo::find_by_id(uow.conn(), id)?.deleted_at;
    let ts = now();
    uow.audit(
        "UPDATE",
        "projects",
        format!("id={id}, restore (+tasks)"),
        file!(),
        line!(),
    );
    let affected = project_repo::restore(uow.conn(), id, &ts)?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该项目或该项目不在回收站".into()));
    }
    if let Some(ref pd) = project_deleted_at {
        let _ = project_repo::restore_tasks(uow.conn(), id, pd, &ts)?;
    }
    uow.commit()?;
    Ok(())
}

/// 彻底删除项目（仅限回收站中的项目；CASCADE 删除其下任务与任务-标签关联，
/// 同事务显式清理操作日志）
pub fn hard_delete_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口。
    let pooled = db.pool.get()?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    uow.audit(
        "DELETE",
        "projects",
        format!("id={id}, hard delete"),
        file!(),
        line!(),
    );
    let affected = project_repo::hard_delete(uow.conn(), id)?;
    if affected == 0 {
        return Err(AppError::Business("仅回收站中的项目可彻底删除".into()));
    }
    // task_activity_logs 无外键，硬删后需显式清理日志避免孤儿化
    activity_log_repo::delete_by_project(uow.conn(), id)?;
    uow.commit()?;
    Ok(())
}

/// 列出回收站中的项目
pub fn list_deleted_projects(app: &AppHandle, db: &AppDb) -> Result<Vec<Project>, AppError> {
    emit_sql_log(
        app,
        "SELECT",
        "projects",
        "deleted_at IS NOT NULL",
        file!(),
        line!(),
    );
    let conn = db.pool.get()?;
    Ok(project_repo::list_deleted(&conn)?)
}

/// 清空项目回收站（同事务清理已删项目的操作日志）
pub fn clear_project_trash(app: &AppHandle, db: &AppDb) -> Result<u32, AppError> {
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口。
    let pooled = db.pool.get()?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    uow.audit(
        "DELETE",
        "projects",
        "clear trash".to_string(),
        file!(),
        line!(),
    );
    let count = project_repo::count_deleted(uow.conn())?;
    // task_activity_logs 无外键，先清理已删项目的日志再删项目
    activity_log_repo::delete_logs_of_deleted_projects(uow.conn())?;
    project_repo::clear_trash(uow.conn())?;
    uow.commit()?;
    Ok(count)
}
