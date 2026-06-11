//! Embedding 数据访问层
//!
//! 提供 embeddings 表的 SQL 操作。

use rusqlite::{Connection, params, Result};

/// 统计指定书籍已索引的 embedding 总量
pub fn count_indexed_for_book(conn: &Connection, book_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT (
            SELECT COUNT(*) FROM embeddings e
            INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
            WHERE c.book_id = ?1 AND c.deleted_at IS NULL AND c.content_html != ''
        ) + (
            SELECT COUNT(*) FROM embeddings e
            INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
            WHERE w.book_id = ?1 AND w.content_html != ''
        )",
        params![book_id],
        |row| row.get(0),
    )
}

/// 统计已索引的章节 embedding 数
pub fn count_indexed_chapters(conn: &Connection, book_id: &str) -> Result<usize> {
    conn.query_row(
        "SELECT COUNT(*) FROM embeddings e
         INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
         WHERE c.book_id = ?1 AND c.deleted_at IS NULL AND c.content_html != ''",
        params![book_id],
        |row| row.get::<_, i64>(0).map(|v| v as usize),
    )
}

/// 统计已索引的世界观卡片 embedding 数
pub fn count_indexed_world_cards(conn: &Connection, book_id: &str) -> Result<usize> {
    conn.query_row(
        "SELECT COUNT(*) FROM embeddings e
         INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
         WHERE w.book_id = ?1 AND w.content_html != ''",
        params![book_id],
        |row| row.get::<_, i64>(0).map(|v| v as usize),
    )
}

/// 列出所有 embedding 元数据（不含 BLOB），用于备份导出
pub fn list_all_meta(conn: &Connection) -> Result<Vec<(String, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT source_type, source_id, COALESCE(model, '') as model, COALESCE(created_at, '') as created_at FROM embeddings"
    )?;
    let items = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    items.collect::<Result<Vec<_>, _>>()
}

/// 插入或替换一条 embedding
pub fn upsert(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    embedding: &[u8],
    model: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO embeddings (source_type, source_id, embedding, model)
         VALUES (?1, ?2, ?3, ?4)",
        params![source_type, source_id, embedding, model],
    )?;
    Ok(())
}

/// Embedding 行（用于向量搜索）
pub struct EmbRow {
    pub source_type: String,
    pub source_id: String,
    pub embedding: Vec<u8>,
    pub title: String,
    pub content_html: String,
}

/// 查询指定书籍所有章节的 embedding
pub fn list_chapter_embeddings(conn: &Connection, book_id: &str) -> Result<Vec<EmbRow>> {
    let mut stmt = conn.prepare(
        "SELECT e.source_id, e.embedding, c.title, c.content_html
         FROM embeddings e
         INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
         WHERE c.book_id = ?1 AND c.deleted_at IS NULL"
    )?;
    let rows: Vec<EmbRow> = stmt.query_map(params![book_id], |row| {
        Ok(EmbRow {
            source_type: "chapter".into(),
            source_id: row.get(0)?,
            embedding: row.get(1)?,
            title: row.get(2)?,
            content_html: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        })
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 查询指定书籍所有世界观卡片的 embedding
pub fn list_world_card_embeddings(conn: &Connection, book_id: &str) -> Result<Vec<EmbRow>> {
    let mut stmt = conn.prepare(
        "SELECT e.source_id, e.embedding, w.title, w.content_html
         FROM embeddings e
         INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
         WHERE w.book_id = ?1"
    )?;
    let rows: Vec<EmbRow> = stmt.query_map(params![book_id], |row| {
        Ok(EmbRow {
            source_type: "world_card".into(),
            source_id: row.get(0)?,
            embedding: row.get(1)?,
            title: row.get(2)?,
            content_html: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        })
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

