//! 书籍管理 IPC 命令
//!
//! 提供书籍的增删改查（CRUD）操作，通过 Tauri State 访问
//! 应用级 SQLite 数据库（r2d2 连接池）。
//!
//! 支持软删除：删除操作仅标记 deleted_at，放入回收站；
//! 彻底删除（硬删除）时才级联清除所有关联数据。

use tauri::State;
use tauri::Manager;
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use serde_json;
use crate::db::AppDb;
use crate::models::Book;
use tauri::AppHandle;
use std::path::Path;

/// 支持的封面图片扩展名
const ALLOWED_COVER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];
/// 封面最大文件大小（字节）：5 MB
const MAX_COVER_SIZE: u64 = 5 * 1024 * 1024;

/// 获取当前 UTC 时间的 RFC 3339 字符串表示
fn now() -> String {
    Utc::now().to_rfc3339()
}

/// 完整的 13 列 SELECT 列表（含 deleted_at）
const BOOK_SELECT: &str = "id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at";

/// 从 rusqlite Row 中解析 Book 结构
fn parse_book(row: &rusqlite::Row) -> rusqlite::Result<Book> {
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
        deleted_at: row.get(12)?,
    })
}

/// 列出所有未删除的书籍，按 updated_at 降序排列
#[tauri::command]
pub async fn list_books(db: State<'_, AppDb>) -> Result<Vec<Book>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        &format!("SELECT {BOOK_SELECT} FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC")
    ).map_err(|e| e.to_string())?;

    let books = stmt.query_map([], |row| parse_book(row))
        .map_err(|e| e.to_string())?;

    books.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 根据 ID 获取单本书籍详情
#[tauri::command]
pub async fn get_book(db: State<'_, AppDb>, id: String) -> Result<Book, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.query_row(
        &format!("SELECT {BOOK_SELECT} FROM books WHERE id=?1"),
        params![id],
        |row| parse_book(row),
    ).map_err(|e| e.to_string())
}

/// 列出回收站中已删除的书籍
#[tauri::command]
pub async fn list_deleted_books(db: State<'_, AppDb>) -> Result<Vec<Book>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        &format!("SELECT {BOOK_SELECT} FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
    ).map_err(|e| e.to_string())?;

    let books = stmt.query_map([], |row| parse_book(row))
        .map_err(|e| e.to_string())?;

    books.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
        deleted_at: None,
    })
}

/// 更新书籍字段（部分更新，通过 serde_json::Value 按字段写入）
#[tauri::command]
pub async fn update_book(db: State<'_, AppDb>, id: String, params: serde_json::Value) -> Result<Book, String> {
    let ts = now();
    {
        let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

        // 收集可更新的字段，构建动态 SQL 以支持部分更新
        let mut set_clauses: Vec<String> = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(v) = params.get("title").and_then(|v| v.as_str()) {
            set_clauses.push(format!("title=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(v.to_string()));
        }
        if let Some(v) = params.get("author").and_then(|v| v.as_str()) {
            set_clauses.push(format!("author=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(v.to_string()));
        }
        if let Some(v) = params.get("description").and_then(|v| v.as_str()) {
            set_clauses.push(format!("description=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(v.to_string()));
        }
        if let Some(v) = params.get("coverImage").and_then(|v| v.as_str()) {
            set_clauses.push(format!("cover_image=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(v.to_string()));
        }
        if let Some(v) = params.get("dailyTarget").and_then(|v| v.as_i64()) {
            set_clauses.push(format!("daily_target=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(v));
        }
        if let Some(v) = params.get("tags").and_then(|v| v.as_array()) {
            let tags_json = serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string());
            set_clauses.push(format!("tags=?{}", set_clauses.len() + 1));
            param_values.push(Box::new(tags_json));
        }

        if !set_clauses.is_empty() {
            // 追加 updated_at
            let ts_idx = set_clauses.len() + 1;
            set_clauses.push(format!("updated_at=?{}", ts_idx));
            param_values.push(Box::new(ts.clone()));

            let sql = format!(
                "UPDATE books SET {} WHERE id=?{}",
                set_clauses.join(", "),
                ts_idx + 1
            );
            param_values.push(Box::new(id.clone()));

            // 构建参数引用切片
            let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
            conn.execute(&sql, params_refs.as_slice())
                .map_err(|e| e.to_string())?;
        }
    }
    get_book(db, id).await
}

/// 设置书籍封面：从源路径复制封面图片到应用数据目录，更新数据库
///
/// 会自动校验文件扩展名和大小，超出限制时返回错误信息。
#[tauri::command]
pub async fn set_book_cover(
    app: AppHandle,
    db: State<'_, AppDb>,
    id: String,
    source_path: String,
) -> Result<Book, String> {
    let src = Path::new(&source_path);

    // 1. 校验扩展名
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_COVER_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的封面格式：.{ext}。仅支持 jpg、jpeg、png、webp。"
        ));
    }

    // 2. 校验文件大小
    let metadata = std::fs::metadata(src).map_err(|e| format!("无法读取封面文件: {e}"))?;
    if metadata.len() > MAX_COVER_SIZE {
        let size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
        return Err(format!(
            "封面文件过大（{:.1} MB），最大允许 5 MB。",
            size_mb
        ));
    }

    // 3. 确保 covers 目录存在
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    let covers_dir = app_dir.join("covers");
    std::fs::create_dir_all(&covers_dir)
        .map_err(|e| format!("无法创建封面目录: {e}"))?;

    // 4. 复制文件（用 book_id + 扩展名作为文件名）
    let dest_filename = format!("{}.{ext}", id);
    let dest = covers_dir.join(&dest_filename);
    std::fs::copy(src, &dest).map_err(|e| format!("封面复制失败: {e}"))?;

    // 5. 更新数据库
    let cover_path = dest.to_str().ok_or("封面路径无效")?.to_string();
    let ts = now();
    {
        let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
        conn.execute(
            "UPDATE books SET cover_image=?1, updated_at=?2 WHERE id=?3",
            params![cover_path, ts, id],
        )
        .map_err(|e| e.to_string())?;
    }

    get_book(db, id).await
}

/// 删除书籍（软删除：标记 deleted_at，放入回收站，数据完整保留）
#[tauri::command]
pub async fn delete_book(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let ts = now();
    conn.execute(
        "UPDATE books SET deleted_at=?1, updated_at=?1 WHERE id=?2 AND deleted_at IS NULL",
        params![ts, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 恢复已删除的书籍（清除 deleted_at）
#[tauri::command]
pub async fn restore_book(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let affected = conn.execute(
        "UPDATE books SET deleted_at=NULL, updated_at=?1 WHERE id=?2",
        params![now(), id],
    ).map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("未找到该作品或未被删除".into());
    }
    Ok(())
}

/// 彻底删除书籍及其全部关联数据（卷、章节、快照、世界观卡片、embedding 向量）
#[tauri::command]
pub async fn hard_delete_book(db: State<'_, AppDb>, id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    // CASCADE 自动删除 volumes / chapters / snapshots / world_cards
    conn.execute("DELETE FROM books WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    // 清理孤立 embedding 向量
    conn.execute(
        "DELETE FROM embeddings WHERE source_type='chapter' AND source_id NOT IN (SELECT id FROM chapters)",
        [],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_type='world_card' AND source_id NOT IN (SELECT id FROM world_cards)",
        [],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 一键清空回收站：彻底删除所有已标记删除的书籍
#[tauri::command]
pub async fn clear_book_trash(db: State<'_, AppDb>) -> Result<u32, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let count: u32 = conn
        .query_row(
            "SELECT COUNT(*) FROM books WHERE deleted_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM books WHERE deleted_at IS NOT NULL", [])
        .map_err(|e| e.to_string())?;
    // 清理孤立 embedding 向量
    let _ = conn.execute(
        "DELETE FROM embeddings WHERE source_type='chapter' AND source_id NOT IN (SELECT id FROM chapters)",
        [],
    );
    let _ = conn.execute(
        "DELETE FROM embeddings WHERE source_type='world_card' AND source_id NOT IN (SELECT id FROM world_cards)",
        [],
    );
    Ok(count)
}
