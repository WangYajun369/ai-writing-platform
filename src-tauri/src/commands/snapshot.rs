//! 版本快照 IPC 命令
//!
//! 提供快照的增删查、创建（自动/里程碑）与恢复操作。
//! 恢复快照会将章节内容回退到快照状态并更新全书字数。

use tauri::{AppHandle, Emitter, Manager, State};
use rusqlite::params;
use uuid::Uuid;
use chrono::Utc;
use crate::db::AppDb;
use crate::models::Snapshot;
use crate::commands::chapter::SaveChapterResult;
use crate::commands::window::emit_sql_log;

/// 获取当前 UTC 时间
fn now() -> String { Utc::now().to_rfc3339() }

/// 列出指定章节的所有快照（不含 content_html），按创建时间降序
#[tauri::command]
pub async fn list_snapshots(app: AppHandle, db: State<'_, AppDb>, chapter_id: String) -> Result<Vec<Snapshot>, String> {
    emit_sql_log(&app, "SELECT", "snapshots", &format!("chapter_id={}", chapter_id), file!(), line!());
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

/// 创建章节快照（有 label 则为 milestone，否则为 auto）
#[tauri::command]
pub async fn create_snapshot(
    app: AppHandle,
    db: State<'_, AppDb>,
    chapter_id: String,
    label: Option<String>,
) -> Result<Snapshot, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    // 读取当前章节内容
    emit_sql_log(&app, "SELECT", "chapters", &format!("id={}, for snapshot content", chapter_id), file!(), line!());
    let (content_html, word_count): (String, i64) = conn.query_row(
        "SELECT content_html, word_count FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();
    let ts = now();
    let snap_type = if label.is_some() { "milestone" } else { "auto" };

    emit_sql_log(&app, "INSERT", "snapshots", &format!("id={}, chapter_id={}, type={}", id, chapter_id, snap_type), file!(), line!());
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

/// 获取快照的 content_html
#[tauri::command]
pub async fn get_snapshot_content(app: AppHandle, db: State<'_, AppDb>, snapshot_id: String) -> Result<String, String> {
    emit_sql_log(&app, "SELECT", "snapshots", &format!("id={}, content_html", snapshot_id), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.query_row(
        "SELECT content_html FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())
}

/// 从快照恢复章节内容（覆盖 current content_html），同步更新全书字数
#[tauri::command]
pub async fn restore_snapshot(app: tauri::AppHandle, db: State<'_, AppDb>, snapshot_id: String) -> Result<SaveChapterResult, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    emit_sql_log(&app, "SELECT", "snapshots", &format!("id={}, restore content", snapshot_id), file!(), line!());
    let (chapter_id, content_html, wc): (String, String, i64) = conn.query_row(
        "SELECT chapter_id, content_html, word_count FROM snapshots WHERE id=?1",
        params![snapshot_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|e| e.to_string())?;

    let ts = now();
    emit_sql_log(&app, "UPDATE", "chapters", &format!("id={}, restore from snapshot", chapter_id), file!(), line!());
    conn.execute(
        "UPDATE chapters SET content_html=?1, word_count=?2, updated_at=?3 WHERE id=?4",
        params![content_html, wc, ts, chapter_id],
    ).map_err(|e| e.to_string())?;

    // 更新书籍总字数（与 save_chapter 保持一致）
    emit_sql_log(&app, "UPDATE", "books", "recalc word_count after snapshot restore", file!(), line!());
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=(SELECT book_id FROM chapters WHERE id=?1) AND deleted_at IS NULL), updated_at=?2 WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id, ts],
    ).map_err(|e| e.to_string())?;

    // 读取更新后的书籍总字数
    emit_sql_log(&app, "SELECT", "books", &format!("word_count via chapter_id={}", chapter_id), file!(), line!());
    let book_wc: i64 = conn.query_row(
        "SELECT word_count FROM books WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    // 通知主窗口刷新编辑器内容
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("history-snapshot-restored", &chapter_id);
    }

    Ok(SaveChapterResult { word_count: wc, book_word_count: book_wc })
}

/// 删除指定快照
#[tauri::command]
pub async fn delete_snapshot(app: AppHandle, db: State<'_, AppDb>, snapshot_id: String) -> Result<(), String> {
    emit_sql_log(&app, "DELETE", "snapshots", &format!("id={}", snapshot_id), file!(), line!());
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute("DELETE FROM snapshots WHERE id=?1", params![snapshot_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
