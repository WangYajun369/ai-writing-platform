//! 任务业务服务（任务卡模块）
//!
//! 任务三态（todo / doing / done）流转、完成/重开时间记录、看板拖拽重排、
//! 标签聚合、今日概览与「计划今日」滚动清理。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Tag, TaskCard, TodayOverview};
use crate::repository::{project_repo, subtask_repo, task_meta_repo, task_repo};
use crate::service::activity_log_service;
use crate::utils::{local_now, local_today, now, validate_len};
use chrono::Datelike;
use serde::Serialize;
use std::collections::HashMap;
use tauri::AppHandle;
use uuid::Uuid;

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

/// 校验父任务关联并返回规范值（None=顶层任务）：
/// - 空值/空串 → None（不关联父任务）
/// - 父任务必须存在、未删除、且与任务同属一个项目
/// - 禁止把任务挂到自己或自己的后代之下（防环）
/// self_id 为当前任务的 id（新建时为 None）。
fn resolve_parent_id(
    conn: &rusqlite::Connection,
    self_id: Option<&str>,
    project_id: &str,
    parent_id: Option<String>,
) -> Result<Option<String>, AppError> {
    let pid = match parent_id {
        Some(s) => s.trim().to_string(),
        None => String::new(),
    };
    if pid.is_empty() {
        return Ok(None);
    }
    if let Some(sid) = self_id {
        if pid == sid {
            return Err(AppError::Validation("任务不能作为自己的父任务".into()));
        }
        if task_repo::chain_hits_self(conn, &pid, sid)? {
            return Err(AppError::Validation(
                "不能选择任务的子任务作为父任务（会形成循环）".into(),
            ));
        }
    }
    let parent = task_repo::find_active(conn, &pid)
        .map_err(|_| AppError::Validation("父任务不存在或已删除".into()))?;
    if parent.project_id != project_id {
        return Err(AppError::Validation("父任务必须与任务属于同一项目".into()));
    }
    Ok(Some(pid))
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
    /// 父任务 id（NULL/空 = 顶层任务；父任务必须与任务同项目）
    #[serde(default)]
    pub parent_id: Option<String>,
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
    /// 重复规则 JSON；'' = 不重复（P2）
    #[serde(default)]
    pub recurrence: String,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskParams {
    pub title: Option<String>,
    pub description: Option<String>,
    /// 父任务 id：Some(空串/NULL) 表示解除关联成为顶层任务；None 表示不修改
    pub parent_id: Option<String>,
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
    /// 重复规则 JSON；传 Some("") 表示取消重复（P2）
    pub recurrence: Option<String>,
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
    emit_sql_log(
        app,
        "SELECT",
        "tasks",
        &format!("project_id={project_id}"),
        file!(),
        line!(),
    );
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
    emit_sql_log(
        app,
        "SELECT",
        "tasks",
        &format!("id={id}"),
        file!(),
        line!(),
    );
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
        return Err(AppError::Validation(format!(
            "无效的任务状态: {}",
            params.status
        )));
    }
    if !valid_priority(&params.priority) {
        return Err(AppError::Validation(format!(
            "无效的优先级: {}",
            params.priority
        )));
    }
    let start = norm_opt(params.plan_start_time)?;
    let due = norm_opt(params.due_time)?;
    check_time_range(&start, &due)?;

    let id = Uuid::new_v4().to_string();
    let ts = now();

    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    ensure_project_active(&tx, &params.project_id)?;
    let parent_id = resolve_parent_id(&tx, None, &params.project_id, params.parent_id)?;
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
        &tx,
        &id,
        &params.project_id,
        parent_id.as_deref(),
        title,
        &params.description,
        &params.status,
        &params.priority,
        start.as_deref(),
        due.as_deref(),
        params.planned_today as i64,
        &params.note,
        sort_order,
        &ts,
    )?;
    replace_tags(&tx, &id, &params.tag_ids, &ts)?;
    let rec = params.recurrence.trim();
    if !rec.is_empty() && rec != "{}" {
        task_repo::update_ext(&tx, &id, Some(rec), None, None, None, &ts)?;
    }
    tx.commit()?;
    activity_log_service::try_task_log(
        db,
        &id,
        "task.created",
        &format!("创建任务「{}」", params.title.trim()),
    );
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
    let status_changed =
        new_status.is_some() && new_status.as_deref() != Some(current.status.as_str());
    // 完成前置校验（P2）：由非 done 进入 done 前必须先完成全部子任务
    if status_changed && new_status.as_deref() == Some("done") {
        ensure_all_subtasks_done(&tx, id, "done")?;
    }

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
    // 父任务：Some(空) 解除关联成顶层；Some(id) 校验后关联（同项目、防环）
    if let Some(v) = params.parent_id {
        let resolved = resolve_parent_id(&tx, Some(id), &current.project_id, Some(v))?;
        push_set!("parent_id", resolved);
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
    // 重复规则（P2）：传 Some("") 表示取消
    if let Some(v) = params.recurrence {
        push_set!("recurrence", v.trim().to_string());
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
        emit_sql_log(
            app,
            "UPDATE",
            "tasks",
            &format!("id={id}"),
            file!(),
            line!(),
        );
        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        tx.execute(&sql, params_refs.as_slice())?;
    }
    if let Some(ids) = params.tag_ids {
        replace_tags(&tx, id, &ids, &ts)?;
    }
    // 完成时推进重复任务（P2）：由其他状态转为 done
    let spawned = if status_changed && params.status.as_deref() == Some("done") {
        roll_recurrence(app, &tx, &current, &ts)?
    } else {
        None
    };
    tx.commit()?;
    // 操作日志埋点（尽力而为）
    let was_done = current.status == "done";
    let title = current.title;
    if status_changed {
        match params.status.as_deref() {
            Some("done") => {
                let summary = if spawned.is_some() {
                    format!("完成任务「{title}」，并自动生成下一次重复")
                } else {
                    format!("完成任务「{title}」")
                };
                activity_log_service::try_task_log(db, id, "task.completed", &summary);
            }
            Some(_) if was_done => {
                activity_log_service::try_task_log(
                    db,
                    id,
                    "task.reopened",
                    &format!("重新打开任务「{title}」"),
                );
            }
            _ => {
                activity_log_service::try_task_log(
                    db,
                    id,
                    "task.updated",
                    &format!("更新任务「{title}」"),
                );
            }
        }
    } else {
        activity_log_service::try_task_log(db, id, "task.updated", &format!("更新任务「{title}」"));
    }
    get_task(app, db, id)
}

/// 完成前置校验（P2）：任务存在未完成子任务时禁止置为「已完成」。
/// 由各「进入 done」入口（update_task / set_task_status / drag_task）调用，
/// 保证所有完成路径（勾选、详情状态切换、看板拖拽）行为一致。
fn ensure_all_subtasks_done(
    tx: &rusqlite::Transaction,
    task_id: &str,
    to_status: &str,
) -> Result<(), AppError> {
    if to_status != "done" {
        return Ok(());
    }
    let items = subtask_repo::list_by_task(tx, task_id)?;
    let pending = items.iter().filter(|s| !s.done).count();
    if pending > 0 {
        return Err(AppError::Validation(format!(
            "还有 {pending} 项子任务未完成，请先完成全部子任务后再完成本任务"
        )));
    }
    Ok(())
}

/// 状态切换 / 勾选完成 / 重新打开：更新状态并移动到目标列尾。
/// `completion_summary`：进入 done 时填写完成总结（富文本 HTML，Some(空串) 表示清空）；
/// 离开 done / 传 None 时不改动总结字段（重开保留历史总结，可再次覆盖）。
pub fn set_task_status(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    status: &str,
    completion_summary: Option<&str>,
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
    // 完成前置校验（P2）：进入 done 前必须先完成全部子任务
    if status == "done" {
        ensure_all_subtasks_done(&tx, id, status)?;
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
    // 完成时保存本次总结（重新打开任务不会改动历史总结）
    if status == "done" {
        if let Some(s) = completion_summary {
            emit_sql_log(
                app,
                "UPDATE",
                "tasks",
                &format!("id={id}, completion_summary={} 字", s.chars().count()),
                file!(),
                line!(),
            );
            task_repo::update_completion_summary(&tx, id, s, &ts)?;
        }
    }
    // 移动到目标状态列尾部
    let next = task_repo::next_sort_order(&tx, &current.project_id, status)?;
    task_repo::set_sort_order(&tx, id, next, &ts)?;
    // 完成时推进重复任务（P2）
    let spawned = if status == "done" {
        roll_recurrence(app, &tx, &current, &ts)?
    } else {
        None
    };
    tx.commit()?;
    // 操作日志埋点（尽力而为）
    let title = current.title;
    if status == "done" {
        let summary = if spawned.is_some() {
            format!("完成任务「{title}」，并自动生成下一次重复")
        } else {
            format!("完成任务「{title}」")
        };
        activity_log_service::try_task_log(db, id, "task.completed", &summary);
    } else {
        activity_log_service::try_task_log(
            db,
            id,
            "task.reopened",
            &format!("重新打开任务「{title}」"),
        );
    }
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
        // 完成前置校验（P2）：拖入「已完成」列前必须先完成全部子任务
        if to_status == "done" {
            ensure_all_subtasks_done(&tx, task_id, to_status)?;
        }
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
    // 拖拽完成时推进重复任务（P2）
    let spawned = if to_status == "done" && current.status != "done" {
        roll_recurrence(app, &tx, &current, &ts)?
    } else {
        None
    };
    tx.commit()?;
    // 操作日志埋点（尽力而为）
    let title = current.title;
    if to_status == "done" {
        let summary = if spawned.is_some() {
            format!("完成任务「{title}」，并自动生成下一次重复")
        } else {
            format!("完成任务「{title}」")
        };
        activity_log_service::try_task_log(db, task_id, "task.completed", &summary);
    }
    Ok(())
}

/// 重复任务推进（P2，PRD 6.3-2）：任务完成（进入 done）后，在当前事务内按
/// 其重复规则创建下一实例并复制标签与富文本备注，返回生成实例 id。
/// - 规则 JSON：{"freq":"daily|weekly|monthly","interval":1,"weekdays":[1..7],
///   "monthDay":15,"endDate":"YYYY-MM-DD"|""}；'' 或非法规则 → 不生成
/// - 下一截止日期以「原截止（无截止则计划开始，再则今天）」为锚推算，
///   保留原时刻，只替换日期；新实例状态 todo、不计划今日、提醒复位走全局规则
/// - 到达 endDate 后不再生成（原任务保持已完成，规则自然失效）
fn roll_recurrence(
    app: &AppHandle,
    tx: &rusqlite::Transaction,
    current: &TaskCard,
    ts: &str,
) -> Result<Option<String>, AppError> {
    let rule = current.recurrence.trim();
    if rule.is_empty() || rule == "{}" {
        return Ok(None);
    }
    let anchor = current
        .due_time
        .as_deref()
        .or(current.plan_start_time.as_deref())
        .map(|s| s.get(..10).unwrap_or(s).to_string())
        .unwrap_or_else(local_today);
    let Some(next) = next_recur_date(rule, &anchor) else {
        return Ok(None);
    };
    // 结束日期拦截：next 超出 endDate → 不再生成
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(rule) {
        if let Some(ed) = v
            .get("endDate")
            .and_then(|e| e.as_str())
            .filter(|s| !s.is_empty())
            .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        {
            if next > ed {
                return Ok(None);
            }
        }
    }
    let new_id = Uuid::new_v4().to_string();
    let sort_order = task_repo::next_sort_order(tx, &current.project_id, "todo")?;
    // 只替换截止日期部分，保留原时刻
    let next_fmt = next.format("%Y-%m-%d").to_string();
    let new_due = current.due_time.as_deref().map(|d| {
        if d.len() >= 10 {
            format!("{next_fmt}{}", &d[10..])
        } else {
            next_fmt.clone()
        }
    });
    emit_sql_log(
        app,
        "INSERT",
        "tasks",
        &format!("recurrence: next of {}", current.id),
        file!(),
        line!(),
    );
    task_repo::insert(
        tx,
        &new_id,
        &current.project_id,
        current.parent_id.as_deref(),
        &current.title,
        &current.description,
        "todo",
        &current.priority,
        current.plan_start_time.as_deref(),
        new_due.as_deref(),
        0,
        &current.note,
        sort_order,
        ts,
    )?;
    task_repo::update_ext(
        tx,
        &new_id,
        Some(rule),
        Some(current.note_html.as_str()),
        None,
        None,
        ts,
    )?;
    let ids = vec![current.id.clone()];
    if let Ok(pairs) = task_repo::tags_of_tasks(tx, &ids) {
        for (_, tag) in pairs {
            task_repo::add_task_tag(tx, &new_id, &tag.id, ts)?;
        }
    }
    Ok(Some(new_id))
}

/// 计算重复规则的下一个周期日期（YYYY-MM-DD），无效规则返回 None
///
/// - daily：锚点 + interval 天
/// - weekly：weekdays 为空 → 锚点 + interval×7 天；
///   非空 → 命中周按「锚点所在相位周 + interval 周」推进（跳过中间的间隔周），
///   在该相位周内取第一个命中周几（1=周一…7=周日）；interval=1 即下一周内首个命中周几
/// - monthly：按 monthDays 多日 / 旧版单日 monthDay / 锚点日（缺省）推进，
///   在接下来 interval 个月内取第一个晚于锚点的命中日（日号超出当月取月末）
fn next_recur_date(rule: &str, anchor: &str) -> Option<chrono::NaiveDate> {
    use chrono::NaiveDate;
    let v: serde_json::Value = serde_json::from_str::<serde_json::Value>(rule).ok()?;
    let freq = v.get("freq")?.as_str()?;
    let interval = v
        .get("interval")
        .and_then(|i| i.as_i64())
        .unwrap_or(1)
        .max(1);
    let base = NaiveDate::parse_from_str(anchor, "%Y-%m-%d").ok()?;
    match freq {
        "daily" => Some(base + chrono::Duration::days(interval)),
        "weekly" => {
            let weekdays: Vec<u32> = v
                .get("weekdays")
                .and_then(|w| w.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_i64())
                        .map(|d| d.clamp(1, 7) as u32)
                        .collect()
                })
                .unwrap_or_default();
            if weekdays.is_empty() {
                Some(base + chrono::Duration::days(interval * 7))
            } else {
                // 相位周推进：跳过中间 interval-1 个「无任务间隔周」，
                // 在第 interval 周内取第一个命中周几（7 天必含全部周几，恒有解）。
                // interval=1 时 lo=1，等价于原「下一周首个命中」，行为不变。
                let lo = (interval - 1) * 7 + 1;
                let hi = interval * 7;
                (lo..=hi).find_map(|d| {
                    let day = base + chrono::Duration::days(d);
                    weekdays
                        .contains(&day.weekday().number_from_monday())
                        .then_some(day)
                })
            }
        }
        "monthly" => {
            let mut month_days: Vec<u32> = v
                .get("monthDays")
                .and_then(|m| m.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_i64())
                        .map(|d| d.clamp(1, 31) as u32)
                        .collect()
                })
                .unwrap_or_default();
            if month_days.is_empty() {
                // 兼容旧版单日字段 monthDay；缺省用锚点日
                month_days = v
                    .get("monthDay")
                    .and_then(|m| m.as_i64())
                    .map(|d| vec![d.clamp(1, 31) as u32])
                    .unwrap_or_else(|| vec![base.day()]);
            }
            month_days.sort_unstable();
            // 候选月 = 锚点当月起按 interval 递增（先试当月剩余命中日，否则下一周期）；
            // 取组日内第一个晚于锚点的日期（日号超出当月自动取月末）
            (0..=1).find_map(|k| {
                let mo = k * interval;
                month_days
                    .iter()
                    .filter_map(|&d| advance_month(base, d, mo))
                    .find(|&d| d > base)
            })
        }
        _ => None,
    }
}

/// 从锚点推进 months 个月，目标日号为 target_day（超出当月天数取月末）
fn advance_month(
    anchor: chrono::NaiveDate,
    target_day: u32,
    months: i64,
) -> Option<chrono::NaiveDate> {
    let total = anchor.year() as i64 * 12 + (anchor.month() as i64 - 1) + months;
    let year = (total.div_euclid(12)) as i32;
    let month = (total.rem_euclid(12)) as u32 + 1;
    let max_day = {
        let (ny, nm) = if month == 12 {
            (year + 1, 1u32)
        } else {
            (year, month + 1)
        };
        chrono::NaiveDate::from_ymd_opt(ny, nm, 1)
            .and_then(|d| d.pred_opt())
            .map(|d| d.day())
            .unwrap_or(28)
    };
    chrono::NaiveDate::from_ymd_opt(year, month, target_day.min(max_day))
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
    emit_sql_log(
        app,
        "INSERT",
        "tasks",
        &format!("id={new_id}, copy from {id}"),
        file!(),
        line!(),
    );
    task_repo::insert(
        &tx,
        &new_id,
        &src.project_id,
        src.parent_id.as_deref(),
        &src.title,
        &src.description,
        "todo",
        &src.priority,
        src.plan_start_time.as_deref(),
        src.due_time.as_deref(),
        0,
        "",
        sort_order,
        &ts,
    )?;
    // 复制标签
    let ids = vec![src.id.clone()];
    if let Ok(pairs) = task_repo::tags_of_tasks(&tx, &ids) {
        for (_, tag) in pairs {
            task_repo::add_task_tag(&tx, &new_id, &tag.id, &ts)?;
        }
    }
    tx.commit()?;
    activity_log_service::try_task_log(
        db,
        &new_id,
        "task.created",
        &format!("从「{}」复制创建", src.title),
    );
    get_task(app, db, &new_id)
}

/// 移动任务到其他项目（状态列保持不变，追加到目标列尾；PRD 9.6.2）。
/// 带父子任务整体迁移：该任务的整棵子树（含已删除后代）一并移动，保证层级不被打散；
/// 原父任务若不在目标项目则父引用由孤儿清理解除（该任务成为目标项目顶层）。
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
    let subtree = task_repo::subtree_ids(&tx, task_id)?;
    let next = task_repo::next_sort_order(&tx, to_project_id, &current.status)?;
    // 整棵子树整体迁移（根任务追加到目标状态列尾，其余保持原列内排序）
    let placeholders: Vec<&str> = vec!["?"; subtree.len()];
    let sql = format!(
        "UPDATE tasks SET project_id=?1, updated_at=?2 WHERE id IN ({})",
        placeholders.join(",")
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(to_project_id.to_string()), Box::new(ts.clone())];
    for tid in &subtree {
        params.push(Box::new(tid.clone()));
    }
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    tx.execute(&sql, params_refs.as_slice())?;
    // 根任务移到目标状态列尾
    tx.execute(
        "UPDATE tasks SET sort_order=?1, updated_at=?2 WHERE id=?3",
        rusqlite::params![next, ts, task_id],
    )?;
    // 解除因跨项目造成的悬空父引用
    task_repo::clean_orphan_parents(&tx, &ts)?;
    emit_sql_log(
        app,
        "UPDATE",
        "tasks",
        &format!(
            "id={task_id} (subtree {}) -> project {to_project_id}",
            subtree.len()
        ),
        file!(),
        line!(),
    );
    tx.commit()?;
    activity_log_service::try_task_log(
        db,
        task_id,
        "task.moved",
        &format!("移动任务「{}」到其他项目", current.title),
    );
    get_task(app, db, task_id)
}

// ── 删除与回收站 ──

/// 软删除任务（其后代任务的父引用由孤儿清理自动解除，变成独立顶层任务）
pub fn delete_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let title = task_repo::find_by_id(&conn, id)
        .map_err(|_| AppError::NotFound("未找到该任务".into()))?
        .title;
    let ts = now();
    emit_sql_log(
        app,
        "UPDATE",
        "tasks",
        &format!("id={id}, soft delete"),
        file!(),
        line!(),
    );
    task_repo::soft_delete(&conn, id, &ts)?;
    task_repo::clean_orphan_parents(&conn, &ts)?;
    activity_log_service::try_task_log(db, id, "task.deleted", &format!("删除任务「{title}」"));
    Ok(())
}

/// 恢复任务（所属项目必须未删除，否则引导先恢复项目）
pub fn restore_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let deleted =
        task_repo::find_by_id(&conn, id).map_err(|_| AppError::NotFound("未找到该任务".into()))?;
    if deleted.deleted_at.is_none() {
        return Err(AppError::Business("该任务不在回收站中".into()));
    }
    project_repo::find_active(&conn, &deleted.project_id)
        .map_err(|_| AppError::Business("所属项目已删除，请先在回收站恢复项目".into()))?;
    let ts = now();
    emit_sql_log(
        app,
        "UPDATE",
        "tasks",
        &format!("id={id}, restore"),
        file!(),
        line!(),
    );
    let affected = task_repo::restore(&conn, id, &ts)?;
    if affected == 0 {
        return Err(AppError::NotFound("未找到该任务或任务不在回收站".into()));
    }
    // 恢复任务的父引用可能已悬空（父被删/被迁移），执行孤儿清理保持层级有效
    task_repo::clean_orphan_parents(&conn, &ts)?;
    activity_log_service::try_task_log(
        db,
        id,
        "task.restored",
        &format!("从回收站恢复任务「{}」", deleted.title),
    );
    Ok(())
}

/// 彻底删除任务（完成后清理因删除产生的孤儿父引用）
pub fn hard_delete_task(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(
        app,
        "DELETE",
        "tasks",
        &format!("id={id}, hard delete"),
        file!(),
        line!(),
    );
    task_repo::hard_delete(&conn, id)?;
    let ts = now();
    task_repo::clean_orphan_parents(&conn, &ts)?;
    Ok(())
}

/// 列出回收站中的任务（含所属项目名）
pub fn list_deleted_tasks(app: &AppHandle, db: &AppDb) -> Result<Vec<DeletedTaskItem>, AppError> {
    emit_sql_log(
        app,
        "SELECT",
        "tasks",
        "deleted_at IS NOT NULL",
        file!(),
        line!(),
    );
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
    let ts = now();
    task_repo::clean_orphan_parents(&conn, &ts)?;
    Ok(count)
}

/// 「计划今日」滚动清理守卫：记录上次清理日期（YYYY-MM-DD），同日不重复清理
pub const KEY_TRASH_PURGE_DATE: &str = "taskcard:trash_purge:last_date";
/// 回收站保留天数（PRD 6.3-6 / 9.12.2：先提供手动清空，30 天自动清理）
pub const TRASH_RETENTION_DAYS: i64 = 30;

/// 回收站自动清理（PRD 6.3-6）：硬删除删除时间超过保留期（默认 30 天）的
/// 项目与任务。由 lib.rs 后台循环每日调用一次（task_meta 日期守卫，同日内
/// 重复调用直接返回 0）。返回本次实际清理的条目数（任务 + 项目）。
pub fn purge_expired_trash(app: &AppHandle, db: &AppDb) -> Result<u32, AppError> {
    let conn = db.pool.get()?;
    let today = local_today();
    if task_meta_repo::get(&conn, KEY_TRASH_PURGE_DATE)?.as_deref() == Some(today.as_str()) {
        return Ok(0);
    }
    // 截止线 = 当前 UTC 时间 - 保留期（deleted_at 为 UTC RFC3339，字典序可比较）
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(TRASH_RETENTION_DAYS)).to_rfc3339();
    let ts = now();
    emit_sql_log(
        app,
        "DELETE",
        "tasks+projects",
        &format!("auto purge < {cutoff}"),
        file!(),
        line!(),
    );
    let task_n = task_repo::purge_expired(&conn, &cutoff)?;
    let project_n = project_repo::purge_expired(&conn, &cutoff)?;
    task_meta_repo::set(&conn, KEY_TRASH_PURGE_DATE, &today, &ts)?;
    task_repo::clean_orphan_parents(&conn, &ts)?;
    let total = (task_n + project_n) as u32;
    if total > 0 {
        crate::app_log!("[回收站] 自动清理 {total} 条过期数据（任务 {task_n}，项目 {project_n}）");
    }
    // 附件孤儿文件兜底清理（尽力而为，任务级联删除后可能遗留实体文件）
    if let Ok(removed) = crate::service::attachment_service::cleanup_orphan_files(app, db) {
        if removed > 0 {
            crate::app_log!("[回收站] 清理孤儿附件文件 {removed} 个");
        }
    }
    Ok(total)
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
    emit_sql_log(
        app,
        "UPDATE",
        "tasks",
        "roll planned_today",
        file!(),
        line!(),
    );
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
