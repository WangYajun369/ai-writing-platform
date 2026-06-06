//! 章节管理 IPC 命令
//!
//! 提供章节的增删改查、内容保存（含全书字数聚合）、
//! 状态更新、重命名、排序及软删除操作。

use tauri::State;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use crate::db::AppDb;
use crate::models::Chapter;

/// 获取当前 UTC 时间
fn now() -> String { Utc::now().to_rfc3339() }

/// 列出指定书籍的所有未删除章节（不含 content_html），按 sort_order 升序
#[tauri::command]
pub async fn list_chapters(db: State<'_, AppDb>, book_id: String) -> Result<Vec<Chapter>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,word_count,status,sort_order,created_at,updated_at,deleted_at FROM chapters WHERE book_id=?1 AND deleted_at IS NULL ORDER BY sort_order"
    ).map_err(|e| e.to_string())?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Chapter {
            id: row.get(0)?,
            book_id: row.get(1)?,
            volume_id: row.get(2)?,
            title: row.get(3)?,
            content_html: None, // 列表不加载内容
            word_count: row.get(4)?,
            status: row.get(5)?,
            sort_order: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            deleted_at: row.get(9)?,
        })
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 获取章节的 content_html 内容
#[tauri::command]
pub async fn get_chapter_content(db: State<'_, AppDb>, chapter_id: String) -> Result<String, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.query_row(
        "SELECT content_html FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())
}

/// 创建新章节参数
#[derive(serde::Deserialize)]
pub struct CreateChapterParams {
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "volumeId")]
    pub volume_id: Option<String>,
    pub title: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
}

/// 创建新章节，生成 UUID，初始状态为 draft
#[tauri::command]
pub async fn create_chapter(db: State<'_, AppDb>, params: CreateChapterParams) -> Result<Chapter, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at) VALUES (?1,?2,?3,?4,'',0,'draft',?5,?6,?7)",
        params![id, params.book_id, params.volume_id, params.title, params.sort_order, ts, ts],
    ).map_err(|e| e.to_string())?;
    Ok(Chapter {
        id,
        book_id: params.book_id,
        volume_id: params.volume_id,
        title: params.title,
        content_html: Some(String::new()),
        word_count: 0,
        status: "draft".to_string(),
        sort_order: params.sort_order,
        created_at: ts.clone(),
        updated_at: ts,
        deleted_at: None,
    })
}

/// 保存章节返回结果（章节字数 + 更新后的全书字数）
#[derive(serde::Serialize)]
pub struct SaveChapterResult {
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    #[serde(rename = "bookWordCount")]
    pub book_word_count: i64,
}

/// 保存章节内容（HTML），自动更新书籍总字数并返回
#[tauri::command]
pub async fn save_chapter(
    db: State<'_, AppDb>,
    chapter_id: String,
    content_html: String,
    word_count: i64,
) -> Result<SaveChapterResult, String> {
    let ts = now();
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "UPDATE chapters SET content_html=?1, word_count=?2, updated_at=?3 WHERE id=?4",
        params![content_html, word_count, ts, chapter_id],
    ).map_err(|e| e.to_string())?;

    // 更新书籍总字数
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=(SELECT book_id FROM chapters WHERE id=?1) AND deleted_at IS NULL), updated_at=?2 WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id, ts],
    ).map_err(|e| e.to_string())?;

    // 读取更新后的书籍总字数
    let book_wc: i64 = conn.query_row(
        "SELECT word_count FROM books WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    Ok(SaveChapterResult { word_count, book_word_count: book_wc })
}

/// 更新章节写作状态（outline / draft / polishing / finished）
#[tauri::command]
pub async fn update_chapter_status(
    db: State<'_, AppDb>,
    chapter_id: String,
    status: String,
) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "UPDATE chapters SET status=?1, updated_at=?2 WHERE id=?3",
        params![status, now(), chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 重命名章节标题
#[tauri::command]
pub async fn rename_chapter(db: State<'_, AppDb>, chapter_id: String, title: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "UPDATE chapters SET title=?1, updated_at=?2 WHERE id=?3",
        params![title, now(), chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 软删除章节（设置 deleted_at 时间戳），同步更新全书字数
#[tauri::command]
pub async fn delete_chapter(db: State<'_, AppDb>, chapter_id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let ts = now();
    conn.execute(
        "UPDATE chapters SET deleted_at=?1 WHERE id=?2",
        params![ts, chapter_id],
    ).map_err(|e| e.to_string())?;

    // 更新书籍总字数（软删除后需要重新聚合）
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=(SELECT book_id FROM chapters WHERE id=?1) AND deleted_at IS NULL), updated_at=?2 WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id, ts],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

/// 重新排序章节（按传入 ID 顺序更新 sort_order）
#[tauri::command]
pub async fn reorder_chapters(db: State<'_, AppDb>, chapter_ids: Vec<String>) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    for (i, id) in chapter_ids.iter().enumerate() {
        conn.execute("UPDATE chapters SET sort_order=?1 WHERE id=?2", params![i as i64, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
