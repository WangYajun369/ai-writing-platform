//! 任务模板业务服务（任务卡 P2）
//!
//! 模板 = 「一键套用创建相似任务」：预设标题 / 描述 / 优先级 / 备注 / 标签 /
//! 截止偏移天数 / 子任务标题清单。套用时可临时指定所属项目与截止时间。

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{TaskCard, TaskTemplate};
use crate::commands::window::emit_sql_log;
use crate::utils::{now, local_today, validate_len};
use crate::repository::{project_repo, subtask_repo, task_repo, template_repo};

/// 模板名长度上限
pub const MAX_TEMPLATE_NAME: usize = 40;
/// 模板任务标题长度上限
pub const MAX_TEMPLATE_TITLE: usize = 100;

fn default_priority() -> String {
    "medium".into()
}

/// 创建模板参数（serde camelCase 由 Tauri 自动转换）
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemplateParams {
    pub name: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub due_offset_days: i64,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub subtask_titles: Vec<String>,
}

/// 更新模板参数（全可选，None 表示不改动）
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTemplateParams {
    pub name: Option<String>,
    pub project_id: Option<Option<String>>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<String>,
    pub note: Option<String>,
    pub due_offset_days: Option<i64>,
    pub tag_ids: Option<Vec<String>>,
    pub subtask_titles: Option<Vec<String>>,
}

fn ensure_valid_priority(p: &str) -> Result<(), AppError> {
    if !["high", "medium", "low"].contains(&p) {
        return Err(AppError::Validation(format!("无效的优先级: {p}")));
    }
    Ok(())
}

/// 列出全部模板
pub fn list_templates(app: &AppHandle, db: &AppDb) -> Result<Vec<TaskTemplate>, AppError> {
    emit_sql_log(app, "SELECT", "task_templates", "all", file!(), line!());
    let conn = db.pool.get()?;
    Ok(template_repo::list_all(&conn)?)
}

/// 创建模板
pub fn create_template(
    app: &AppHandle,
    db: &AppDb,
    params: CreateTemplateParams,
) -> Result<TaskTemplate, AppError> {
    let name = params.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("模板名称不能为空".into()));
    }
    validate_len("模板名称", name, MAX_TEMPLATE_NAME)?;
    let title = params.title.trim();
    if !title.is_empty() {
        validate_len("模板任务标题", title, MAX_TEMPLATE_TITLE)?;
    }
    ensure_valid_priority(&params.priority)?;
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let conn = db.pool.get()?;
    emit_sql_log(app, "INSERT", "task_templates", &format!("id={id}, name={name}"), file!(), line!());
    template_repo::insert(
        &conn, &id, name, params.project_id.as_deref(), title, &params.description,
        &params.priority, &params.note, params.due_offset_days.max(0),
        &params.tag_ids, &params.subtask_titles, &ts,
    )?;
    template_repo::find_by_id(&conn, &id).map_err(AppError::from)
}

/// 更新模板
pub fn update_template(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    params: UpdateTemplateParams,
) -> Result<TaskTemplate, AppError> {
    if let Some(ref name) = params.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("模板名称不能为空".into()));
        }
        validate_len("模板名称", name, MAX_TEMPLATE_NAME)?;
    }
    if let Some(ref p) = params.priority {
        ensure_valid_priority(p)?;
    }
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "task_templates", &format!("id={id}"), file!(), line!());
    let n = template_repo::update(
        &conn, id,
        params.name.as_deref().map(str::trim),
        params.project_id.as_ref().map(|o| o.as_deref()),
        params.title.as_deref().map(str::trim),
        params.description.as_deref(),
        params.priority.as_deref(),
        params.note.as_deref(),
        params.due_offset_days,
        params.tag_ids.as_deref(),
        params.subtask_titles.as_deref(),
        &ts,
    )?;
    if n == 0 {
        return Err(AppError::NotFound("未找到该模板".into()));
    }
    template_repo::find_by_id(&conn, id).map_err(AppError::from)
}

/// 删除模板
pub fn delete_template(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "DELETE", "task_templates", &format!("id={id}"), file!(), line!());
    if template_repo::delete(&conn, id)? == 0 {
        return Err(AppError::NotFound("未找到该模板".into()));
    }
    Ok(())
}

/// 一键套用模板创建任务（PRD 6.3-2）：
/// 标题 / 描述 / 优先级 / 备注 / 标签复制；子任务标题批量生成为未完成清单；
/// 截止时间优先取显式传入 due_time，其次按模板 due_offset_days 推算（当天 09:00）。
pub fn create_task_from_template(
    app: &AppHandle,
    db: &AppDb,
    template_id: &str,
    project_id: &str,
    due_time: Option<String>,
) -> Result<TaskCard, AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let tmpl = template_repo::find_by_id(&tx, template_id)
        .map_err(|_| AppError::NotFound("未找到该模板".into()))?;
    project_repo::find_active(&tx, project_id)
        .map_err(|_| AppError::NotFound("所属项目不存在或已删除".into()))?;

    // 截止：显式传参 > 偏移天数推算
    let due = if let Some(d) = due_time.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d.trim().to_string())
    } else if tmpl.due_offset_days > 0 {
        let day = chrono::NaiveDate::parse_from_str(&local_today(), "%Y-%m-%d")
            .map(|d| d + chrono::Duration::days(tmpl.due_offset_days))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|_| local_today());
        Some(format!("{day}T09:00:00"))
    } else {
        None
    };

    let id = Uuid::new_v4().to_string();
    let ts = now();
    let title = if tmpl.title.trim().is_empty() {
        tmpl.name.as_str()
    } else {
        tmpl.title.trim()
    };
    let sort_order = task_repo::next_sort_order(&tx, project_id, "todo")?;
    emit_sql_log(
        app,
        "INSERT",
        "tasks",
        &format!("id={id}, from template {}", tmpl.id),
        file!(),
        line!(),
    );
    task_repo::insert(
        &tx, &id, project_id, None, title, &tmpl.description, "todo", &tmpl.priority,
        None, due.as_deref(), 0, &tmpl.note, sort_order, &ts,
    )?;
    // 标签（只关联仍存在的标签）
    template_repo::attach_existing_tags(&tx, &id, &tmpl.tag_ids, &ts)?;
    // 子任务清单
    for (i, st) in tmpl.subtask_titles.iter().enumerate() {
        let st = st.trim();
        if st.is_empty() {
            continue;
        }
        let sid = Uuid::new_v4().to_string();
        subtask_repo::insert(&tx, &sid, &id, st, i as i64, &ts)?;
    }
    tx.commit()?;
    let mut task = task_repo::find_active(&conn, &id)
        .map_err(|_| AppError::NotFound("任务创建失败".into()))?;
    let ids = vec![task.id.clone()];
    if let Ok(pairs) = task_repo::tags_of_tasks(&conn, &ids) {
        task.tags = pairs.into_iter().map(|(_, t)| t).collect();
    }
    Ok(task)
}
