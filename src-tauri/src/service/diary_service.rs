//! 日记业务服务
//!
//! 封装日记的完整业务逻辑：按月查询、按日获取、保存（新建/覆盖）、删除。
//!
//! ## 设计约定
//!
//! - 每篇日记以 `diary_date`（YYYY-MM-DD）为唯一键，同一天仅保留一篇
//! - 日期格式在前端统一生成，后端做轻量格式校验，避免脏数据入库
//! - 列表查询返回摘要（不含正文），编辑时再按日期加载全文

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Diary, DiaryMeta};
use crate::commands::window::emit_sql_log;
use crate::utils::{now, validate_len, MAX_CHAPTER_CONTENT_LEN};
use crate::repository::diary_repo;

/// 关键字数量上限
const MAX_KEYWORDS_COUNT: usize = 10;
/// 单个关键字长度上限
const MAX_KEYWORD_LEN: usize = 20;

/// 轻量校验 YYYY-MM-DD 格式
fn is_valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes[4] == b'-' && bytes[7] == b'-'
        && (0..10).all(|i| i == 4 || i == 7 || bytes[i].is_ascii_digit())
}

/// 计算某月的查询边界：[月初, 下月初)
fn month_range(year: i64, month: i64) -> (String, String) {
    let start = format!("{year:04}-{month:02}-01");
    let end = if month >= 12 {
        format!("{:04}-01-01", year + 1)
    } else {
        format!("{:04}-{:02}-01", year, month + 1)
    };
    (start, end)
}

/// 列出某年某月的日记摘要（不含正文），按日期升序
pub fn list_month(app: &AppHandle, db: &AppDb, year: i64, month: i64) -> Result<Vec<DiaryMeta>, AppError> {
    if !(1..=12).contains(&month) {
        return Err(AppError::Validation(format!("月份不合法: {month}")));
    }
    let (start, end) = month_range(year, month);
    emit_sql_log(app, "SELECT", "diaries", &format!("{start} <= diary_date < {end}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(diary_repo::list_in_range(&conn, &start, &end)?)
}

/// 列出全部日记摘要（不含正文），按日期升序（书页式「看日记」浏览用）
pub fn list_all(app: &AppHandle, db: &AppDb) -> Result<Vec<DiaryMeta>, AppError> {
    emit_sql_log(app, "SELECT", "diaries", "全部日记摘要", file!(), line!());
    let conn = db.pool.get()?;
    Ok(diary_repo::list_all(&conn)?)
}

/// 按日期获取日记全文，不存在时返回 None
pub fn get_by_date(app: &AppHandle, db: &AppDb, date: &str) -> Result<Option<Diary>, AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!("日期格式不合法: {date}（应为 YYYY-MM-DD）")));
    }
    emit_sql_log(app, "SELECT", "diaries", &format!("diary_date={date}, content_html"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(diary_repo::find_by_date(&conn, date)?)
}

/// 保存日记内容：该日期已有日记则覆盖（保留创建时间），否则新建
pub fn save_diary(
    app: &AppHandle,
    db: &AppDb,
    date: &str,
    content_html: &str,
    word_count: i64,
    keywords: &[String],
) -> Result<Diary, AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!("日期格式不合法: {date}（应为 YYYY-MM-DD）")));
    }
    validate_len("日记内容", content_html, MAX_CHAPTER_CONTENT_LEN)?;
    if keywords.len() > MAX_KEYWORDS_COUNT {
        return Err(AppError::Validation(format!("关键字数量超过上限（{} > {}）", keywords.len(), MAX_KEYWORDS_COUNT)));
    }
    for kw in keywords {
        validate_len("关键字", kw, MAX_KEYWORD_LEN)?;
    }

    let ts = now();
    let keywords_json = serde_json::to_string(keywords)?;
    let conn = db.pool.get()?;

    // 已存在时沿用原 id 与 created_at，保证同一天日记记录的稳定
    let existing = diary_repo::find_by_date(&conn, date)?;
    let (id, _created_at) = match &existing {
        Some(d) => (d.id.clone(), d.created_at.clone()),
        None => (Uuid::new_v4().to_string(), ts.clone()),
    };
    emit_sql_log(
        app,
        "UPSERT",
        "diaries",
        &format!("diary_date={date}, wc={word_count}, keywords={}", keywords_json.len()),
        file!(),
        line!(),
    );
    diary_repo::upsert(&conn, &id, date, content_html, word_count, &keywords_json, &ts)?;

    // 回读保存后的完整记录
    diary_repo::find_by_date(&conn, date)?
        .ok_or_else(|| AppError::Business("日记保存后回读失败".to_string()))
}

/// 按日期删除日记（该日期无日记时静默成功）
pub fn delete_diary(app: &AppHandle, db: &AppDb, date: &str) -> Result<(), AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!("日期格式不合法: {date}（应为 YYYY-MM-DD）")));
    }
    emit_sql_log(app, "DELETE", "diaries", &format!("diary_date={date}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(diary_repo::delete_by_date(&conn, date)?)
}
