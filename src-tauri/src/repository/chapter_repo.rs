//! 章节数据访问层
//!
//! 提供 chapters 表的所有 CRUD SQL 操作。

use rusqlite::{Connection, params, Result};
use crate::models::Chapter;

/// 列出指定书籍的所有未删除章节（不含 content_html），按 sort_order 升序
pub fn list_by_book(conn: &Connection, book_id: &str) -> Result<Vec<Chapter>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline FROM chapters WHERE book_id=?1 AND deleted_at IS NULL ORDER BY sort_order"
    )?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Chapter {
            id: row.get(0)?,
            book_id: row.get(1)?,
            volume_id: row.get(2)?,
            title: row.get(3)?,
            content_html: None,
            word_count: row.get(4)?,
            status: row.get(5)?,
            sort_order: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            deleted_at: row.get(9)?,
            summary: row.get(10)?,
            summary_at: row.get(11)?,
            outline: row.get(12)?,
        })
    })?;
    items.collect()
}

/// 列出指定书籍所有已软删除的章节
pub fn list_deleted_by_book(conn: &Connection, book_id: &str) -> Result<Vec<Chapter>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline FROM chapters WHERE book_id=?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    )?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Chapter {
            id: row.get(0)?,
            book_id: row.get(1)?,
            volume_id: row.get(2)?,
            title: row.get(3)?,
            content_html: None,
            word_count: row.get(4)?,
            status: row.get(5)?,
            sort_order: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            deleted_at: row.get(9)?,
            summary: row.get(10)?,
            summary_at: row.get(11)?,
            outline: row.get(12)?,
        })
    })?;
    items.collect()
}

/// 获取章节的 content_html
pub fn find_content(conn: &Connection, chapter_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT content_html FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| {
            let val: Option<String> = row.get(0)?;
            Ok(val.unwrap_or_default())
        },
    )
}

/// 获取章节的 content_html 和 word_count（用于快照）
pub fn find_content_and_wc(conn: &Connection, chapter_id: &str) -> Result<(String, i64)> {
    conn.query_row(
        "SELECT content_html, word_count FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

/// 获取章节的 volume_id（用于恢复时检测原卷是否存在）
pub fn find_volume_id(conn: &Connection, chapter_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT volume_id FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| row.get(0),
    )
}

/// 获取章节的摘要信息
pub fn find_summary_info(conn: &Connection, chapter_id: &str) -> Result<(Option<String>, Option<String>)> {
    conn.query_row(
        "SELECT summary, summary_at FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

/// 插入新章节
pub fn insert(
    conn: &Connection,
    id: &str,
    book_id: &str,
    volume_id: &Option<String>,
    title: &str,
    sort_order: i64,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,outline) VALUES (?1,?2,?3,?4,'',0,'draft',?5,?6,?7,'')",
        params![id, book_id, volume_id, title, sort_order, created_at, created_at],
    )?;
    Ok(())
}

/// 导入时批量插入章节（含内容）
pub fn insert_with_content(
    conn: &Connection,
    id: &str,
    book_id: &str,
    title: &str,
    content_html: &str,
    word_count: i64,
    sort_order: i64,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at) VALUES (?1,?2,NULL,?3,?4,?5,'draft',?6,?7,?8)",
        params![id, book_id, title, content_html, word_count, sort_order, created_at, created_at],
    )?;
    Ok(())
}

/// 保存章节内容
pub fn save_content(
    conn: &Connection,
    id: &str,
    content_html: &str,
    word_count: i64,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET content_html=?1, word_count=?2, updated_at=?3 WHERE id=?4",
        params![content_html, word_count, ts, id],
    )?;
    Ok(())
}

/// 更新章节状态
pub fn update_status(conn: &Connection, id: &str, status: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET status=?1, updated_at=?2 WHERE id=?3",
        params![status, ts, id],
    )?;
    Ok(())
}

/// 重命名章节
pub fn rename(conn: &Connection, id: &str, title: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET title=?1, updated_at=?2 WHERE id=?3",
        params![title, ts, id],
    )?;
    Ok(())
}

/// 软删除章节
pub fn soft_delete(conn: &Connection, id: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET deleted_at=?1 WHERE id=?2",
        params![ts, id],
    )?;
    Ok(())
}

/// 恢复章节（设置 volume_id 和 deleted_at）
pub fn restore(conn: &Connection, id: &str, volume_id: &Option<String>, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET deleted_at=NULL, volume_id=?1, updated_at=?2 WHERE id=?3",
        params![volume_id, ts, id],
    )?;
    Ok(())
}

/// 硬删除章节
pub fn hard_delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM chapters WHERE id=?1", params![id])?;
    Ok(())
}

/// 重新排序章节
pub fn reorder(conn: &Connection, ids: &[String]) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE chapters SET sort_order=?1 WHERE id=?2",
            params![i as i64, id],
        )?;
    }
    Ok(())
}

/// 移动章节到指定卷
pub fn move_to_volume(
    conn: &Connection,
    id: &str,
    volume_id: &Option<String>,
    sort_order: i64,
    ts: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET volume_id=?1, sort_order=?2, updated_at=?3 WHERE id=?4",
        params![volume_id, sort_order, ts, id],
    )?;
    Ok(())
}

/// 获取卷内最大 sort_order（用于移动到卷末尾）
pub fn max_sort_in_volume(conn: &Connection, volume_id: &Option<String>, chapter_id: &str) -> Result<i64> {
    if let Some(ref vid) = volume_id {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM chapters WHERE volume_id=?1 AND deleted_at IS NULL",
            params![vid],
            |row| row.get(0),
        )
    } else {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM chapters WHERE volume_id IS NULL AND deleted_at IS NULL AND book_id=(SELECT book_id FROM chapters WHERE id=?1)",
            params![chapter_id],
            |row| row.get(0),
        )
    }
}

/// 保存章节总结
pub fn save_summary(conn: &Connection, id: &str, summary: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET summary=?1, summary_at=?2 WHERE id=?3",
        params![summary, ts, id],
    )?;
    Ok(())
}

/// 清除章节总结
pub fn clear_summary(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET summary=NULL, summary_at=NULL WHERE id=?1",
        params![id],
    )?;
    Ok(())
}

/// 保存章节大纲
pub fn save_outline(conn: &Connection, id: &str, outline: &str, ts: &str) -> Result<()> {
    conn.execute(
        "UPDATE chapters SET outline=?1, updated_at=?2 WHERE id=?3",
        params![outline, ts, id],
    )?;
    Ok(())
}

/// 列出书籍所有章节的 title + content_html（用于导出、embedding）
pub fn list_titles_and_content(conn: &Connection, book_id: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT title, content_html FROM chapters WHERE book_id=?1 AND deleted_at IS NULL ORDER BY sort_order"
    )?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    items.collect()
}

/// 统计书籍下有效章节数（有内容的）
pub fn count_active_with_content(conn: &Connection, book_id: &str) -> Result<usize> {
    conn.query_row(
        "SELECT COUNT(*) FROM chapters WHERE book_id = ?1 AND deleted_at IS NULL AND content_html != ''",
        params![book_id],
        |row| row.get::<_, i64>(0).map(|v| v as usize),
    )
}

/// 列出所有章节（含已删除和 HTML 内容），用于备份导出
pub fn list_all_include_deleted_with_content(conn: &Connection) -> Result<Vec<(String, String, Option<String>, String, String, i64, String, i64, String, String, Option<String>, Option<String>, Option<String>, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline FROM chapters"
    )?;
    let items = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            row.get::<_, i64>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
            row.get::<_, Option<String>>(13)?.unwrap_or_default(),
        ))
    })?;
    items.collect::<Result<Vec<_>, _>>()
}

/// 列出书籍章节的 ID 和 content_html（用于 embedding 生成）
pub fn list_ids_and_content_plain(conn: &Connection, book_id: &str) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, content_html FROM chapters WHERE book_id = ?1 AND deleted_at IS NULL AND content_html != ''"
    )?;
    let items = stmt.query_map(params![book_id], |row| {
        let id: String = row.get(0)?;
        let html: String = row.get::<_, Option<String>>(1)?.unwrap_or_default();
        Ok((id, html))
    })?;
    items.collect::<Result<Vec<_>, _>>()
}

// ---- FTS5 全文搜索（返回 id, title, content_html） ----

/// FTS5 搜索章节（返回 id, title, content_html）
pub fn search_fts5_plain(
    conn: &Connection,
    book_id: &str,
    fts_query: &str,
    limit: i64,
) -> Result<Vec<(String, String, String)>> {
    let sql = "SELECT c.id, c.title, c.content_html FROM chapters c \
               INNER JOIN chapters_fts fts ON c.rowid = fts.rowid \
               WHERE c.book_id=?1 AND chapters_fts MATCH ?2 AND c.deleted_at IS NULL \
               ORDER BY rank LIMIT ?3";
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

/// LIKE 降级搜索章节
pub fn search_like_plain(
    conn: &Connection,
    book_id: &str,
    pattern: &str,
    limit: i64,
) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, content_html FROM chapters
         WHERE book_id=?1 AND content_html LIKE ?2 AND deleted_at IS NULL LIMIT ?3"
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
