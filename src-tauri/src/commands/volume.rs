use tauri::State;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use crate::db::AppDb;
use crate::models::Volume;

fn now() -> String { Utc::now().to_rfc3339() }

#[tauri::command]
pub async fn list_volumes(db: State<'_, AppDb>, book_id: String) -> Result<Vec<Volume>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at FROM volumes WHERE book_id=?1 ORDER BY sort_order"
    ).map_err(|e| e.to_string())?;
    let items = stmt.query_map(params![book_id], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_volume(
    db: State<'_, AppDb>,
    book_id: String,
    title: String,
    sort_order: i64,
) -> Result<Volume, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "INSERT INTO volumes (id,book_id,title,sort_order,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, book_id, title, sort_order, ts],
    ).map_err(|e| e.to_string())?;
    Ok(Volume { id, book_id, title, sort_order, created_at: ts })
}

#[tauri::command]
pub async fn update_volume(db: State<'_, AppDb>, id: String, title: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute("UPDATE volumes SET title=?1 WHERE id=?2", params![title, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_volume(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute("DELETE FROM volumes WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reorder_volumes(db: State<'_, AppDb>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    for (i, id) in ids.iter().enumerate() {
        conn.execute("UPDATE volumes SET sort_order=?1 WHERE id=?2", params![i as i64, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
