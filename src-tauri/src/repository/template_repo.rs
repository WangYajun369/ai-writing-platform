//! 任务模板数据访问层（任务卡 P2）
//!
//! task_templates 表：一键套用创建任务的模板。
//! tag_ids / subtask_titles 以 JSON 数组字符串落库，解析时还原为 Vec<String>。

use crate::models::TaskTemplate;
use rusqlite::{params, Connection, Result};

/// 完整 SELECT 列名
pub const TEMPLATE_SELECT: &str =
    "id,name,project_id,title,description,priority,note,due_offset_days,tag_ids,subtask_titles,created_at,updated_at";

fn parse_str_array(s: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
}

fn to_json_array(items: &[String]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".into())
}

/// 从 rusqlite Row 解析 TaskTemplate（JSON 数组列在此还原）
pub fn parse_template(row: &rusqlite::Row) -> Result<TaskTemplate> {
    let tag_ids: String = row.get("tag_ids")?;
    let subtask_titles: String = row.get("subtask_titles")?;
    Ok(TaskTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        priority: row.get("priority")?,
        note: row.get("note")?,
        due_offset_days: row.get("due_offset_days")?,
        tag_ids: parse_str_array(&tag_ids),
        subtask_titles: parse_str_array(&subtask_titles),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 列出全部模板（按创建时间倒序）
pub fn list_all(conn: &Connection) -> Result<Vec<TaskTemplate>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TEMPLATE_SELECT} FROM task_templates ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([], |row| parse_template(row))?;
    rows.collect()
}

/// 按 id 查询模板
pub fn find_by_id(conn: &Connection, id: &str) -> Result<TaskTemplate> {
    conn.query_row(
        &format!("SELECT {TEMPLATE_SELECT} FROM task_templates WHERE id=?1"),
        params![id],
        |row| parse_template(row),
    )
}

/// 插入模板
pub fn insert(
    conn: &Connection,
    id: &str,
    name: &str,
    project_id: Option<&str>,
    title: &str,
    description: &str,
    priority: &str,
    note: &str,
    due_offset_days: i64,
    tag_ids: &[String],
    subtask_titles: &[String],
    ts: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO task_templates \
            (id,name,project_id,title,description,priority,note,due_offset_days,tag_ids,subtask_titles,created_at,updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
        params![
            id, name, project_id, title, description, priority, note, due_offset_days,
            to_json_array(tag_ids), to_json_array(subtask_titles), ts
        ],
    )?;
    Ok(())
}

/// 局部更新模板（传 None 的字段不改动），返回影响行数
#[allow(clippy::too_many_arguments)]
pub fn update(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    project_id: Option<Option<&str>>,
    title: Option<&str>,
    description: Option<&str>,
    priority: Option<&str>,
    note: Option<&str>,
    due_offset_days: Option<i64>,
    tag_ids: Option<&[String]>,
    subtask_titles: Option<&[String]>,
    ts: &str,
) -> Result<usize> {
    let mut set_clauses: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    macro_rules! push_set {
        ($col:expr, $val:expr) => {{
            set_clauses.push(format!("{} = ?{}", $col, set_clauses.len() + 1));
            param_values.push(Box::new($val) as Box<dyn rusqlite::types::ToSql>);
        }};
    }
    if let Some(v) = name {
        push_set!("name", v.to_string());
    }
    if let Some(v) = project_id {
        push_set!("project_id", v.map(|s| s.to_string()));
    }
    if let Some(v) = title {
        push_set!("title", v.to_string());
    }
    if let Some(v) = description {
        push_set!("description", v.to_string());
    }
    if let Some(v) = priority {
        push_set!("priority", v.to_string());
    }
    if let Some(v) = note {
        push_set!("note", v.to_string());
    }
    if let Some(v) = due_offset_days {
        push_set!("due_offset_days", v);
    }
    if let Some(v) = tag_ids {
        push_set!("tag_ids", to_json_array(v));
    }
    if let Some(v) = subtask_titles {
        push_set!("subtask_titles", to_json_array(v));
    }
    if set_clauses.is_empty() {
        return Ok(0);
    }
    push_set!("updated_at", ts.to_string());
    let sql = format!(
        "UPDATE task_templates SET {} WHERE id=?{}",
        set_clauses.join(", "),
        set_clauses.len() + 1
    );
    param_values.push(Box::new(id.to_string()) as Box<dyn rusqlite::types::ToSql>);
    let params_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, params_refs.as_slice())
}

/// 删除模板
pub fn delete(conn: &Connection, id: &str) -> Result<usize> {
    conn.execute("DELETE FROM task_templates WHERE id=?1", params![id])
}

/// 给任务关联模板中仍然存在的标签（忽略已被删除的标签 id，避免外键报错）
pub fn attach_existing_tags(
    conn: &Connection,
    task_id: &str,
    tag_ids: &[String],
    ts: &str,
) -> Result<()> {
    for tid in tag_ids {
        conn.execute(
            "INSERT OR IGNORE INTO task_tags (task_id, tag_id, created_at) \
             SELECT ?1, id, ?2 FROM tags WHERE id=?3",
            params![task_id, ts, tid],
        )?;
    }
    Ok(())
}
