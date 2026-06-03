use tauri::State;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use crate::db::AppDb;
use crate::models::Snapshot;

fn now() -> String { Utc::now().to_rfc3339() }

fn count_words(html: &str) -> i64 {
    let mut in_tag = false;
    let mut clean = String::new();
    for c in html.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag && !c.is_whitespace() { clean.push(c); }
    }
    clean.len() as i64
}

#[tauri::command]
pub async fn list_snapshots(db: State<'_, AppDb>, chapter_id: String) -> Result<Vec<Snapshot>, String> {
    let conn = db.conn.lock().unwrap();
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
    let conn = db.conn.lock().unwrap();
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
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT content_html FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_snapshot(db: State<'_, AppDb>, snapshot_id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    let (chapter_id, content_html): (String, String) = conn.query_row(
        "SELECT chapter_id, content_html FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    let wc = count_words(&content_html);
    conn.execute(
        "UPDATE chapters SET content_html=?1, word_count=?2, updated_at=?3 WHERE id=?4",
        params![content_html, wc, now(), chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_snapshot(db: State<'_, AppDb>, snapshot_id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM snapshots WHERE id=?1", params![snapshot_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
