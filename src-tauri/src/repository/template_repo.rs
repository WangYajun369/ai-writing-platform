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
    let rows = stmt.query_map([], parse_template)?;
    rows.collect()
}

/// 按 id 查询模板
pub fn find_by_id(conn: &Connection, id: &str) -> Result<TaskTemplate> {
    conn.query_row(
        &format!("SELECT {TEMPLATE_SELECT} FROM task_templates WHERE id=?1"),
        params![id],
        parse_template,
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
    // 动态 UPDATE 由统一的 DynamicUpdate 构建器生成：仅把传入 Some 的字段纳入更新
    let mut upd = crate::utils::DynamicUpdate::new("task_templates");
    if let Some(v) = name {
        upd.push("name", v.to_string());
    }
    if let Some(v) = project_id {
        upd.push("project_id", v.map(|s| s.to_string()));
    }
    if let Some(v) = title {
        upd.push("title", v.to_string());
    }
    if let Some(v) = description {
        upd.push("description", v.to_string());
    }
    if let Some(v) = priority {
        upd.push("priority", v.to_string());
    }
    if let Some(v) = note {
        upd.push("note", v.to_string());
    }
    if let Some(v) = due_offset_days {
        upd.push("due_offset_days", v);
    }
    if let Some(v) = tag_ids {
        upd.push("tag_ids", to_json_array(v));
    }
    if let Some(v) = subtask_titles {
        upd.push("subtask_titles", to_json_array(v));
    }
    let Some((sql, values)) = upd.build(id, ts) else {
        return Ok(0);
    };
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, params_refs.as_slice())
}

/// 删除模板
pub fn delete(conn: &Connection, id: &str) -> Result<usize> {
    conn.execute("DELETE FROM task_templates WHERE id=?1", params![id])
}

/// 删除指定项目的全部模板（硬删除项目时同事务调用）
///
/// task_templates.project_id 无外键，需显式清理避免孤儿模板。
/// project_id 为 NULL 的全局模板不受影响。
pub fn delete_by_project(conn: &Connection, project_id: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_templates WHERE project_id=?1",
        params![project_id],
    )
}

/// 删除全部已软删项目的模板（清空项目回收站前置调用）
pub fn delete_by_deleted_projects(conn: &Connection) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_templates WHERE project_id IN \
         (SELECT id FROM projects WHERE deleted_at IS NOT NULL)",
        [],
    )
}

/// 删除全部已过期（deleted_at < cutoff）项目的模板（回收站自动清理前置调用）
pub fn delete_by_expired_projects(conn: &Connection, cutoff: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM task_templates WHERE project_id IN \
         (SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?1)",
        params![cutoff],
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at TEXT);
             CREATE TABLE task_templates (
                 id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT,
                 title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
                 priority TEXT NOT NULL DEFAULT 'medium', note TEXT NOT NULL DEFAULT '',
                 due_offset_days INTEGER NOT NULL DEFAULT 0, tag_ids TEXT NOT NULL DEFAULT '[]',
                 subtask_titles TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    fn insert_template(conn: &Connection, id: &str, project_id: Option<&str>) {
        conn.execute(
            "INSERT INTO task_templates (id, name, project_id, created_at, updated_at) \
             VALUES (?1, 'tpl', ?2, 'ts', 'ts')",
            params![id, project_id],
        )
        .unwrap();
    }

    #[test]
    fn delete_by_project_removes_only_project_templates() {
        let conn = setup();
        // 项目专属模板
        insert_template(&conn, "tpl1", Some("p1"));
        insert_template(&conn, "tpl2", Some("p1"));
        // 全局模板（project_id = NULL）应保留
        insert_template(&conn, "tpl3", None);
        // 其他项目模板应保留
        insert_template(&conn, "tpl4", Some("p2"));

        let n = delete_by_project(&conn, "p1").unwrap();
        assert_eq!(n, 2);

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_templates", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 2, "全局模板 + 其他项目模板保留");
    }

    #[test]
    fn delete_by_deleted_projects_cleans_orphan_templates() {
        let conn = setup();
        conn.execute(
            "INSERT INTO projects (id, deleted_at) VALUES ('p1', '2026-01-01')",
            [],
        )
        .unwrap();
        insert_template(&conn, "tpl1", Some("p1"));
        // 活跃项目的模板不受影响
        conn.execute("INSERT INTO projects (id) VALUES ('p2')", [])
            .unwrap();
        insert_template(&conn, "tpl2", Some("p2"));

        let n = delete_by_deleted_projects(&conn).unwrap();
        assert_eq!(n, 1);
    }
}
