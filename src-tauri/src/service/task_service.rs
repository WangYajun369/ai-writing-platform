//! 任务业务服务（任务卡模块）
//!
//! 任务三态（todo / doing / done）流转、完成/重开时间记录、看板拖拽重排、
//! 标签聚合、今日概览与「计划今日」滚动清理。

use std::collections::HashMap;
use tauri::AppHandle;
use uuid::Uuid;
use serde::Serialize;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Tag, TaskCard, TodayOverview};
use crate::commands::window::emit_sql_log;
use crate::utils::{now, local_now, local_today, validate_len};
use crate::repository::{project_repo, task_meta_repo, task_repo};

/// 任务标题长度上限（PRD 9.5.2）
pub const MAX_TASK_TITLE: usize = 100;
/// 「计划今日」滚动清理守卫：记录上次清理日期（YYYY-MM-DD），同日不重复清理
pub const KEY_ROLL_PLANNED_DATE: &str = "taskcard:roll_planned:last_date";
const VALID_STATUS: [&str; 3] = ["todo", "doing", "done"];
const VALID_PRIORITY: [&str; 3] = ["high", "medium", "low"];

fn valid_status(s: &str) -> bool {
    VALID_STATUS.contains(&s)
}
fn valid_priority(s: &str) -> bool {
    VALID_PRIORITY.contains(&s)
}

/// 空串归一为 None（可空时间字段清除）
fn norm_opt(v: Option<String>) -> Result<Option<String>, AppError> {
    match v {
        None => Ok(None),
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                Ok(None)
            } else {
                Ok(Some(t.to_string()))
            }
        }
    }
}

/// 校验「开始时间 ≤ 截止时间」（本地时间字符串可直接字典序比较）
fn check_time_range(start: &Option<String>, due: &Option<String>) -> Result<(), AppError> {
    if let (Some(s), Some(d)) = (start, due) {
        if s > d {
            return Err(AppError::Validation("计划开始时间不能晚于截止时间".into()));
        }
    }
    Ok(())
}

/// 任务标签聚合：为任务列表填充 tags 字段
fn fill_tags(conn: &rusqlite::Connection, tasks: &mut [TaskCard]) -> Result<(), AppError> {
    let ids: Vec<String> = tasks.iter().map(|t| t.id.clone()).collect();
    let pairs = task_repo::tags_of_tasks(conn, &ids)?;
    let mut map: HashMap<String, Vec<Tag>> = HashMap::new();
    for (task_id, tag) in pairs {
        map.entry(task_id).or_default().push(tag);
    }
    for t in tasks.iter_mut() {
        t.tags = map.remove(&t.id).unwrap_or_default();
    }
    Ok(())
}

/// 回收站任务条目（含所属项目名，供回收站 UI 展示）
#[derive(Debug, Serialize, Clone)]
pub struct DeletedTaskItem {
    #[serde(flatten)]
    pub task: TaskCard,
    #[serde(rename = "projectName")]
    pub project_name: Option<String>,
}

/// 校验项目存在且未删除
fn ensure_project_active(conn: &rusqlite::Connection, project_id: &str) -> Result<(), AppError> {
    project_repo::find_active(conn, project_id)
        .map_err(|_| AppError::NotFound("所属项目不存在或已删除".into()))?;
    Ok(())
}

// ── 参数 DTO ──

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskParams {
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub plan_start_time: Option<String>,
    pub due_time: Option<String>,
    #[serde(default)]
    pub planned_today: bool,
    #[serde(default)]
    pub note: String,
    /// 标签 id 列表（可空）
    #[serde(default)]
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskParams {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub plan_start_time: Option<String>,
    pub due_time: Option<String>,
    pub planned_today: Option<bool>,
    pub note: Option<String>,
    /// 传 Some(ids) 时整体替换标签
    pub tag_ids: Option<Vec<String>>,
    /// 任务级提醒类型：''=跟随全局偏好 / 'off'=该任务不提醒 /
    /// 'due_before'|'due_day'|'overdue'=只按该类别（PRD 12.2）/ 'custom'=自定义单点（配合 remind_at）
    pub remind_type: Option<String>,
    /// 自定义提醒时间（本地时间字符串 YYYY-MM-DDTHH:MM），仅 remind_type='custom' 时有意义
    pub remind_at: Option<String>,
}

fn default_status() -> String {
    "todo".into()
}
fn default_priority() -> String {
    "medium".into()
}

// ── 查询 ──

/// 列出某项目全部未删除任务（含标签）
pub fn list_tasks(
    app: &AppHandle,
    db: &AppDb,
    project_id: &str,
) -> Result<Vec<TaskCard>, AppError> {
    emit_sql_log(app, "SELECT", "tasks", &format!("project_id={project_id}"), file!(), line!());
    let conn = db.pool.get()?;
    let mut tasks = task_repo::list_by_project(&conn, project_id)?;
    fill_tags(&conn, &mut tasks)?;
    Ok(tasks)
}

/// 列出全部未删除任务（跨项目，供今日任务页聚合；所属项目必须未删除）
pub fn list_all_tasks(app: &AppHandle, db: &AppDb) -> Result<Vec<TaskCard>, AppError> {
    emit_sql_log(app, "SELECT", "tasks", "all active", file!(), line!());
    let conn = db.pool.get()?;
    let mut tasks = task_repo::list_all(&conn)?;
    fill_tags(&conn, &mut tasks)?;
    Ok(tasks)
}

/// 获取单个任务（含标签）
pub fn get_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<TaskCard, AppError> {
    emit_sql_log(app, "SELECT", "tasks", &format!("id={id}"), file!(), line!());
    let conn = db.pool.get()?;
    let mut task = task_repo::find_active(&conn, id)
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))?;
    let ids = vec![task.id.clone()];
    if let Ok(pairs) = task_repo::tags_of_tasks(&conn, &ids) {
        task.tags = pairs.into_iter().map(|(_, t)| t).collect();
    }
    Ok(task)
}

// ── 写入 ──

/// 创建任务（必属项目，追加到对应状态列尾；标签整体写入）
pub fn create_task(
    app: &AppHandle,
    db: &AppDb,
    params: CreateTaskParams,
) -> Result<TaskCard, AppError> {
    let title = params.title.trim();
    if title.is_empty() {
        return Err(AppError::Validation("任务标题不能为空".into()));
    }
    validate_len("任务标题", title, MAX_TASK_TITLE)?;
    if !valid_status(&params.status) {
        return Err(AppError::Validation(format!("无效的任务状态: {}", params.status)));
    }
    if !valid_priority(&params.priority) {
        return Err(AppError::Validation(format!("无效的优先级: {}", params.priority)));
    }
    let start = norm_opt(params.plan_start_time)?;
    let due = norm_opt(params.due_time)?;
    check_time_range(&start, &due)?;

    let id = Uuid::new_v4().to_string();
    let ts = now();

    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    ensure_project_active(&tx, &params.project_id)?;
    let sort_order = task_repo::next_sort_order(&tx, &params.project_id, &params.status)?;
    emit_sql_log(
        app,
        "INSERT",
        "tasks",
        &format!("id={id}, title={title}, project={}", params.project_id),
        file!(),
        line!(),
    );
    task_repo::insert(
        &tx, &id, &params.project_id, title, &params.description, &params.status,
        &params.priority, start.as_deref(), due.as_deref(),
        params.planned_today as i64, &params.note, sort_order, &ts,
    )?;
    replace_tags(&tx, &id, &params.tag_ids, &ts)?;
    tx.commit()?;
    get_task(app, db, &id)
}

/// 整体替换任务标签（先清后加，幂等）
fn replace_tags(
    conn: &rusqlite::Connection,
    task_id: &str,
    tag_ids: &[String],
    ts: &str,
) -> Result<(), AppError> {
    task_repo::clear_task_tags(conn, task_id)?;
    for tid in tag_ids {
        task_repo::add_task_tag(conn, task_id, tid, ts)?;
    }
    Ok(())
}

/// 更新任务字段（部分更新）；状态变更时联动完成时间（PRD 10.2）
pub fn update_task(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    params: UpdateTaskParams,
) -> Result<TaskCard, AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let current = task_repo::find_active(&tx, id)
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))?;

    if let Some(ref title) = params.title {
        if title.trim().is_empty() {
            return Err(AppError::Validation("任务标题不能为空".into()));
        }
        validate_len("任务标题", title.trim(), MAX_TASK_TITLE)?;
    }
    if let Some(ref s) = params.status {
        if !valid_status(s) {
            return Err(AppError::Validation(format!("无效的任务状态: {s}")));
        }
    }
    if let Some(ref p) = params.priority {
        if !valid_priority(p) {
            return Err(AppError::Validation(format!("无效的优先级: {p}")));
        }
    }
    let has_start = params.plan_start_time.is_some();
    let has_due = params.due_time.is_some();
    let new_start = norm_opt(params.plan_start_time)?;
    let new_due = norm_opt(params.due_time)?;
    check_time_range(&new_start, &new_due)?;

    let ts = now();
    let now_local = local_now();
    let new_status = params.status.clone();
    let status_changed = new_status.is_some() && new_status.as_deref() != Some(current.status.as_str());

    let mut set_clauses: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    // 局部宏：拼接 `col=?n` 并收集参数值（支持 String / Option<String> / i64）
    macro_rules! push_set {
        ($col:expr, $val:expr) => {{
            set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
            param_values.push(Box::new($val) as Box<dyn rusqlite::types::ToSql>);
        }};
    }

    if let Some(v) = params.title {
        push_set!("title", v.trim().to_string());
    }
    if let Some(v) = params.description {
        push_set!("description", v);
    }
    if let Some(v) = params.priority {
        push_set!("priority", v);
    }
    if let Some(s) = new_status {
        push_set!("status", s.clone());
        // 状态变更联动完成时间：进入 done 记录，离开 done 清空
        if status_changed {
            if s == "done" {
                push_set!("completed_time", now_local);
            } else if current.status == "done" {
                push_set!("completed_time", Option::<String>::None);
            }
        }
    }
    if has_start {
        push_set!("plan_start_time", new_start);
    }
    if has_due {
        push_set!("due_time", new_due);
    }
    if let Some(v) = params.planned_today {
        push_set!("planned_today", if v { 1 } else { 0 });
    }
    if let Some(v) = params.note {
        push_set!("note", v);
    }
    // 任务级提醒：'' / off 等清除 remind_at；custom 需携带具体时间
    if let Some(v) = params.remind_type {
        let vt = v.trim().to_string();
        if vt == "custom" {
            let ra = norm_opt(params.remind_at)?
                .ok_or_else(|| AppError::Validation("自定义提醒需设置提醒时间".into()))?;
            push_set!("remind_at", Some(ra));
            push_set!("remind_type", vt);
        } else {
            push_set!("remind_at", Option::<String>::None);
            push_set!("remind_type", vt);
        }
    }

    if !set_clauses.is_empty() {
        push_set!("updated_at", ts.clone());
        let sql = format!(
            "UPDATE tasks SET {} WHERE id=?{}",
            set_clauses.join(", "),
            set_clauses.len() + 1
        );
        param_values.push(Box::new(id.to_string()));
        emit_sql_log(app, "UPDATE", "tasks", &format!("id={id}"), file!(), line!());
        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        tx.execute(&sql, params_refs.as_slice())?;
    }
    if let Some(ids) = params.tag_ids {
        replace_tags(&tx, id, &ids, &ts)?;
    }
    tx.commit()?;
    get_task(app, db, id)
}

/// 状态切换 / 勾选完成 / 重新打开：更新状态并移动到目标列尾
pub fn set_task_status(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    status: &str,
) -> Result<TaskCard, AppError> {
    if !valid_status(status) {
        return Err(AppError::Validation(format!("无效的任务状态: {status}")));
    }
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let current = task_repo::find_active(&tx, id)
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))?;
    if current.status == status {
        tx.commit()?;
        return get_task(app, db, id);
    }
    let ts = now();
    let now_local = local_now();
    let comp = if status == "done" {
        Some(now_local.as_str())
    } else {
        None
    };
    emit_sql_log(
        app,
        "UPDATE",
        "tasks",
        &format!("id={id}, status {}=>{status}", current.status),
        file!(),
        line!(),
    );
    task_repo::update_status(&tx, id, status, comp, &ts)?;
    // 移动到目标状态列尾部
    let next = task_repo::next_sort_order(&tx, &current.project_id, status)?;
    task_repo::set_sort_order(&tx, id, next, &ts)?;
    tx.commit()?;
    get_task(app, db, id)
}

/// 看板拖拽（PRD 9.4.4）：
/// - 跨列：更新状态（进 done 记录完成时间 / 离开 done 清空）后按目标列顺序重排
/// - 同列：按传入顺序重排（手动排序）
/// `ordered_ids` 为拖放后目标列完整顺序（须包含 task_id）
pub fn drag_task(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
    to_status: &str,
    ordered_ids: Vec<String>,
) -> Result<(), AppError> {
    if !valid_status(to_status) {
        return Err(AppError::Validation(format!("无效的任务状态: {to_status}")));
    }
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let current = task_repo::find_active(&tx, task_id)
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))?;
    let ts = now();
    if current.status != to_status {
        let now_local = local_now();
        let comp = if to_status == "done" {
            Some(now_local.as_str())
        } else {
            None
        };
        emit_sql_log(
            app,
            "UPDATE",
            "tasks",
            &format!("id={task_id}, drag {}=>{to_status}", current.status),
            file!(),
            line!(),
        );
        task_repo::update_status(&tx, task_id, to_status, comp, &ts)?;
    }
    // 按目标列最终顺序重排（事务内，失败自动回滚）
    for (i, tid) in ordered_ids.iter().enumerate() {
        task_repo::set_sort_order(&tx, tid, i as i64, &ts)?;
    }
    tx.commit()?;
    Ok(())
}

/// 复制任务：标题/描述/标签复制，状态置待办并排到待办列尾（PRD 9.6.2）
pub fn copy_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<TaskCard, AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let src = task_repo::find_active(&tx, id)
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))?;
    let new_id = Uuid::new_v4().to_string();
    let ts = now();
    let sort_order = task_repo::next_sort_order(&tx, &src.project_id, "todo")?;
    emit_sql_log(app, "INSERT", "tasks", &format!("id={new_id}, copy from {id}"), file!(), line!());
    task_repo::insert(
        &tx, &new_id, &src.project_id, &src.title, &src.description, "todo",
        &src.priority, src.plan_start_time.as_deref(), src.due_time.as_deref(),
        0, "", sort_order, &ts,
    )?;
    // 复制标签
    let ids = vec![src.id.clone()];
    if let Ok(pairs) = task_repo::tags_of_tasks(&tx, &ids) {
        for (_, tag) in pairs {
            task_repo::add_task_tag(&tx, &new_id, &tag.id, &ts)?;
        }
    }
    tx.commit()?;
    get_task(app, db, &new_id)
}

/// 移动任务到其他项目（状态列保持不变，追加到目标列尾；PRD 9.6.2）
pub fn move_task_to_project(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
    to_project_id: &str,
) -> Result<TaskCard, AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let current = task_repo::find_active(&tx, task_id)
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))?;
    ensure_project_active(&tx, to_project_id)?;
    let ts = now();
    let next = task_repo::next_sort_order(&tx, to_project_id, &current.status)?;
    emit_sql_log(
        app,
        "UPDATE",
        "tasks",
        &format!("id={task_id} -> project {to_project_id}"),
        file!(),
        line!(),
    );
    tx.execute(
        "UPDATE tasks SET project_id=?1, sort_order=?2, updated_at=?3 WHERE id=?4",
        rusqlite::params![to_project_id, next, ts, task_id],
    )?;
    tx.commit()?;
    get_task(app, db, task_id)
}

// ── 删除与回收站 ──

/// 软删除任务
pub fn delete_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "tasks", &format!("id={id}, soft delete"), file!(), line!());
    task_repo::soft_delete(&conn, id, &ts)?;
    Ok(())
}

/// 恢复任务（所属项目必须未删除，否则引导先恢复项目）
pub fn restore_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let deleted = task_repo::find_by_id(&conn, id)
        .map_err(|_| AppError::NotFound("未找到该任务".into()))?;
    if deleted.deleted_at.is_none() {
        return Err(AppError::Business("该任务不在回收站中".into()));
    }
    project_repo::find_active(&conn, &deleted.project_id)
        .map_err(|_| AppError::Business("所属项目已删除，请先在回收站恢复项目".into()))?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "tasks", &format!("id={id}, restore"), file!(), line!());
    let affected = task_repo::restore(&conn, id, &ts)?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该任务或任务不在回收站".into()));
    }
    Ok(())
}

/// 彻底删除任务
pub fn hard_delete_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "DELETE", "tasks", &format!("id={id}, hard delete"), file!(), line!());
    task_repo::hard_delete(&conn, id)?;
    Ok(())
}

/// 列出回收站中的任务（含所属项目名）
pub fn list_deleted_tasks(app: &AppHandle, db: &AppDb) -> Result<Vec<DeletedTaskItem>, AppError> {
    emit_sql_log(app, "SELECT", "tasks", "deleted_at IS NOT NULL", file!(), line!());
    let conn = db.pool.get()?;
    let rows = task_repo::list_deleted(&conn)?;
    Ok(rows
        .into_iter()
        .map(|r| DeletedTaskItem {
            task: r.task,
            project_name: r.project_name,
        })
        .collect())
}

/// 清空任务回收站
pub fn clear_task_trash(app: &AppHandle, db: &AppDb) -> Result<u32, AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(app, "DELETE", "tasks", "clear trash", file!(), line!());
    let count = task_repo::count_deleted(&conn)?;
    task_repo::clear_trash(&conn)?;
    Ok(count)
}

// ── 今日任务 ──

/// 「计划今日」滚动清理（PRD 7.4）：自然日切换后由前端触发
pub fn roll_planned_today(app: &AppHandle, db: &AppDb) -> Result<u32, AppError> {
    let conn = db.pool.get()?;
    let today = local_today();
    // 自然日守卫：仅跨天后的首次调用才清理（记录上次滚动日期），
    // 避免每次打开窗口都清掉当天新设的「计划今日」任务。
    if task_meta_repo::get(&conn, KEY_ROLL_PLANNED_DATE)?.as_deref() == Some(today.as_str()) {
        return Ok(0);
    }
    let ts = now();
    emit_sql_log(app, "UPDATE", "tasks", "roll planned_today", file!(), line!());
    let n = task_repo::roll_planned_today(&conn, &ts)?;
    task_meta_repo::set(&conn, KEY_ROLL_PLANNED_DATE, &today, &ts)?;
    Ok(n as u32)
}

/// 今日任务概览（后端按设备本地时区聚合）
pub fn get_today_overview(app: &AppHandle, db: &AppDb) -> Result<TodayOverview, AppError> {
    let today = crate::utils::local_today();
    let now_local = local_now();
    emit_sql_log(app, "SELECT", "tasks", "today overview", file!(), line!());
    let conn = db.pool.get()?;
    let (undone_due, done_today, overdue) =
        task_repo::today_overview_counts(&conn, &today, &now_local)?;
    Ok(TodayOverview {
        due_today: undone_due + done_today,
        done_today,
        overdue,
        badge: undone_due,
    })
}
