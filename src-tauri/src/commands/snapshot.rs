use tauri::State;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use crate::db::AppDb;
use crate::models::Snapshot;
use crate::commands::chapter::SaveChapterResult;

fn now() -> String { Utc::now().to_rfc3339() }

#[tauri::command]
pub async fn list_snapshots(db: State<'_, AppDb>, chapter_id: String) -> Result<Vec<Snapshot>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT id,chapter_id,word_count,type,label,created_at FROM snapshots WHERE chapter_id=?1 ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let items = stmt.query_map(params![chapter_id], |row| {
        Ok(Snapshot {
            id: row.get(0)?,
            chapter_id: row.get(1)?,
            content_html: String::new(), // 列表不返回内容
            word_count: row.get(2)?,
            snapshot_type: row.get(3)?,
            label: row.get(4)?,
            created_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_snapshot(
    db: State<'_, AppDb>,
    chapter_id: String,
    label: Option<String>,
) -> Result<Snapshot, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    // 读取当前章节内容
    let (content_html, word_count): (String, i64) = conn.query_row(
        "SELECT content_html, word_count FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let ts = now();
    let snap_type = if label.is_some() { "milestone" } else { "auto" };

    conn.execute(
        "INSERT INTO snapshots (id,chapter_id,content_html,word_count,type,label,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, chapter_id, content_html, word_count, snap_type, label, ts],
    ).map_err(|e| e.to_string())?;

    Ok(Snapshot {
        id,
        chapter_id,
        content_html,
        word_count,
        snapshot_type: snap_type.to_string(),
        label,
        created_at: ts,
    })
}

#[tauri::command]
pub async fn get_snapshot_content(db: State<'_, AppDb>, snapshot_id: String) -> Result<String, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.query_row(
        "SELECT content_html FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_snapshot(db: State<'_, AppDb>, snapshot_id: String) -> Result<SaveChapterResult, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let (chapter_id, content_html, wc): (String, String, i64) = conn.query_row(
        "SELECT chapter_id, content_html, word_count FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|e| e.to_string())?;

    let ts = now();
    conn.execute(
        "UPDATE chapters SET content_html=?1, word_count=?2, updated_at=?3 WHERE id=?4",
        params![content_html, wc, ts, chapter_id],
    ).map_err(|e| e.to_string())?;

    // 更新书籍总字数（与 save_chapter 保持一致）
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

    Ok(SaveChapterResult { word_count: wc, book_word_count: book_wc })
}

#[tauri::command]
pub async fn delete_snapshot(db: State<'_, AppDb>, snapshot_id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute("DELETE FROM snapshots WHERE id=?1", params![snapshot_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
