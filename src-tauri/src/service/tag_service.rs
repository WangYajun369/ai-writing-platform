//! 标签业务服务（任务卡模块）

use tauri::AppHandle;
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Tag;
use crate::commands::window::emit_sql_log;
use crate::utils::{now, validate_len};
use crate::repository::tag_repo;

/// 标签名长度上限
pub const MAX_TAG_NAME: usize = 50;
/// 标签状态合法取值
const VALID_STATUS: [&str; 2] = ["enabled", "disabled"];

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTagParams {
    pub name: Option<String>,
    pub color: Option<String>,
    pub status: Option<String>,
}

/// 列出全部标签
pub fn list_tags(app: &AppHandle, db: &AppDb) -> Result<Vec<Tag>, AppError> {
    emit_sql_log(app, "SELECT", "tags", "all", file!(), line!());
    let conn = db.pool.get()?;
    Ok(tag_repo::list_all(&conn)?)
}

/// 校验标签名：非空、长度合法、唯一（可排除自身）
fn validate_name(
    conn: &rusqlite::Connection,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("标签名不能为空".into()));
    }
    validate_len("标签名", name, MAX_TAG_NAME)?;
    if let Some(existing) = tag_repo::find_by_name(conn, name)? {
        if exclude_id != Some(existing.id.as_str()) {
            return Err(AppError::Business("已存在同名标签".into()));
        }
    }
    Ok(name.to_string())
}

/// 创建标签（默认启用）
pub fn create_tag(app: &AppHandle, db: &AppDb, name: &str, color: &str) -> Result<Tag, AppError> {
    let ts = now();
    let conn = db.pool.get()?;
    let name = validate_name(&conn, name, None)?;
    let color = color.trim().to_string();
    let id = Uuid::new_v4().to_string();
    emit_sql_log(app, "INSERT", "tags", &format!("id={id}, name={name}"), file!(), line!());
    tag_repo::insert(&conn, &id, &name, &color, &ts)?;
    Ok(tag_repo::find_by_id(&conn, &id)?
        .ok_or_else(|| AppError::General("创建标签后读取失败".into()))?)
}

/// 更新标签（名称/颜色/停启用）
pub fn update_tag(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    params: UpdateTagParams,
) -> Result<Tag, AppError> {
    let conn = db.pool.get()?;
    let existing = tag_repo::find_by_id(&conn, id)?
        .ok_or_else(|| AppError::NotFound("未找到该标签".into()))?;

    let mut name = existing.name;
    let mut color = existing.color;
    let mut status = existing.status;

    if let Some(n) = params.name {
        name = validate_name(&conn, &n, Some(id))?;
    }
    if let Some(c) = params.color {
        color = c.trim().to_string();
    }
    if let Some(s) = params.status {
        if !VALID_STATUS.contains(&s.as_str()) {
            return Err(AppError::Validation(format!("无效的标签状态: {s}")));
        }
        status = s;
    }

    let ts = now();
    emit_sql_log(app, "UPDATE", "tags", &format!("id={id}"), file!(), line!());
    tag_repo::update(&conn, id, &name, &color, &status, &ts)?;
    Ok(tag_repo::find_by_id(&conn, id)?
        .ok_or_else(|| AppError::General("更新标签后读取失败".into()))?)
}

/// 删除标签（返回被移除的关联数；task_tags 由外键级联清理）
pub fn delete_tag(app: &AppHandle, db: &AppDb, id: &str) -> Result<i64, AppError> {
    let conn = db.pool.get()?;
    let usage = tag_repo::usage_count(&conn, id)?;
    emit_sql_log(app, "DELETE", "tags", &format!("id={id}, usage={usage}"), file!(), line!());
    tag_repo::delete(&conn, id)?;
    Ok(usage)
}
