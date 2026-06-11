//! 世界观卡片数据访问层
//!
//! 提供 world_cards 表的 CRUD SQL 操作及 FTS5 全文搜索。

use rusqlite::{Connection, params, Result};
use crate::models::WorldCard;

/// 从 row 解析 WorldCard（列顺序固定）
pub fn parse_world_card(row: &rusqlite::Row) -> Result<WorldCard> {
    let tags_str: String = row.get(6)?;
    let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
    Ok(WorldCard {
        id: row.get(0)?,
        book_id: row.get(1)?,
        card_type: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        content_html: row.get(5)?,
        tags,
        vectorized: row.get::<_, i64>(7)? == 1,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// 列出所有世界观卡片，用于备份导出
pub fn list_all(conn: &Connection) -> Result<Vec<WorldCard>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards"
    )?;
    let items = stmt.query_map([], |row| parse_world_card(row))?;
    items.collect()
}

/// 列出指定书籍的所有世界观卡片，按 updated_at 降序
pub fn list_by_book(conn: &Connection, book_id: &str) -> Result<Vec<WorldCard>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards WHERE book_id=?1 ORDER BY updated_at DESC"
    )?;
    let items = stmt.query_map(params![book_id], |row| parse_world_card(row))?;
    items.collect()
}

/// 根据 ID 查询单张卡片
pub fn find_by_id(conn: &Connection, id: &str) -> Result<WorldCard> {
    conn.query_row(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards WHERE id=?1",
        params![id],
        |row| parse_world_card(row),
    )
}

/// 插入新卡片
pub fn insert(
    conn: &Connection,
    id: &str,
    book_id: &str,
    card_type: &str,
    title: &str,
    content: &str,
    content_html: &str,
    tags_json: &str,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO world_cards (id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9)",
        params![id, book_id, card_type, title, content, content_html, tags_json, created_at, created_at],
    )?;
    Ok(())
}

#[allow(dead_code)]
/// 动态更新字段
pub fn update_fields_dynamic(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<()> {
    conn.execute(sql, params)?;
    Ok(())
}

/// 删除卡片
pub fn delete(conn: &Connection, id: &str) -> Result<usize> {
    conn.execute("DELETE FROM world_cards WHERE id=?1", params![id])
}

/// 标记卡片为已向量化
pub fn mark_vectorized(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("UPDATE world_cards SET vectorized = 1 WHERE id = ?1", params![id])?;
    Ok(())
}

/// FTS5 搜索世界观卡片
pub fn search_fts5(
    conn: &Connection,
    book_id: &str,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<WorldCard>> {
    let sql = "SELECT w.id,w.book_id,w.type,w.title,w.content,w.content_html,w.tags,w.vectorized,w.created_at,w.updated_at \
               FROM world_cards w INNER JOIN world_cards_fts fts ON w.rowid = fts.rowid \
               WHERE w.book_id=?1 AND world_cards_fts MATCH ?2 ORDER BY rank LIMIT ?3";
    let mut stmt = conn.prepare(sql)?;
    let items = stmt.query_map(params![book_id, fts_query, limit as i64], |row| parse_world_card(row))?;
    items.collect()
}

/// LIKE 降级搜索世界观卡片
pub fn search_like(
    conn: &Connection,
    book_id: &str,
    pattern: &str,
    limit: usize,
) -> Result<Vec<WorldCard>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards WHERE book_id=?1 AND (title LIKE ?2 OR content LIKE ?2) ORDER BY updated_at DESC LIMIT ?3"
    )?;
    let items = stmt.query_map(params![book_id, pattern, limit as i64], |row| parse_world_card(row))?;
    items.collect()
}

/// 统计有内容的卡片数
pub fn count_with_content(conn: &Connection, book_id: &str) -> Result<usize> {
    conn.query_row(
        "SELECT COUNT(*) FROM world_cards WHERE book_id = ?1 AND content_html != ''",
        params![book_id],
        |row| row.get::<_, i64>(0).map(|v| v as usize),
    )
}

/// 列出卡片 ID + content_html（用于 embedding 生成）
pub fn list_ids_and_content_plain(conn: &Connection, book_id: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, content_html FROM world_cards WHERE book_id = ?1 AND content_html != ''"
    )?;
    let items = stmt.query_map(params![book_id], |row| {
        let id: String = row.get(0)?;
        let html: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
        Ok((id, html))
    })?;
    items.collect::<Result<Vec<_>, _>>()
}

// ---- FTS5/LIKE 纯文本搜索（返回 id, title, content_html，供搜索服务使用） ----

/// FTS5 搜索世界观卡片（返回 id, title, content_html）
pub fn search_fts5_plain(
    conn: &Connection,
    book_id: &str,
    fts_query: &str,
    limit: i64,
) -> Result<Vec<(String, String, String)>> {
    let sql = "SELECT w.id, w.title, w.content_html FROM world_cards w \
               INNER JOIN world_cards_fts fts ON w.rowid = fts.rowid \
               WHERE w.book_id=?1 AND world_cards_fts MATCH ?2 LIMIT ?3";
    let mut stmt = conn.prepare(sql)?;
    let results = stmt.query_map(
        params![book_id, fts_query, limit],
        |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let html: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
            Ok((id, title, html))
        },
    )?;
    results.collect::<Result<Vec<_>, _>>()
}

/// LIKE 降级搜索世界观卡片
pub fn search_like_plain(
    conn: &Connection,
    book_id: &str,
    pattern: &str,
    limit: i64,
) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, content_html FROM world_cards
         WHERE book_id=?1 AND content_html LIKE ?2 LIMIT ?3"
    )?;
    let results = stmt.query_map(
        params![book_id, pattern, limit],
        |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let html: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
            Ok((id, title, html))
        },
    )?;
    results.collect::<Result<Vec<_>, _>>()
}
