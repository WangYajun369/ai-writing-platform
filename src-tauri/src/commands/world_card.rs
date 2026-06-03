use tauri::State;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use serde_json;
use crate::db::AppDb;
use crate::models::WorldCard;

fn now() -> String { Utc::now().to_rfc3339() }

#[tauri::command]
pub async fn list_world_cards(db: State<'_, AppDb>, book_id: String) -> Result<Vec<WorldCard>, String> {
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards WHERE book_id=?1 ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let items = stmt.query_map(params![book_id], |row| {
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
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct CreateWorldCardParams {
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "type")]
    pub card_type: String,
    pub title: String,
    pub content: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    pub tags: Vec<String>,
}

#[tauri::command]
pub async fn create_world_card(db: State<'_, AppDb>, params: CreateWorldCardParams) -> Result<WorldCard, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let tags_json = serde_json::to_string(&params.tags).unwrap_or("[]".to_string());
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO world_cards (id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9)",
        params![id, params.book_id, params.card_type, params.title, params.content, params.content_html, tags_json, ts, ts],
    ).map_err(|e| e.to_string())?;
    Ok(WorldCard {
        id,
        book_id: params.book_id,
        card_type: params.card_type,
        title: params.title,
        content: params.content,
        content_html: params.content_html,
        tags: params.tags,
        vectorized: false,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

#[tauri::command]
pub async fn update_world_card(
    db: State<'_, AppDb>,
    id: String,
    params: serde_json::Value,
) -> Result<WorldCard, String> {
    let conn = db.conn.lock().unwrap();
    let ts = now();
    if let Some(title) = params.get("title").and_then(|v| v.as_str()) {
        conn.execute("UPDATE world_cards SET title=?1, updated_at=?2 WHERE id=?3", rusqlite::params![title, ts, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(content) = params.get("content").and_then(|v| v.as_str()) {
        conn.execute("UPDATE world_cards SET content=?1, updated_at=?2 WHERE id=?3", rusqlite::params![content, ts, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(content_html) = params.get("contentHtml").and_then(|v| v.as_str()) {
        conn.execute("UPDATE world_cards SET content_html=?1, updated_at=?2 WHERE id=?3", rusqlite::params![content_html, ts, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(tags) = params.get("tags") {
        let tags_json = tags.to_string();
        conn.execute("UPDATE world_cards SET tags=?1, updated_at=?2 WHERE id=?3", rusqlite::params![tags_json, ts, id])
            .map_err(|e| e.to_string())?;
    }
    // 重新查询返回
    conn.query_row(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards WHERE id=?1",
        rusqlite::params![id],
        |row| {
            let tags_str: String = row.get(6)?;
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            Ok(WorldCard {
                id: row.get(0)?, book_id: row.get(1)?, card_type: row.get(2)?,
                title: row.get(3)?, content: row.get(4)?, content_html: row.get(5)?,
                tags, vectorized: row.get::<_, i64>(7)? == 1,
                created_at: row.get(8)?, updated_at: row.get(9)?,
            })
        },
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_world_card(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM world_cards WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn search_world_cards(
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
) -> Result<Vec<WorldCard>, String> {
    let conn = db.conn.lock().unwrap();
    let pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards WHERE book_id=?1 AND (title LIKE ?2 OR content LIKE ?2) ORDER BY updated_at DESC LIMIT 20"
    ).map_err(|e| e.to_string())?;
    let items = stmt.query_map(params![book_id, pattern], |row| {
        let tags_str: String = row.get(6)?;
        let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
        Ok(WorldCard {
            id: row.get(0)?, book_id: row.get(1)?, card_type: row.get(2)?,
            title: row.get(3)?, content: row.get(4)?, content_html: row.get(5)?,
            tags, vectorized: row.get::<_, i64>(7)? == 1,
            created_at: row.get(8)?, updated_at: row.get(9)?,
        })
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
