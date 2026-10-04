//! 书籍数据访问层
//!
//! 提供 books 表的所有 CRUD SQL 操作，以及 row → Book 解析函数。
//!
//! 约定：日常查询默认过滤软删（deleted_at IS NULL），回收站单独列出；
//! 硬删除 / 清空回收站依赖 books → volumes/chapters/snapshots/world_cards
//! 的 ON DELETE CASCADE 外键，另有 cleanup_orphan_* 清理不再被源记录引用的 embeddings。

use crate::models::Book;
use crate::repository::embedding_repo;
use crate::repository::soft_delete::{self, Table};
use rusqlite::{params, Connection, Result};

/// 完整的 SELECT 列名
pub const BOOK_SELECT: &str = "id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline";

/// `books` 表的软删除 marker（v1.9 架构优化 #2）
///
/// 供 `soft_delete::*::<BookTable>` 泛型函数使用，编译期注入表名。
pub struct BookTable;
impl Table for BookTable {
    const NAME: &'static str = "books";
}

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
    let mut stmt = conn.prepare(&format!(
        "SELECT {BOOK_SELECT} FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    ))?;
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
    let mut stmt = conn.prepare(&format!(
        "SELECT {BOOK_SELECT} FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    ))?;
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
///
/// 委派到 `soft_delete::soft_delete::<BookTable>`（v1.9 架构优化 #2）
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<()> {
    soft_delete::soft_delete::<BookTable>(conn, id, ts)?;
    Ok(())
}

/// 恢复已删除的书籍（清除 deleted_at）
///
/// 委派到 `soft_delete::restore::<BookTable>`（v1.9 架构优化 #2）。
///
/// 注意：此处不限定 `deleted_at IS NOT NULL` 守卫，与泛型默认实现略有不同——
/// books 表的 restore 在历史行为上接受「未删除的行也返回 1 受影响」，
/// 调用方（book_service::restore_book）通过 0-affected NotFound 判断回收站状态。
/// 为保持向后兼容，此处显式拼接 SQL 而非使用泛型版本。
pub fn restore(conn: &Connection, id: &str, ts: &str) -> Result<usize> {
    conn.execute(
        "UPDATE books SET deleted_at=NULL, updated_at=?1 WHERE id=?2",
        params![ts, id],
    )
}

/// 硬删除书籍（CASCADE 自动删除 volumes/chapters/snapshots/world_cards）
///
/// 委派到 `soft_delete::hard_delete::<BookTable>`（v1.9 架构优化 #2）。
/// 无 `deleted_at` 守卫，依赖调用方在 service 层确保回收站状态（book_service::hard_delete_book）。
pub fn hard_delete(conn: &Connection, id: &str) -> Result<()> {
    soft_delete::hard_delete::<BookTable>(conn, id)?;
    Ok(())
}

/// 统计已删除的书籍数量
///
/// 委派到 `soft_delete::count_deleted::<BookTable>`（v1.9 架构优化 #2）
pub fn count_deleted(conn: &Connection) -> Result<u32> {
    soft_delete::count_deleted::<BookTable>(conn)
}

/// 清空回收站：硬删除所有已标记删除的书籍
///
/// 委派到 `soft_delete::clear_trash::<BookTable>`（v1.9 架构优化 #2）
pub fn clear_trash(conn: &Connection) -> Result<()> {
    soft_delete::clear_trash::<BookTable>(conn)
}

// ---- 字数聚合 ----

/// 对指定书籍的 `word_count` 应用增量更新（delta 可正可负）
///
/// 与 `recalc_word_count` 的全量 SUM 不同，此函数直接 `books.word_count += delta`，
/// 复杂度 O(1)，适合保存 / 删除 / 恢复路径的高频调用。
///
/// # 边界
///
/// - 使用 `MAX(0, word_count + ?)` 防止 delta 为负时出现负数字数
/// - 同步刷新 `updated_at`
///
/// # Arguments
/// * `conn` - 数据库连接
/// * `book_id` - 书籍 ID
/// * `delta` - 字数增量（正数表示增加，负数表示减少）
/// * `ts` - 时间戳，用于更新 `books.updated_at`
pub fn apply_word_count_delta(
    conn: &Connection,
    book_id: &str,
    delta: i64,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET word_count = MAX(0, word_count + ?1), updated_at=?2 WHERE id=?3",
        params![delta, ts, book_id],
    )?;
    Ok(())
}

/// 通过 book_id 读取书籍总字数
pub fn word_count_by_book(conn: &Connection, book_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT word_count FROM books WHERE id=?1",
        params![book_id],
        |row| row.get(0),
    )
}

/// 重新聚合并更新指定 book_id 的总字数
pub fn recalc_word_count(conn: &Connection, book_id: &str, ts: &str) -> Result<()> {
    // 子查询聚合该书未删除章节的字数总和（COALESCE 兜底空表为 0），并同步 updated_at
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=?1 AND deleted_at IS NULL), updated_at=?2 WHERE id=?1",
        params![book_id, ts],
    )?;
    Ok(())
}

// ---- 备份导出 ----

/// 列出所有书籍（含已删除），用于备份导出
pub fn list_all_include_deleted(conn: &Connection) -> Result<Vec<Book>> {
    let mut stmt = conn.prepare(&format!("SELECT {BOOK_SELECT} FROM books"))?;
    let books = stmt.query_map([], |row| parse_book(row))?;
    books.collect()
}

// ---- 清理孤立 embedding ----

/// 清理 orphan chapter embeddings（章节已被删除但 embedding 残留）
///
/// 同步清理 chunks_vec 镜像行（vec0 不随普通表级联，rowid ↔ embeddings.id）。
pub fn cleanup_orphan_chapter_embeddings(conn: &Connection) -> Result<()> {
    let ids = orphan_embedding_ids(conn, "chapter")?;
    embedding_repo::delete_vec_rows(conn, &ids)?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_type='chapter' AND source_id NOT IN (SELECT id FROM chapters)",
        [],
    )?;
    Ok(())
}

/// 清理 orphan world_card embeddings
///
/// 同步清理 chunks_vec 镜像行（vec0 不随普通表级联，rowid ↔ embeddings.id）。
pub fn cleanup_orphan_world_card_embeddings(conn: &Connection) -> Result<()> {
    let ids = orphan_embedding_ids(conn, "world_card")?;
    embedding_repo::delete_vec_rows(conn, &ids)?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_type='world_card' AND source_id NOT IN (SELECT id FROM world_cards)",
        [],
    )?;
    Ok(())
}

/// 查询指定 source_type 下已无对应源记录的 embeddings.id 列表
fn orphan_embedding_ids(conn: &Connection, source_type: &str) -> Result<Vec<i64>> {
    let sql = match source_type {
        "chapter" => "SELECT id FROM embeddings WHERE source_type='chapter' AND source_id NOT IN (SELECT id FROM chapters)",
        _ => "SELECT id FROM embeddings WHERE source_type='world_card' AND source_id NOT IN (SELECT id FROM world_cards)",
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
    rows.collect()
}

/// 查询书籍日更目标（写作统计用，缺省 0）
pub fn find_daily_target(conn: &Connection, book_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COALESCE(daily_target, 0) FROM books WHERE id=?1",
        params![book_id],
        |row| row.get::<_, i64>(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造仅含 books 测试所需列的内存库（id, title, word_count, updated_at）
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE books (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL DEFAULT '',
                word_count  INTEGER NOT NULL DEFAULT 0,
                updated_at  TEXT NOT NULL DEFAULT ''
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO books (id, title, word_count, updated_at) VALUES ('b1', 'Book1', 100, 't0')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn apply_delta_positive_increases_word_count() {
        let conn = setup();
        apply_word_count_delta(&conn, "b1", 50, "t1").unwrap();
        assert_eq!(word_count_by_book(&conn, "b1").unwrap(), 150);
    }

    #[test]
    fn apply_delta_negative_decreases_word_count() {
        let conn = setup();
        apply_word_count_delta(&conn, "b1", -30, "t2").unwrap();
        assert_eq!(word_count_by_book(&conn, "b1").unwrap(), 70);
    }

    #[test]
    fn apply_delta_negative_clamped_to_zero() {
        // delta 负数且绝对值大于当前 word_count：MAX(0, ...) 钳制为 0，避免负数
        let conn = setup();
        apply_word_count_delta(&conn, "b1", -200, "t3").unwrap();
        assert_eq!(word_count_by_book(&conn, "b1").unwrap(), 0);
    }

    #[test]
    fn apply_delta_zero_is_noop() {
        let conn = setup();
        apply_word_count_delta(&conn, "b1", 0, "t4").unwrap();
        assert_eq!(word_count_by_book(&conn, "b1").unwrap(), 100);
    }

    #[test]
    fn apply_delta_unknown_book_is_noop() {
        // 未知 book_id：UPDATE 影响 0 行，不报错（与 recalc 行为一致）
        let conn = setup();
        apply_word_count_delta(&conn, "unknown", 50, "t5").unwrap();
        // 原 book 不受影响
        assert_eq!(word_count_by_book(&conn, "b1").unwrap(), 100);
    }
}
