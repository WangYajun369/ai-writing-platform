//! Agent 记忆体（自 Python agent/memory/ 迁移）
//!
//! 支持三种记忆类型：
//! - preference: 用户偏好（风格、语气、格式偏好）
//! - decision: 决策记录（曾做过什么选择、原因）
//! - lesson: 经验教训（什么有效、什么无效）
//!
//! 数据存放在 time_write.db 的 memories 表；启动时会尝试从旧版
//! Python 库（data/agent_memory.db）一次性导入存量数据。

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 单条记忆（字段 snake_case 与前端 TS 接口保持一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MemoryInfo {
    pub id: i64,
    pub book_id: String,
    pub skill_type: String,
    pub memory_type: String,
    pub content: String,
    pub keywords: String,
    pub relevance_score: f64,
    pub created_at: String,
    pub updated_at: String,
}

/// 记忆列表响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MemoryListResponse {
    pub memories: Vec<MemoryInfo>,
    pub total: usize,
}

// ─── CRUD ───

/// 保存一条记忆，返回自增 ID
pub fn save_memory(
    conn: &Connection,
    book_id: &str,
    skill_type: &str,
    memory_type: &str,
    content: &str,
    keywords: &str,
) -> Result<i64, AppError> {
    conn.execute(
        "INSERT INTO memories (book_id, skill_type, memory_type, content, keywords)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            book_id,
            skill_type,
            memory_type,
            content.trim(),
            keywords.trim()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 查询记忆：按 book_id 必选过滤，可选 skill_type / memory_type
pub fn get_memories(
    conn: &Connection,
    book_id: &str,
    skill_type: Option<&str>,
    memory_type: Option<&str>,
    limit: u32,
) -> Result<Vec<MemoryInfo>, AppError> {
    let mut sql = String::from("SELECT id, book_id, skill_type, memory_type, content, keywords, relevance_score, created_at, updated_at FROM memories WHERE book_id = ?1");
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(book_id.to_string())];
    let mut idx = 2usize;
    if let Some(st) = skill_type {
        sql.push_str(&format!(" AND skill_type = ?{idx}"));
        params.push(Box::new(st.to_string()));
        idx += 1;
    }
    if let Some(mt) = memory_type {
        sql.push_str(&format!(" AND memory_type = ?{idx}"));
        params.push(Box::new(mt.to_string()));
    }
    sql.push_str(" ORDER BY relevance_score DESC, updated_at DESC LIMIT ?");
    sql.push_str(&(limit.to_string()));

    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), row_to_memory)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn row_to_memory(row: &rusqlite::Row) -> rusqlite::Result<MemoryInfo> {
    Ok(MemoryInfo {
        id: row.get(0)?,
        book_id: row.get(1)?,
        skill_type: row.get(2)?,
        memory_type: row.get(3)?,
        content: row.get(4)?,
        keywords: row.get(5)?,
        relevance_score: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// 更新一条记忆的内容/关键词/类型（空值忽略）
pub fn update_memory(
    conn: &Connection,
    memory_id: i64,
    content: Option<&str>,
    keywords: Option<&str>,
    memory_type: Option<&str>,
) -> Result<(), AppError> {
    let mut fields: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(c) = content {
        fields.push("content = ?".to_string());
        params.push(Box::new(c.trim().to_string()));
    }
    if let Some(k) = keywords {
        fields.push("keywords = ?".to_string());
        params.push(Box::new(k.trim().to_string()));
    }
    if let Some(t) = memory_type {
        fields.push("memory_type = ?".to_string());
        params.push(Box::new(t.to_string()));
    }
    if fields.is_empty() {
        return Ok(());
    }
    fields.push("updated_at = datetime('now', 'localtime')".to_string());
    params.push(Box::new(memory_id));
    let sql = format!("UPDATE memories SET {} WHERE id = ?", fields.join(", "));
    conn.execute(&sql, params.iter().map(|b| b.as_ref()).collect::<Vec<_>>().as_slice())?;
    Ok(())
}

/// 删除一条记忆
pub fn delete_memory(conn: &Connection, memory_id: i64) -> Result<(), AppError> {
    conn.execute("DELETE FROM memories WHERE id = ?1", rusqlite::params![memory_id])?;
    Ok(())
}

/// 清空指定书籍的所有记忆，返回删除条数
pub fn clear_memories(conn: &Connection, book_id: &str) -> Result<i64, AppError> {
    let n = conn.execute(
        "DELETE FROM memories WHERE book_id = ?1",
        rusqlite::params![book_id],
    )?;
    Ok(n as i64)
}

/// 记忆总数（可带 book_id 过滤）
#[allow(dead_code)]
pub fn count_memories(conn: &Connection, book_id: Option<&str>) -> Result<i64, AppError> {
    let n: i64 = match book_id {
        Some(bid) => conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE book_id = ?1",
            rusqlite::params![bid],
            |r| r.get(0),
        )?,
        None => conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))?,
    };
    Ok(n)
}

// ─── 关键词提取与规则式记忆提取（自 Python 迁移） ───

/// 简单关键词提取：取长度 >= 2 的连续 CJK/字母数字段的高频词
pub fn extract_keywords(text: &str, max_words: usize) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();

    let is_word_char = |c: char| -> bool {
        matches!(c, '\u{4e00}'..='\u{9fff}') || c.is_ascii_alphanumeric() || c == '_'
    };

    for ch in text.chars() {
        if is_word_char(ch) {
            current.push(ch);
        } else {
            if current.chars().count() >= 2 {
                words.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.chars().count() >= 2 {
        words.push(current);
    }

    let stop_words = [
        "这个", "那个", "什么", "怎么", "可以", "是否", "需要", "已经", "还是", "但是",
        "然后", "一个", "一下", "一些", "不过", "只是", "因为", "所以", "如果", "虽然",
        "the", "is", "a", "an",
    ];
    let filtered: Vec<String> = words
        .into_iter()
        .filter(|w| !stop_words.contains(&w.to_lowercase().as_str()))
        .collect();

    // 频率统计后按出现次数降序取前 max_words 个
    let mut counts: HashMap<String, usize> = HashMap::new();
    for w in filtered {
        *counts.entry(w).or_insert(0) += 1;
    }
    let mut pairs: Vec<(String, usize)> = counts.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    pairs.truncate(max_words);
    pairs.into_iter().map(|(w, _)| w).collect()
}

/// 从对话中按规则提取记忆并保存（不消耗额外 LLM 调用）
pub fn extract_and_save(
    conn: &Connection,
    book_id: &str,
    skill_type: &str,
    user_message: &str,
    assistant_response: &str,
) -> Result<usize, AppError> {
    let mut saved = 0usize;

    // 提取偏好（用户侧）
    let preference_keywords = ["喜欢", "偏好", "习惯", "风格", "语气", "总是", "一直"];
    if preference_keywords.iter().any(|k| user_message.contains(k)) {
        let keywords = extract_keywords(user_message, 5);
        save_memory(
            conn,
            book_id,
            skill_type,
            "preference",
            &user_message.chars().take(300).collect::<String>(),
            &keywords.join(","),
        )?;
        saved += 1;
    }

    // 提取决策（用户侧）
    let decision_keywords = ["决定", "选择", "采用", "就用这个", "按这个来", "确认"];
    if decision_keywords.iter().any(|k| user_message.contains(k)) {
        let keywords = extract_keywords(user_message, 5);
        save_memory(
            conn,
            book_id,
            skill_type,
            "decision",
            &user_message.chars().take(300).collect::<String>(),
            &keywords.join(","),
        )?;
        saved += 1;
    }

    // 提取经验（助手侧）
    let lesson_keywords = ["建议", "注意", "教训", "避免", "推荐", "最好"];
    if lesson_keywords.iter().any(|k| assistant_response.contains(k)) {
        let flat = assistant_response.replace('\n', " ");
        let sentences: Vec<&str> = flat.split('。').collect();
        let mut relevant: Vec<String> = sentences
            .iter()
            .filter(|s| lesson_keywords.iter().any(|k| s.contains(k)))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(3)
            .collect();
        if !relevant.is_empty() {
            let mut content = relevant.join("。");
            content.push('。');
            let keywords = extract_keywords(&content, 5);
            let content = content.chars().take(300).collect::<String>();
            save_memory(
                conn,
                book_id,
                skill_type,
                "lesson",
                &content,
                &keywords.join(","),
            )?;
            saved += 1;
            relevant.clear();
        }
    }

    Ok(saved)
}

// ─── 检索与注入（自 Python memory/retriever.py 迁移） ───

/// 记忆注入的最大 Token 估算上限（中文约 1.5 字符/Token）
const DEFAULT_MAX_TOKENS: usize = 600;

/// 记忆类型加权
fn type_weight(memory_type: &str) -> f64 {
    match memory_type {
        "preference" => 1.2,
        "decision" => 1.0,
        "lesson" => 0.8,
        _ => 1.0,
    }
}

/// 检索相关记忆（候选 → 关键词打分 → 类型加权 → Token 上限裁剪）
pub fn retrieve_memories(
    conn: &Connection,
    book_id: &str,
    skill_type: &str,
    user_message: &str,
    max_tokens: usize,
    top_k: usize,
) -> Vec<MemoryInfo> {
    // 候选：先按 book+skill 精确匹配，无结果则回退到整本书
    let mut candidates = get_memories(conn, book_id, Some(skill_type), None, 50).unwrap_or_default();
    if candidates.is_empty() {
        candidates = get_memories(conn, book_id, None, None, 30).unwrap_or_default();
    }
    if candidates.is_empty() {
        return Vec::new();
    }

    let user_keywords: Vec<String> = extract_keywords(user_message, 10);
    let user_set: std::collections::HashSet<String> = user_keywords.into_iter().collect();

    let mut scored: Vec<(f64, MemoryInfo)> = Vec::new();
    for mem in candidates {
        let score = score_memory(&mem, &user_set);
        if score > 0.0 {
            scored.push((score, mem));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut result: Vec<MemoryInfo> = Vec::new();
    let mut estimated_tokens = 0usize;
    for (_, mem) in scored.into_iter().take(top_k) {
        let mem_tokens = mem.content.chars().count() / 2;
        if estimated_tokens + mem_tokens > max_tokens {
            continue;
        }
        result.push(mem);
        estimated_tokens += mem_tokens;
    }
    result
}

fn score_memory(memory: &MemoryInfo, user_keywords: &std::collections::HashSet<String>) -> f64 {
    let mut score = memory.relevance_score;
    let mem_keywords: std::collections::HashSet<String> = memory
        .keywords
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if !user_keywords.is_empty() && !mem_keywords.is_empty() {
        let overlap = user_keywords.intersection(&mem_keywords).count();
        if overlap > 0 {
            score *= 1.0 + 0.3 * overlap as f64;
        }
    }
    score *= type_weight(&memory.memory_type);
    score
}

/// 生成可注入 System Prompt 的记忆文本（空则返回空串）
pub fn memory_prompt(
    conn: &Connection,
    book_id: &str,
    skill_type: &str,
    user_message: &str,
) -> String {
    let memories = retrieve_memories(conn, book_id, skill_type, user_message, DEFAULT_MAX_TOKENS, 10);
    if memories.is_empty() {
        return String::new();
    }
    let mut lines = String::from("\n## 历史记忆（来自之前的对话）\n");
    for mem in memories {
        let label = match mem.memory_type.as_str() {
            "preference" => "偏好",
            "decision" => "历史决策",
            "lesson" => "经验",
            _ => "记忆",
        };
        lines.push_str(&format!("- [{label}] {}\n", mem.content));
    }
    lines.push('\n');
    lines
}

// ─── 旧版 Python 记忆库一次性迁移 ───

/// 将旧版 Python 库（data/agent_memory.db）的记忆导入 time_write.db。
/// 幂等：目标表已有数据则跳过；旧库不存在则跳过。
pub fn migrate_legacy_db(conn: &Connection, legacy_path: &std::path::Path) -> Result<usize, AppError> {
    if !legacy_path.exists() {
        return Ok(0);
    }
    let existing: i64 =
        conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))?;
    if existing > 0 {
        return Ok(0);
    }

    let legacy = Connection::open(legacy_path)?;
    // 旧库可能没有 memories 表（损坏/空库）
    let table_exists: bool = legacy
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memories'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .map(|n| n > 0)
        .unwrap_or(false);
    if !table_exists {
        return Ok(0);
    }

    let mut stmt = legacy.prepare(
        "SELECT book_id, skill_type, memory_type, content, keywords, relevance_score, created_at, updated_at FROM memories",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;

    let mut imported = 0usize;
    for row in rows {
        let (book_id, skill_type, memory_type, content, keywords, relevance, created_at, updated_at) = row?;
        conn.execute(
            "INSERT INTO memories (book_id, skill_type, memory_type, content, keywords, relevance_score, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![book_id, skill_type, memory_type, content, keywords, relevance, created_at, updated_at],
        )?;
        imported += 1;
    }

    if imported > 0 {
        crate::app_log!(
            "[Agent] ✅ 已从旧记忆库导入 {} 条记忆: {}",
            imported,
            legacy_path.display()
        );
    }
    Ok(imported)
}
