//! 任务卡模块 key-value 业务服务（task_meta 表）
//!
//! 通用 get/set + 提醒偏好（JSON 透传存储）。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::task_meta_repo;
use crate::utils::now;
use tauri::AppHandle;

/// 提醒偏好存储 key（值为 JSON 字符串，内容由前端定义）
pub const KEY_REMINDER_PREFS: &str = "taskcard:reminder_prefs";

/// 读取任意 key
pub fn get_meta(_app: &AppHandle, db: &AppDb, key: &str) -> Result<Option<String>, AppError> {
    let conn = db.pool.get()?;
    Ok(task_meta_repo::get(&conn, key)?)
}

/// 写入任意 key
pub fn set_meta(app: &AppHandle, db: &AppDb, key: &str, value: &str) -> Result<(), AppError> {
    let ts = now();
    let conn = db.pool.get()?;
    emit_sql_log(
        app,
        "UPSERT",
        "task_meta",
        &format!("key={key}"),
        file!(),
        line!(),
    );
    task_meta_repo::set(&conn, key, value, &ts)?;
    Ok(())
}

/// 读取提醒偏好（JSON 字符串，默认返回 None）
pub fn get_reminder_prefs(_app: &AppHandle, db: &AppDb) -> Result<Option<String>, AppError> {
    let conn = db.pool.get()?;
    Ok(task_meta_repo::get(&conn, KEY_REMINDER_PREFS)?)
}

/// 保存提醒偏好（JSON 字符串整体覆盖）
pub fn set_reminder_prefs(app: &AppHandle, db: &AppDb, json: &str) -> Result<(), AppError> {
    let ts = now();
    let conn = db.pool.get()?;
    emit_sql_log(
        app,
        "UPSERT",
        "task_meta",
        "key=taskcard:reminder_prefs",
        file!(),
        line!(),
    );
    task_meta_repo::set(&conn, KEY_REMINDER_PREFS, json, &ts)?;
    Ok(())
}
