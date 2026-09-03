//! 子任务业务服务（任务卡 P2）
//!
//! 子任务/任务清单：属于某任务卡，随任务级联删除（无独立回收站）。
//! 提供列表 / 创建 / 重命名 / 勾选 / 重排 / 删除；父任务状态不受子任务影响。

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::TaskSubtask;
use crate::commands::window::emit_sql_log;
use crate::utils::{now, validate_len};
use crate::repository::{subtask_repo, task_repo};
use crate::service::activity_log_service;

/// 子任务标题长度上限
pub const MAX_SUBTASK_TITLE: usize = 200;

/// 子任务标题最大长度校验常量封装
fn ensure_task_active(conn: &rusqlite::Connection, task_id: &str) -> Result<(), AppError> {
    task_repo::find_active(conn, task_id)
        .map(|_| ())
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))
}

/// 列出某任务全部子任务
pub fn list_subtasks(app: &AppHandle, db: &AppDb, task_id: &str) -> Result<Vec<TaskSubtask>, AppError> {
    emit_sql_log(app, "SELECT", "task_subtasks", &format!("task_id={task_id}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(subtask_repo::list_by_task(&conn, task_id)?)
}

/// 创建子任务（追加到列表末尾）
pub fn create_subtask(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
    title: &str,
) -> Result<TaskSubtask, AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Validation("子任务内容不能为空".into()));
    }
    validate_len("子任务内容", title, MAX_SUBTASK_TITLE)?;
    let conn = db.pool.get()?;
    ensure_task_active(&conn, task_id)?;
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let sort_order = subtask_repo::next_sort_order(&conn, task_id)?;
    emit_sql_log(app, "INSERT", "task_subtasks", &format!("id={id}, task_id={task_id}"), file!(), line!());
    subtask_repo::insert(&conn, &id, task_id, title, sort_order, &ts)?;
    let item = subtask_repo::find_by_id(&conn, &id).map_err(AppError::from)?;
    activity_log_service::try_task_log(db, task_id, "subtask.added", &format!("添加清单项「{title}」"));
    Ok(item)
}

/// 重命名子任务
pub fn update_subtask(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    title: &str,
) -> Result<TaskSubtask, AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Validation("子任务内容不能为空".into()));
    }
    validate_len("子任务内容", title, MAX_SUBTASK_TITLE)?;
    let conn = db.pool.get()?;
    let ts = now();
    emit_sql_log(app, "UPDATE", "task_subtasks", &format!("id={id}"), file!(), line!());
    if subtask_repo::rename(&conn, id, title, &ts)? == 0 {
        return Err(AppError::NotFound("未找到该子任务".into()));
    }
    let item = subtask_repo::find_by_id(&conn, id).map_err(AppError::from)?;
    activity_log_service::try_task_log(
        db,
        &item.task_id,
        "subtask.updated",
        &format!("更新清单项标题为「{}」", item.title),
    );
    Ok(item)
}

/// 勾选 / 取消完成
pub fn set_subtask_done(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    done: bool,
) -> Result<TaskSubtask, AppError> {
    let conn = db.pool.get()?;
    let current = subtask_repo::find_by_id(&conn, id)
        .map_err(|_| AppError::NotFound("未找到该子任务".into()))?;
    if current.done == done {
        return Ok(current);
    }
    let ts = now();
    emit_sql_log(app, "UPDATE", "task_subtasks", &format!("id={id}, done={done}"), file!(), line!());
    if subtask_repo::set_done(&conn, id, done, &ts)? == 0 {
        return Err(AppError::NotFound("未找到该子任务".into()));
    }
    let item = subtask_repo::find_by_id(&conn, id).map_err(AppError::from)?;
    let summary = format!("{}清单项「{}」", if done { "完成" } else { "重新打开" }, item.title);
    activity_log_service::try_task_log(db, &item.task_id, if done { "subtask.done" } else { "subtask.redone" }, &summary);
    Ok(item)
}

/// 子任务重排：`ordered_ids` 为完整顺序（须含全部现存子任务 id）
pub fn reorder_subtasks(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
    ordered_ids: Vec<String>,
) -> Result<(), AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;
    let ts = now();
    for (i, sid) in ordered_ids.iter().enumerate() {
        subtask_repo::set_sort_order(&tx, sid, i as i64, &ts)?;
    }
    emit_sql_log(app, "UPDATE", "task_subtasks", &format!("reorder task_id={task_id}"), file!(), line!());
    tx.commit()?;
    Ok(())
}

/// 删除子任务（硬删）
pub fn delete_subtask(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let current = subtask_repo::find_by_id(&conn, id)
        .map_err(|_| AppError::NotFound("未找到该子任务".into()))?;
    emit_sql_log(app, "DELETE", "task_subtasks", &format!("id={id}"), file!(), line!());
    if subtask_repo::delete(&conn, id)? == 0 {
        return Err(AppError::NotFound("未找到该子任务".into()));
    }
    activity_log_service::try_task_log(db, &current.task_id, "subtask.removed", &format!("删除清单项「{}」", current.title));
    Ok(())
}
