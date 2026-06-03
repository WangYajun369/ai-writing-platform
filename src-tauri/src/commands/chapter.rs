use tauri::State;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use crate::db::AppDb;
use crate::models::Chapter;

fn now() -> String { Utc::now().to_rfc3339() }

/// 从 HTML 中提取纯文本字数（中文字 + 英文单词）
fn count_words(html: &str) -> i64 {
    let text: String = html.chars().filter(|&c| c != '<').collect();
    // 简单去除标签（生产中应使用 html 解析库）
    let mut in_tag = false;
    let mut clean = String::new();
    for c in html.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { clean.push(c); }
    }
    let _ = text; // suppress warning
    let chinese = clean.chars().filter(|c| *c >= '\u{4e00}' && *c <= '\u{9fa5}').count();
    let english: usize = clean.split_whitespace()
        .filter(|w| w.chars().all(|c| c.is_ascii_alphabetic()))
        .count();
    (chinese + english) as i64
}

#[tauri::command]
pub async fn list_chapters(db: State<'_, AppDb>, book_id: String) -> Result<Vec<Chapter>, String> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,word_count,status,sort_order,created_at,updated_at,deleted_at FROM chapters WHERE book_id=?1 ORDER BY sort_order"
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

#[tauri::command]
pub async fn get_chapter_content(db: State<'_, AppDb>, chapter_id: String) -> Result<String, String> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT content_html FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())
}

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

#[tauri::command]
pub async fn create_chapter(db: State<'_, AppDb>, params: CreateChapterParams) -> Result<Chapter, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let conn = db.conn.lock().unwrap();
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

#[derive(serde::Serialize)]
pub struct SaveChapterResult {
    #[serde(rename = "wordCount")]
    pub word_count: i64,
}

#[tauri::command]
pub async fn save_chapter(
    db: State<'_, AppDb>,
    chapter_id: String,
    content_html: String,
) -> Result<SaveChapterResult, String> {
    let wc = count_words(&content_html);
    let ts = now();
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE chapters SET content_html=?1, word_count=?2, updated_at=?3 WHERE id=?4",
        params![content_html, wc, ts, chapter_id],
    ).map_err(|e| e.to_string())?;

    // 更新书籍总字数
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=(SELECT book_id FROM chapters WHERE id=?1) AND deleted_at IS NULL), updated_at=?2 WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id, ts],
    ).map_err(|e| e.to_string())?;

    Ok(SaveChapterResult { word_count: wc })
}

#[tauri::command]
pub async fn update_chapter_status(
    db: State<'_, AppDb>,
    chapter_id: String,
    status: String,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE chapters SET status=?1, updated_at=?2 WHERE id=?3",
        params![status, now(), chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_chapter(db: State<'_, AppDb>, chapter_id: String, title: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE chapters SET title=?1, updated_at=?2 WHERE id=?3",
        params![title, now(), chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_chapter(db: State<'_, AppDb>, chapter_id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE chapters SET deleted_at=?1 WHERE id=?2",
        params![now(), chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reorder_chapters(db: State<'_, AppDb>, chapter_ids: Vec<String>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    for (i, id) in chapter_ids.iter().enumerate() {
        conn.execute("UPDATE chapters SET sort_order=?1 WHERE id=?2", params![i as i64, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
