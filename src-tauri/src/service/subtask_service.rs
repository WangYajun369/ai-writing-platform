//! 子任务业务服务（任务卡 P2）
//!
//! 子任务/任务清单：属于某任务卡，随任务级联删除（无独立回收站）。
//! 提供列表 / 创建 / 重命名 / 勾选 / 重排 / 删除；父任务状态不受子任务影响。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::TaskSubtask;
use crate::repository::{subtask_repo, task_repo};
use crate::service::activity_log_service;
use crate::service::uow::UnitOfWork;
use crate::utils::{now, validate_len};
use tauri::AppHandle;
use uuid::Uuid;

/// 子任务标题长度上限
pub const MAX_SUBTASK_TITLE: usize = 200;

/// 子任务标题最大长度校验常量封装
fn ensure_task_active(conn: &rusqlite::Connection, task_id: &str) -> Result<(), AppError> {
    task_repo::find_active(conn, task_id)
        .map(|_| ())
        .map_err(|_| AppError::NotFound("未找到该任务或任务已删除".into()))
}

/// 列出某任务全部子任务
pub fn list_subtasks(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
) -> Result<Vec<TaskSubtask>, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "task_subtasks",
        format!("task_id={task_id}"),
        file!(),
        line!(),
    );
    let subtasks = subtask_repo::list_by_task(uow.conn(), task_id)?;
    uow.commit()?;
    Ok(subtasks)
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
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口 + activity_log 纳入同事务。
    let pooled = db.pool.get()?;
    ensure_task_active(&pooled, task_id)?;
    let project_id = task_repo::project_id_of_active(&pooled, task_id)
        .ok()
        .flatten();
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let sort_order = subtask_repo::next_sort_order(&pooled, task_id)?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    uow.audit(
        "INSERT",
        "task_subtasks",
        format!("id={id}, task_id={task_id}"),
        file!(),
        line!(),
    );
    subtask_repo::insert(uow.conn(), &id, task_id, title, sort_order, &ts)?;
    let item = subtask_repo::find_by_id(uow.conn(), &id).map_err(AppError::from)?;
    activity_log_service::try_task_log_with_conn(
        uow.conn(),
        task_id,
        project_id.as_deref(),
        "subtask.added",
        &format!("添加清单项「{title}」"),
    )?;
    uow.commit()?;
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
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口 + activity_log 纳入同事务。
    let pooled = db.pool.get()?;
    let ts = now();
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    uow.audit(
        "UPDATE",
        "task_subtasks",
        format!("id={id}"),
        file!(),
        line!(),
    );
    if subtask_repo::rename(uow.conn(), id, title, &ts)? == 0 {
        return Err(AppError::NotFound("未找到该子任务".into()));
    }
    let item = subtask_repo::find_by_id(uow.conn(), id).map_err(AppError::from)?;
    let project_id = task_repo::project_id_of_active(uow.conn(), &item.task_id)
        .ok()
        .flatten();
    activity_log_service::try_task_log_with_conn(
        uow.conn(),
        &item.task_id,
        project_id.as_deref(),
        "subtask.updated",
        &format!("更新清单项标题为「{}」", item.title),
    )?;
    uow.commit()?;
    Ok(item)
}

/// 勾选 / 取消完成
pub fn set_subtask_done(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    done: bool,
) -> Result<TaskSubtask, AppError> {
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口 + activity_log 纳入同事务。
    let pooled = db.pool.get()?;
    let current = subtask_repo::find_by_id(&pooled, id)
        .map_err(|_| AppError::NotFound("未找到该子任务".into()))?;
    // 幂等处理：勾选状态未变化直接返回，避免重复写库与重复记操作日志
    if current.done == done {
        return Ok(current);
    }
    let project_id = task_repo::project_id_of_active(&pooled, &current.task_id)
        .ok()
        .flatten();
    let ts = now();
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    uow.audit(
        "UPDATE",
        "task_subtasks",
        format!("id={id}, done={done}"),
        file!(),
        line!(),
    );
    if subtask_repo::set_done(uow.conn(), id, done, &ts)? == 0 {
        return Err(AppError::NotFound("未找到该子任务".into()));
    }
    let item = subtask_repo::find_by_id(uow.conn(), id).map_err(AppError::from)?;
    let summary = format!(
        "{}清单项「{}」",
        if done { "完成" } else { "重新打开" },
        item.title
    );
    activity_log_service::try_task_log_with_conn(
        uow.conn(),
        &item.task_id,
        project_id.as_deref(),
        if done {
            "subtask.done"
        } else {
            "subtask.redone"
        },
        &summary,
    )?;
    uow.commit()?;
    Ok(item)
}

/// 子任务重排：`ordered_ids` 为完整顺序（须含全部现存子任务 id，且全部属于该任务）
pub fn reorder_subtasks(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
    ordered_ids: Vec<String>,
) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口。
    let pooled = db.pool.get()?;
    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    // 归属校验：重排列表只允许包含该任务现存的子任务，防止越权改写无关行排序
    let existing: std::collections::HashSet<String> = subtask_repo::list_by_task(uow.conn(), task_id)?
        .into_iter()
        .map(|s| s.id)
        .collect();
    if ordered_ids.iter().any(|sid| !existing.contains(sid)) {
        return Err(AppError::Validation(
            "重排序列表包含不属于该任务的子任务".into(),
        ));
    }
    let ts = now();
    for (i, sid) in ordered_ids.iter().enumerate() {
        subtask_repo::set_sort_order(uow.conn(), sid, i as i64, &ts)?;
    }
    uow.audit(
        "UPDATE",
        "task_subtasks",
        format!("reorder task_id={task_id}"),
        file!(),
        line!(),
    );
    uow.commit()?;
    Ok(())
}

/// 删除子任务（硬删）
pub fn delete_subtask(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    // v1.9：迁移到 UnitOfWork，事务边界 + 审计统一收口 + activity_log 纳入同事务。
    let pooled = db.pool.get()?;
    let current = subtask_repo::find_by_id(&pooled, id)
        .map_err(|_| AppError::NotFound("未找到该子任务".into()))?;
    let task_id = current.task_id.clone();
    let title = current.title.clone();
    // 在 delete 之前查 project_id（避免删除后查不到）
    let project_id = task_repo::project_id_of_active(&pooled, &task_id)
        .ok()
        .flatten();

    let mut uow = crate::service::uow::UnitOfWork::new(&pooled, Some(app));
    uow.begin_transaction()?;
    uow.audit(
        "DELETE",
        "task_subtasks",
        format!("id={id}"),
        file!(),
        line!(),
    );
    if subtask_repo::delete(uow.conn(), id)? == 0 {
        return Err(AppError::NotFound("未找到该子任务".into()));
    }
    activity_log_service::try_task_log_with_conn(
        uow.conn(),
        &task_id,
        project_id.as_deref(),
        "subtask.removed",
        &format!("删除清单项「{title}」"),
    )?;
    uow.commit()?;
    Ok(())
}
