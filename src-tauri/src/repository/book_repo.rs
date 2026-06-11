//! 书籍数据访问层
//!
//! 提供 books 表的所有 CRUD SQL 操作，以及 row → Book 解析函数。

use rusqlite::{Connection, params, Result};
use crate::models::Book;

/// 完整的 SELECT 列名
pub const BOOK_SELECT: &str = "id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline";

/// 从 rusqlite Row 解析 Book（按列名获取，不依赖列顺序）
pub fn parse_book(row: &rusqlite::Row) -> Result<Book> {
    let tags_str: String = row.get("tags")?;
    let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
    Ok(Book {
        id: row.get("id")?,
        title: row.get("title")?,
        author: row.get("author")?,
        description: row.get("description")?,
        cover_image: row.get("cover_image")?,
        word_count: row.get("word_count")?,
        daily_target: row.get("daily_target")?,
        today_count: row.get("today_count")?,
        db_path: row.get("db_path")?,
        tags,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        outline: row.get("outline")?,
    })
}

// ---- 查询 ----

/// 列出所有未删除的书籍，按 updated_at 降序
pub fn list_all(conn: &Connection) -> Result<Vec<Book>> {
    let mut stmt = conn.prepare(
        &format!("SELECT {BOOK_SELECT} FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC")
    )?;
    let books = stmt.query_map([], |row| parse_book(row))?;
    books.collect()
}

/// 根据 ID 获取单本书籍
pub fn find_by_id(conn: &Connection, id: &str) -> Result<Book> {
    conn.query_row(
        &format!("SELECT {BOOK_SELECT} FROM books WHERE id=?1"),
        params![id],
        |row| parse_book(row),
    )
}

/// 列出回收站中已删除的书籍
pub fn list_deleted(conn: &Connection) -> Result<Vec<Book>> {
    let mut stmt = conn.prepare(
        &format!("SELECT {BOOK_SELECT} FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
    )?;
    let books = stmt.query_map([], |row| parse_book(row))?;
    books.collect()
}

/// 获取单本书籍的标题和作者（用于导出）
pub fn find_title_author(conn: &Connection, id: &str) -> Result<(String, String)> {
    conn.query_row(
        "SELECT title, author FROM books WHERE id=?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

// ---- 写入 ----

/// 插入新书
pub fn insert(
    conn: &Connection,
    id: &str,
    title: &str,
    author: &str,
    description: &str,
    daily_target: i64,
    tags_json: &str,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO books (id,title,author,description,daily_target,tags,created_at,updated_at,word_count,today_count,db_path,outline) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,0,'','')",
        params![id, title, author, description, daily_target, tags_json, created_at, created_at],
    )?;
    Ok(())
}

/// 更新封面图片
pub fn update_cover(conn: &Connection, id: &str, data_url: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET cover_image=?1, updated_at=?2 WHERE id=?3",
        params![data_url, ts, id],
    )?;
    Ok(())
}

/// 清除封面图片
pub fn clear_cover(conn: &Connection, id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET cover_image=NULL, updated_at=?1 WHERE id=?2",
        params![ts, id],
    )?;
    Ok(())
}

/// 软删除书籍（标记 deleted_at）
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET deleted_at=?1, updated_at=?1 WHERE id=?2 AND deleted_at IS NULL",
        params![ts, id],
    )?;
    Ok(())
}

/// 恢复已删除的书籍（清除 deleted_at）
pub fn restore(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE books SET deleted_at=NULL, updated_at=?1 WHERE id=?2",
        params![ts, id],
    )
}

/// 硬删除书籍（CASCADE 自动删除 volumes/chapters/snapshots/world_cards）
pub fn hard_delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM books WHERE id=?1", params![id])?;
    Ok(())
}

/// 统计已删除的书籍数量
pub fn count_deleted(conn: &Connection) -> Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM books WHERE deleted_at IS NOT NULL",
        [],
        |row| row.get(0),
    )
}

/// 清空回收站：硬删除所有已标记删除的书籍
pub fn clear_trash(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM books WHERE deleted_at IS NOT NULL", [])?;
    Ok(())
}

// ---- 字数聚合 ----

/// 根据 chapter_id 重新聚合并更新对应书籍的总字数
pub fn update_word_count_by_chapter(conn: &Connection, chapter_id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET word_count=(\
            SELECT COALESCE(SUM(word_count),0) FROM chapters \
            WHERE book_id=(SELECT book_id FROM chapters WHERE id=?1) AND deleted_at IS NULL\
         ), updated_at=?2 \
         WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id, ts],
    )?;
    Ok(())
}

/// 通过 chapter_id 读取对应书籍的总字数
pub fn word_count_by_chapter(conn: &Connection, chapter_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT word_count FROM books WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id],
        |row| row.get(0),
    )
}

/// 通过 book_id 读取书籍总字数
#[allow(dead_code)]
pub fn word_count_by_book(conn: &Connection, book_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT word_count FROM books WHERE id=?1",
        params![book_id],
        |row| row.get(0),
    )
}

/// 重新聚合并更新指定 book_id 的总字数
pub fn recalc_word_count(conn: &Connection, book_id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=?1 AND deleted_at IS NULL), updated_at=?2 WHERE id=?1",
        params![book_id, ts],
    )?;
    Ok(())
}

// ---- 备份导出 ----

/// 列出所有书籍（含已删除），用于备份导出
pub fn list_all_include_deleted(conn: &Connection) -> Result<Vec<Book>> {
    let mut stmt = conn.prepare(
        &format!("SELECT {BOOK_SELECT} FROM books")
    )?;
    let books = stmt.query_map([], |row| parse_book(row))?;
    books.collect()
}

// ---- 清理孤立 embedding ----

/// 清理 orphan chapter embeddings（章节已被删除但 embedding 残留）
pub fn cleanup_orphan_chapter_embeddings(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM embeddings WHERE source_type='chapter' AND source_id NOT IN (SELECT id FROM chapters)",
        [],
    )?;
    Ok(())
}

/// 清理 orphan world_card embeddings
pub fn cleanup_orphan_world_card_embeddings(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM embeddings WHERE source_type='world_card' AND source_id NOT IN (SELECT id FROM world_cards)",
        [],
    )?;
    Ok(())
}
