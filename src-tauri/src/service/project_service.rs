//! 项目业务服务（任务卡模块）
//!
//! 封装项目的 CRUD / 软删回收 / 实时统计，事务性联动任务（删除项目连带
//! 软删任务；恢复时一并恢复）。

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Project, ProjectStats, ProjectView};
use crate::commands::window::emit_sql_log;
use crate::utils::{now, local_now, validate_len};
use crate::repository::{project_repo, task_repo};

/// 项目名称长度上限（PRD 9.2.1）
pub const MAX_PROJECT_NAME: usize = 50;
/// 项目状态合法取值
const VALID_STATUS: [&str; 3] = ["active", "completed", "archived"];
/// 未指定颜色时的系统分配色板（PRD 9.2.1「默认系统分配」）
const DEFAULT_COLORS: [&str; 8] = [
    "#6366f1", "#10b981", "#f59e0b", "#ef4444",
    "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
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
            if t.is_empty() { None } else { Some(t.to_string()) }
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
    let mut views = Vec::with_capacity(projects.len());
    for p in projects {
        views.push(ProjectView {
            stats: fetch_stats(&conn, &p.id, &now_local)?,
            project: p,
        });
    }
    Ok(views)
}

/// 根据 ID 获取单个项目（含统计）
pub fn get_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<ProjectView, AppError> {
    let now_local = local_now();
    emit_sql_log(app, "SELECT", "projects", &format!("id={id}"), file!(), line!());
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
    Ok(ProjectStats { total, todo, doing, done, overdue })
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
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let color = if color.trim().is_empty() {
        DEFAULT_COLORS[(count as usize) % DEFAULT_COLORS.len()].to_string()
    } else {
        color.trim().to_string()
    };

    emit_sql_log(app, "INSERT", "projects", &format!("id={id}, name={name}"), file!(), line!());
    project_repo::insert(
        &conn, &id, name, description, &color, icon, status,
        start.as_deref(), end.as_deref(), pinned as i64, &ts,
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
    check_date_range(&new_start, &new_end)?;

    let mut set_clauses: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    // 局部宏：拼接 `col=?n` 并收集参数值
    macro_rules! push_set {
        ($col:expr, $val:expr) => {{
            set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
            param_values.push(Box::new($val) as Box<dyn rusqlite::types::ToSql>);
        }};
    }

    if let Some(v) = params.name {
        push_set!("name", v.trim().to_string());
    }
    if let Some(v) = params.description {
        push_set!("description", v);
    }
    if let Some(v) = params.color {
        push_set!("color", v.trim().to_string());
    }
    if let Some(v) = params.icon {
        push_set!("icon", v);
    }
    if let Some(v) = params.status {
        push_set!("status", v);
    }
    if has_start {
        push_set!("plan_start_date", new_start);
    }
    if has_end {
        push_set!("plan_end_date", new_end);
    }
    if let Some(v) = params.pinned {
        push_set!("pinned", if v { 1 } else { 0 });
    }

    if set_clauses.is_empty() {
        return Err(AppError::Validation("没有需要更新的字段".into()));
    }
    let ts = now();
    push_set!("updated_at", ts.clone());
    let sql = format!(
        "UPDATE projects SET {} WHERE id=?{} AND deleted_at IS NULL",
        set_clauses.join(", "),
        set_clauses.len() + 1
    );
    param_values.push(Box::new(id.to_string()));

    emit_sql_log(app, "UPDATE", "projects", &format!("id={id}"), file!(), line!());
    let conn = db.pool.get()?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    let affected = conn.execute(&sql, params_refs.as_slice())?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该项目或项目已删除".into()));
    }
    Ok(project_repo::find_by_id(&conn, id)?)
}

/// 软删除项目（连同其下全部任务一并软删除，事务保证）
pub fn delete_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "projects", &format!("id={id}, soft delete (+tasks)"), file!(), line!());
    let affected = project_repo::soft_delete(&tx, id, &ts)?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该项目或项目已删除".into()));
    }
    let task_count = project_repo::soft_delete_tasks(&tx, id, &ts)?;
    crate::app_log!("[TaskCards] 删除项目 {id} 连带软删任务 {task_count} 条");
    tx.commit()?;
    Ok(())
}

/// 恢复项目（连同其下任务一并恢复，事务保证）
pub fn restore_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "projects", &format!("id={id}, restore (+tasks)"), file!(), line!());
    let affected = project_repo::restore(&tx, id, &ts)?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该项目或该项目不在回收站".into()));
    }
    let _ = project_repo::restore_tasks(&tx, id, &ts)?;
    tx.commit()?;
    Ok(())
}

/// 彻底删除项目（CASCADE 删除其下任务与任务-标签关联）
pub fn hard_delete_project(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "DELETE", "projects", &format!("id={id}, hard delete"), file!(), line!());
    project_repo::hard_delete(&conn, id)?;
    Ok(())
}

/// 列出回收站中的项目
pub fn list_deleted_projects(app: &AppHandle, db: &AppDb) -> Result<Vec<Project>, AppError> {
    emit_sql_log(app, "SELECT", "projects", "deleted_at IS NOT NULL", file!(), line!());
    let conn = db.pool.get()?;
    Ok(project_repo::list_deleted(&conn)?)
}

/// 清空项目回收站
pub fn clear_project_trash(app: &AppHandle, db: &AppDb) -> Result<u32, AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "DELETE", "projects", "clear trash", file!(), line!());
    let count = project_repo::count_deleted(&conn)?;
    project_repo::clear_trash(&conn)?;
    Ok(count)
}
