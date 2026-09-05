//! 日程业务服务
//!
//! 封装日程的完整业务逻辑：按日期查询、保存（新建/更新）、删除。
//!
//! ## 设计约定
//! - 每条日程归属某一天（schedule_date，YYYY-MM-DD）
//! - 同一日期下可存在多条日程
//! - 日期格式在前端统一生成，后端做轻量格式校验

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Schedule;
use crate::repository::schedule_repo;
use crate::utils::now;
use tauri::AppHandle;
use uuid::Uuid;

/// 单条日程内容长度上限
const MAX_SCHEDULE_CONTENT_LEN: usize = 500;

/// 轻量校验 YYYY-MM-DD 格式
fn is_valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && (0..10).all(|i| i == 4 || i == 7 || bytes[i].is_ascii_digit())
}

/// 校验日程内容
fn validate_content(content: &str) -> Result<(), AppError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("日程内容不能为空".to_string()));
    }
    if trimmed.chars().count() > MAX_SCHEDULE_CONTENT_LEN {
        return Err(AppError::Validation(format!(
            "日程内容不能超过 {} 字",
            MAX_SCHEDULE_CONTENT_LEN
        )));
    }
    Ok(())
}

/// 列出某日期下的全部日程，按创建时间升序
pub fn list_by_date(app: &AppHandle, db: &AppDb, date: &str) -> Result<Vec<Schedule>, AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!(
            "日期格式不合法: {date}（应为 YYYY-MM-DD）"
        )));
    }
    emit_sql_log(
        app,
        "SELECT",
        "schedules",
        &format!("schedule_date={date}"),
        file!(),
        line!(),
    );
    let conn = db.pool.get()?;
    Ok(schedule_repo::list_by_date(&conn, date)?)
}

/// 列出某年（1-12 月）下的全部日程，按日期 + 创建时间升序
pub fn list_by_month(
    app: &AppHandle,
    db: &AppDb,
    year: i32,
    month: i32,
) -> Result<Vec<Schedule>, AppError> {
    if !(1..=12).contains(&month) {
        return Err(AppError::Validation(format!(
            "月份不合法: {month}（应为 1-12）"
        )));
    }
    let prefix = format!("{year:04}-{month:02}");
    emit_sql_log(
        app,
        "SELECT",
        "schedules",
        &format!("schedule_date LIKE {prefix}-%"),
        file!(),
        line!(),
    );
    let conn = db.pool.get()?;
    Ok(schedule_repo::list_by_month(&conn, &prefix)?)
}

/// 保存日程：id 存在则更新，否则新建；返回保存后的完整记录
pub fn save_schedule(
    app: &AppHandle,
    db: &AppDb,
    id: Option<String>,
    date: &str,
    content: &str,
    done: bool,
) -> Result<Schedule, AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!(
            "日期格式不合法: {date}（应为 YYYY-MM-DD）"
        )));
    }
    validate_content(content)?;

    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let ts = now();
    let done_i64 = if done { 1 } else { 0 };

    emit_sql_log(
        app,
        "UPSERT",
        "schedules",
        &format!("id={id}, schedule_date={date}, done={done_i64}"),
        file!(),
        line!(),
    );

    let conn = db.pool.get()?;
    Ok(schedule_repo::save(
        &conn,
        &id,
        date,
        content.trim(),
        done_i64,
        &ts,
    )?)
}

/// 按 id 删除日程（不存在时静默成功）
pub fn delete_schedule(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    emit_sql_log(
        app,
        "DELETE",
        "schedules",
        &format!("id={id}"),
        file!(),
        line!(),
    );
    let conn = db.pool.get()?;
    Ok(schedule_repo::delete_by_id(&conn, id)?)
}
