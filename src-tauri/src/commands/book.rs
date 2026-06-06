//! 书籍管理 IPC 命令
//!
//! 提供书籍的增删改查（CRUD）操作，通过 Tauri State 访问
//! 应用级 SQLite 数据库（r2d2 连接池）。

use tauri::State;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use serde_json;
use crate::db::AppDb;
use crate::models::Book;

/// 获取当前 UTC 时间的 RFC 3339 字符串表示
fn now() -> String {
    Utc::now().to_rfc3339()
}

/// 列出所有书籍，按 updated_at 降序排列
#[tauri::command]
pub async fn list_books(db: State<'_, AppDb>) -> Result<Vec<Book>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at FROM books ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;

    let books = stmt.query_map([], |row| {
        let tags_str: String = row.get(9)?;
        let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
        Ok(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            description: row.get(3)?,
            cover_image: row.get(4)?,
            word_count: row.get(5)?,
            daily_target: row.get(6)?,
            today_count: row.get(7)?,
            db_path: row.get(8)?,
            tags,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    }).map_err(|e| e.to_string())?;

    books.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 根据 ID 获取单本书籍详情
#[tauri::command]
pub async fn get_book(db: State<'_, AppDb>, id: String) -> Result<Book, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.query_row(
        "SELECT id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at FROM books WHERE id=?1",
        params![id],
        |row| {
            let tags_str: String = row.get(9)?;
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                description: row.get(3)?,
                cover_image: row.get(4)?,
                word_count: row.get(5)?,
                daily_target: row.get(6)?,
                today_count: row.get(7)?,
                db_path: row.get(8)?,
                tags,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    ).map_err(|e| e.to_string())
}

/// 创建新书参数（由前端 JSON 反序列化）
#[derive(serde::Deserialize)]
pub struct CreateBookParams {
    pub title: String,
    pub author: String,
    pub description: String,
    #[serde(rename = "dailyTarget")]
    pub daily_target: i64,
    pub tags: Vec<String>,
}

/// 创建新书，生成 UUID，返回完整 Book 结构
#[tauri::command]
pub async fn create_book(db: State<'_, AppDb>, params: CreateBookParams) -> Result<Book, String> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    let tags_json = serde_json::to_string(&params.tags).unwrap_or("[]".to_string());

    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "INSERT INTO books (id,title,author,description,daily_target,tags,created_at,updated_at,word_count,today_count,db_path) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,0,'')",
        params![id, params.title, params.author, params.description, params.daily_target, tags_json, ts, ts],
    ).map_err(|e| e.to_string())?;

    Ok(Book {
        id,
        title: params.title,
        author: params.author,
        description: params.description,
        cover_image: None,
        word_count: 0,
        daily_target: params.daily_target,
        today_count: 0,
        db_path: String::new(),
        tags: params.tags,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

/// 更新书籍字段（部分更新，通过 serde_json::Value 按字段写入）
#[tauri::command]
pub async fn update_book(db: State<'_, AppDb>, id: String, params: serde_json::Value) -> Result<Book, String> {
    let ts = now();
    {
        let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
        if let Some(title) = params.get("title").and_then(|v| v.as_str()) {
            conn.execute("UPDATE books SET title=?1, updated_at=?2 WHERE id=?3", params![title, ts, id])
                .map_err(|e| e.to_string())?;
        }
    }
    get_book(db, id).await
}

/// 删除书籍（级联删除关联的卷、章节、快照）
#[tauri::command]
pub async fn delete_book(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute("DELETE FROM books WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
