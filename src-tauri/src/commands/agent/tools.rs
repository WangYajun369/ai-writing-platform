//! Agent 数据库工具（自 Python agent/tools/db_tools.py 迁移）
//!
//! 原实现通过 HTTP 回调 Rust Bridge(9876) 获取数据；迁移后直接在 Rust
//! 内访问 SQLite（repository 层），消除中间网络跳转，输出格式保持一致。

use rusqlite::Connection;
use serde_json::Value;

use crate::error::AppError;
use crate::repository;

/// 单次工具执行的最大内容长度（防御异常数据）
const MAX_TOOL_CONTENT_CHARS: usize = 200_000;

/// Skill → 工具子集映射（与 Python SKILL_TOOLS_MAP 一致）
pub fn tools_for_skill(skill: &str) -> Vec<&'static str> {
    match skill {
        "writing" => vec![
            "read_chapter_summary",
            "read_chapter_chunk",
            "list_book_chapters",
            "search_world_cards",
            "get_book_context",
        ],
        "analysis" => vec![
            "read_chapter",
            "read_chapter_chunk",
            "list_book_chapters",
            "search_world_cards",
            "get_book_context",
        ],
        "research" => vec![
            "read_chapter_summary",
            "list_book_chapters",
            "search_world_cards",
            "get_book_context",
        ],
        "polish" => vec!["read_chapter", "read_chapter_chunk", "get_book_context"],
        _ => vec![
            "read_chapter_summary",
            "read_chapter_chunk",
            "list_book_chapters",
            "search_world_cards",
            "get_book_context",
        ],
    }
}

/// 生成 OpenAI function calling 的 tools 参数
pub fn build_tools_schema(skill: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for name in tools_for_skill(skill) {
        if let Some(schema) = tool_schema(name) {
            out.push(serde_json::json!({
                "type": "function",
                "function": schema,
            }));
        }
    }
    out
}

fn params_obj(props: Value, required: Vec<&str>) -> Value {
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": required,
    })
}

/// 单个工具的定义（name / description / parameters）
fn tool_schema(name: &str) -> Option<Value> {
    let id_schema = |desc: &str| serde_json::json!({"type": "string", "description": desc});
    match name {
        "read_chapter" => Some(serde_json::json!({
            "name": "read_chapter",
            "description": "读取指定章节的完整内容（含标题和摘要）。注意：如果章节内容很长（超过 3000 字），建议先使用 read_chapter_summary 查看摘要，再用 read_chapter_chunk 分页读取。",
            "parameters": params_obj(serde_json::json!({
                "book_id": id_schema("书籍 ID"),
                "chapter_id": id_schema("章节 ID"),
            }), vec!["book_id", "chapter_id"]),
        })),
        "read_chapter_summary" => Some(serde_json::json!({
            "name": "read_chapter_summary",
            "description": "读取指定章节的摘要信息（不含正文），节省 Token。在需要了解章节内容但不需逐字分析时优先使用此工具。",
            "parameters": params_obj(serde_json::json!({
                "book_id": id_schema("书籍 ID"),
                "chapter_id": id_schema("章节 ID"),
            }), vec!["book_id", "chapter_id"]),
        })),
        "read_chapter_chunk" => Some(serde_json::json!({
            "name": "read_chapter_chunk",
            "description": "分页读取章节内容，适用于大章节分段分析。每次只读取指定的一段内容，大幅减少单次 Token 消耗。",
            "parameters": params_obj(serde_json::json!({
                "book_id": id_schema("书籍 ID"),
                "chapter_id": id_schema("章节 ID"),
                "chunk_index": {"type": "integer", "description": "分段索引，从 0 开始", "default": 0},
                "chunk_size": {"type": "integer", "description": "每段字符数，默认 2000", "default": 2000},
            }), vec!["book_id", "chapter_id"]),
        })),
        "list_book_chapters" => Some(serde_json::json!({
            "name": "list_book_chapters",
            "description": "列出指定书籍的所有章节（标题+摘要，不含正文）。",
            "parameters": params_obj(serde_json::json!({
                "book_id": id_schema("书籍 ID"),
            }), vec!["book_id"]),
        })),
        "search_world_cards" => Some(serde_json::json!({
            "name": "search_world_cards",
            "description": "搜索世界观卡片（角色、地点、设定等）。为节省 Token，最多返回 5 条结果，每条内容截断 300 字。如需更多详情，请缩小搜索范围或指定更精确的关键词。",
            "parameters": params_obj(serde_json::json!({
                "book_id": id_schema("书籍 ID"),
                "query": {"type": "string", "description": "搜索关键词"},
            }), vec!["book_id", "query"]),
        })),
        "get_book_context" => Some(serde_json::json!({
            "name": "get_book_context",
            "description": "获取整本书的创作上下文（最近章节摘要+世界观概览）。",
            "parameters": params_obj(serde_json::json!({
                "book_id": id_schema("书籍 ID"),
            }), vec!["book_id"]),
        })),
        _ => None,
    }
}

/// 截断过长的工具结果，防止异常数据撑爆上下文
fn clamp(s: &str) -> String {
    if s.chars().count() > MAX_TOOL_CONTENT_CHARS {
        let mut out: String = s.chars().take(MAX_TOOL_CONTENT_CHARS).collect();
        out.push_str("\n...[内容过长，已截断]");
        out
    } else {
        s.to_string()
    }
}

/// 执行指定工具，返回注入给模型的文本结果
pub fn execute_tool(conn: &Connection, name: &str, args: &Value) -> Result<String, AppError> {
    let result = match name {
        "read_chapter" => tool_read_chapter(conn, args)?,
        "read_chapter_summary" => tool_read_chapter_summary(conn, args)?,
        "read_chapter_chunk" => tool_read_chapter_chunk(conn, args)?,
        "list_book_chapters" => tool_list_book_chapters(conn, args)?,
        "search_world_cards" => tool_search_world_cards(conn, args)?,
        "get_book_context" => tool_get_book_context(conn, args)?,
        other => return Err(AppError::Business(format!("未知工具: {other}"))),
    };
    Ok(clamp(&result))
}

/// 获取章节数据（id / title / content / summary）
fn load_chapter(
    conn: &Connection,
    book_id: &str,
    chapter_id: &str,
) -> Result<(String, String, String, Option<String>), AppError> {
    let chapters = repository::chapter_repo::list_by_book(conn, book_id)?;
    let chapter = chapters
        .iter()
        .find(|c| c.id == chapter_id)
        .ok_or_else(|| AppError::Business(format!("章节 {chapter_id} 不存在")))?;
    let content = repository::chapter_repo::find_content(conn, chapter_id)?;
    Ok((
        chapter.id.clone(),
        chapter.title.clone(),
        content,
        chapter.summary.clone(),
    ))
}

fn tool_read_chapter(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapter_id = args["chapter_id"].as_str().unwrap_or("");
    let (_, title, content, summary) = load_chapter(conn, book_id, chapter_id)?;

    let mut parts = vec![format!("# {title}")];
    if let Some(s) = summary {
        if !s.is_empty() {
            parts.push(format!("\n> 摘要：{s}"));
        }
    }
    parts.push(format!("\n{content}"));
    Ok(parts.join("\n"))
}

fn tool_read_chapter_summary(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapter_id = args["chapter_id"].as_str().unwrap_or("");
    let (_, title, content, summary) = load_chapter(conn, book_id, chapter_id)?;

    let mut parts = vec![format!("## {title}")];
    match summary {
        Some(s) if !s.is_empty() => parts.push(format!("\n摘要：{s}")),
        _ => {
            let preview: String = content.chars().take(500).collect();
            parts.push(format!("\n内容预览（前500字）：{preview}..."));
        }
    }
    Ok(parts.join("\n"))
}

fn tool_read_chapter_chunk(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapter_id = args["chapter_id"].as_str().unwrap_or("");
    let chunk_index = args["chunk_index"].as_i64().unwrap_or(0);
    let chunk_size = args["chunk_size"].as_i64().unwrap_or(2000).max(100) as usize;

    let (_, title, content, summary) = load_chapter(conn, book_id, chapter_id)?;
    let chars: Vec<char> = content.chars().collect();
    let total_len = chars.len();
    let total_chunks = if total_len == 0 {
        0
    } else {
        (total_len + chunk_size - 1) / chunk_size
    };

    if chunk_index < 0 || chunk_index as usize >= total_chunks || total_chunks == 0 {
        let err = serde_json::json!({
            "error": "chunk_index 超出范围",
            "total_chunks": total_chunks,
            "valid_range": if total_chunks > 0 { format!("0 ~ {}", total_chunks - 1) } else { "0 ~ 0".to_string() },
        });
        return Ok(err.to_string());
    }

    let ci = chunk_index as usize;
    let start = ci * chunk_size;
    let end = (start + chunk_size).min(total_len);
    let chunk_text: String = chars[start..end].iter().collect();

    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = summary {
        if !s.is_empty() {
            parts.push(format!("> 全文摘要：{s}"));
        }
    }
    parts.push(format!("# {title} (第 {} / {total_chunks} 段)", ci + 1));
    parts.push(format!("字符范围: {} ~ {} / {total_len}", start + 1, end));
    parts.push(format!("\n{chunk_text}"));
    if ci < total_chunks - 1 {
        parts.push(format!(
            "\n---\n💡 还有 {} 段未读取，可使用 chunk_index={} 继续读取",
            total_chunks - ci - 1,
            ci + 1
        ));
    }
    Ok(parts.join("\n"))
}

fn tool_list_book_chapters(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapters = repository::chapter_repo::list_by_book(conn, book_id)?;

    let list: Vec<Value> = chapters
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "title": c.title,
                "summary": c.summary,
            })
        })
        .collect();
    Ok(serde_json::to_string_pretty(&list)?)
}

fn tool_search_world_cards(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let query = args["query"].as_str().unwrap_or("");

    let cards =
        repository::world_card_repo::search_fts5(conn, book_id, query, 20).or_else(|_| {
            repository::world_card_repo::search_like(conn, book_id, &format!("%{query}%"), 20)
        })?;

    const MAX_RESULTS: usize = 5;
    const CONTENT_TRUNCATE: usize = 300;

    let mut truncated: Vec<Value> = Vec::new();
    for c in cards.iter().take(MAX_RESULTS) {
        let content: String = c.content.chars().take(CONTENT_TRUNCATE).collect();
        let content = if c.content.chars().count() > CONTENT_TRUNCATE {
            format!("{content}...")
        } else {
            content
        };
        truncated.push(serde_json::json!({
            "id": c.id,
            "name": c.title,
            "category": c.card_type,
            "content": content,
            "tags": c.tags,
        }));
    }

    let mut result_obj = serde_json::json!({
        "total": cards.len(),
        "shown": truncated.len(),
        "cards": truncated,
    });
    if cards.len() > MAX_RESULTS {
        result_obj["hint"] = serde_json::json!(format!(
            "还有 {} 条结果未显示，请使用更精确的关键词缩小范围",
            cards.len() - MAX_RESULTS
        ));
    }
    Ok(serde_json::to_string_pretty(&result_obj)?)
}

fn tool_get_book_context(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let book = repository::book_repo::find_by_id(conn, book_id)?;
    let chapters = repository::chapter_repo::list_by_book(conn, book_id)?;
    let cards = repository::world_card_repo::list_by_book(conn, book_id)?;

    let mut parts = vec![format!("# 《{}》创作上下文\n", book.title)];

    if !chapters.is_empty() {
        parts.push("## 最近章节".to_string());
        for ch in chapters.iter().rev().take(5).rev() {
            let summary = ch.summary.as_deref().unwrap_or("(无摘要)");
            parts.push(format!("- {}: {}", ch.title, summary));
        }
    }

    if !cards.is_empty() {
        parts.push("\n## 世界观设定".to_string());
        for wc in cards.iter() {
            let mut content: String = wc.content.chars().take(200).collect();
            if wc.content.chars().count() > 200 {
                content.push_str("...");
            }
            parts.push(format!("- [{}] {}: {}", wc.card_type, wc.title, content));
        }
    }

    Ok(parts.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与生产 schema 一致的 books / chapters / world_cards 表（db/mod.rs 同款 DDL）
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '', cover_image TEXT,
                word_count INTEGER NOT NULL DEFAULT 0, daily_target INTEGER NOT NULL DEFAULT 0,
                today_count INTEGER NOT NULL DEFAULT 0, db_path TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, outline TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE chapters (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                volume_id TEXT, title TEXT NOT NULL, content_html TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
                sort_order INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                summary TEXT, summary_at TEXT, outline TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE world_cards (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'misc',
                title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
                content_html TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                vectorized INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            "#,
        )
        .expect("create test schema");
        conn.execute(
            "INSERT INTO books (id, title, created_at, updated_at) VALUES ('b1', '测试书', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        // c1：有摘要的短章；c2：无摘要的长章（5000 字，供分页测试）；c3：已删除章节
        conn.execute(
            "INSERT INTO chapters (id, book_id, title, content_html, sort_order, created_at, updated_at, summary)
             VALUES ('c1', 'b1', '第一章', '<p>正文一</p>', 0, '2026-01-01', '2026-01-01', '本章摘要')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, book_id, title, content_html, sort_order, created_at, updated_at)
             VALUES ('c2', 'b1', '第二章', ?1, 1, '2026-01-01', '2026-01-01')",
            rusqlite::params!["字".repeat(5000)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, book_id, title, sort_order, deleted_at, created_at, updated_at)
             VALUES ('c3', 'b1', '已删章', 2, '2026-01-02', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO world_cards (id, book_id, type, title, content, created_at, updated_at)
             VALUES ('w1', 'b1', 'char', '林雪', '冷静的女剑客', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn skill_tool_mapping_and_schemas() {
        assert_eq!(tools_for_skill("polish").len(), 3);
        assert_eq!(tools_for_skill("research").len(), 4);
        // 未知 skill 回退默认五工具
        assert_eq!(tools_for_skill("no_such").len(), 5);
        // 每个映射工具都必须有 schema 定义
        for skill in ["writing", "analysis", "research", "polish"] {
            for name in tools_for_skill(skill) {
                assert!(tool_schema(name).is_some(), "{skill} 的工具 {name} 缺少 schema");
            }
        }
        // schema 结构符合 OpenAI function calling 契约
        let schemas = build_tools_schema("research");
        assert_eq!(schemas.len(), 4);
        for s in &schemas {
            assert_eq!(s["type"], "function");
            assert!(s["function"]["name"].as_str().is_some());
            assert_eq!(s["function"]["parameters"]["type"], "object");
        }
    }

    #[test]
    fn clamp_truncates_long_results() {
        let short = "短内容";
        assert_eq!(clamp(short), short);

        let long = "字".repeat(MAX_TOOL_CONTENT_CHARS + 10);
        let out = clamp(&long);
        assert!(out.starts_with(&"字".repeat(MAX_TOOL_CONTENT_CHARS)));
        assert!(out.contains("已截断"));
        // 截断后长度 = 上限 + 截断标记
        assert_eq!(
            out.chars().count(),
            MAX_TOOL_CONTENT_CHARS + "\n...[内容过长，已截断]".chars().count()
        );
    }

    #[test]
    fn unknown_tool_rejected() {
        let conn = test_conn();
        let err = execute_tool(&conn, "delete_everything", &serde_json::json!({})).unwrap_err();
        assert!(err.to_string().contains("未知工具"), "{err}");
    }

    #[test]
    fn read_chapter_full_and_summary_preview() {
        let conn = test_conn();
        // 有摘要：标题 + 摘要 + 正文
        let out = execute_tool(
            &conn,
            "read_chapter",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c1"}),
        )
        .unwrap();
        assert!(out.contains("# 第一章"));
        assert!(out.contains("摘要：本章摘要"));
        assert!(out.contains("<p>正文一</p>"));

        // 无摘要：回退 500 字内容预览
        let out = execute_tool(
            &conn,
            "read_chapter_summary",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2"}),
        )
        .unwrap();
        assert!(out.contains("内容预览（前500字）"));

        // 不存在的章节
        let err = execute_tool(
            &conn,
            "read_chapter",
            &serde_json::json!({"book_id": "b1", "chapter_id": "nope"}),
        )
        .unwrap_err();
        assert!(err.to_string().contains("不存在"), "{err}");
    }

    #[test]
    fn read_chapter_chunk_paging_and_bounds() {
        let conn = test_conn();
        // 5000 字 / 2000 = 3 段；首页含导航提示
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 0}),
        )
        .unwrap();
        assert!(out.contains("第 1 / 3 段"), "{out}");
        assert!(out.contains("chunk_index=1"), "应提示下一段: {out}");

        // 末页不再有导航提示
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 2}),
        )
        .unwrap();
        assert!(out.contains("第 3 / 3 段"));
        assert!(!out.contains("还有"), "末段不应有续读提示");

        // 越界返回结构化错误（非 Err）
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 9}),
        )
        .unwrap();
        assert!(out.contains("chunk_index 超出范围"), "{out}");
        assert!(out.contains("\"total_chunks\":3"), "{out}");

        // chunk_size 下限 100：5000 / 100 = 50 段
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 0, "chunk_size": 10}),
        )
        .unwrap();
        assert!(out.contains("第 1 / 50 段"), "{out}");
    }

    #[test]
    fn list_chapters_excludes_deleted() {
        let conn = test_conn();
        let out = execute_tool(
            &conn,
            "list_book_chapters",
            &serde_json::json!({"book_id": "b1"}),
        )
        .unwrap();
        let list: Vec<Value> = serde_json::from_str(&out).unwrap();
        assert_eq!(list.len(), 2, "已删除章节不应列出: {out}");
        assert!(out.contains("第一章"));
        assert!(!out.contains("已删章"));
    }

    #[test]
    fn search_world_cards_like_fallback() {
        let conn = test_conn(); // 无 FTS5 表 → search_fts5 失败 → 降级 LIKE
        let out = execute_tool(
            &conn,
            "search_world_cards",
            &serde_json::json!({"book_id": "b1", "query": "林雪"}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["total"], 1);
        assert_eq!(obj["cards"][0]["name"], "林雪");

        // 无命中
        let out = execute_tool(
            &conn,
            "search_world_cards",
            &serde_json::json!({"book_id": "b1", "query": "不存在的人"}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["total"], 0);
    }

    #[test]
    fn get_book_context_overview() {
        let conn = test_conn();
        let out = execute_tool(
            &conn,
            "get_book_context",
            &serde_json::json!({"book_id": "b1"}),
        )
        .unwrap();
        assert!(out.contains("《测试书》"));
        assert!(out.contains("第一章: 本章摘要"));
        assert!(out.contains("第二章: (无摘要)"));
        assert!(out.contains("[char] 林雪: 冷静的女剑客"));
    }
}
