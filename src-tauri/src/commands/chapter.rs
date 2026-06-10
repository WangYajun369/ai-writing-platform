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
        "SELECT id,book_id,volume_id,title,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline FROM chapters WHERE book_id=?1 AND deleted_at IS NULL ORDER BY sort_order"
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
            summary: row.get(10)?,
            summary_at: row.get(11)?,
            outline: row.get(12)?,
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
        "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,outline) VALUES (?1,?2,?3,?4,'',0,'draft',?5,?6,?7,'')",
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
        summary: None,
        summary_at: None,
        outline: String::new(),
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

/// 列出指定书籍所有已软删除的章节（deleted_at IS NOT NULL）
#[tauri::command]
pub async fn list_deleted_chapters(db: State<'_, AppDb>, book_id: String) -> Result<Vec<Chapter>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline FROM chapters WHERE book_id=?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    ).map_err(|e| e.to_string())?;
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
    }).map_err(|e| e.to_string())?;
    items.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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

/// 恢复章节返回结果（包含恢复后所在卷）
#[derive(serde::Serialize)]
pub struct RestoreChapterResult {
    #[serde(rename = "volumeId")]
    pub volume_id: Option<String>,
}

/// 恢复已软删除的章节（清除 deleted_at）
/// 若章节原本有卷但卷已被删除，则将章节恢复到根目录
#[tauri::command]
pub async fn restore_chapter(db: State<'_, AppDb>, chapter_id: String) -> Result<RestoreChapterResult, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let ts = now();

    // 读取章节当前的 volume_id
    let current_vid: Option<String> = conn.query_row(
        "SELECT volume_id FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    // 检查原卷是否存在且未被删除
    let effective_volume_id = if let Some(ref vid) = current_vid {
        let vol_exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM volumes WHERE id=?1 AND deleted_at IS NULL",
            params![vid],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if vol_exists { Some(vid.clone()) } else { None }
    } else {
        None
    };

    conn.execute(
        "UPDATE chapters SET deleted_at=NULL, volume_id=?1, updated_at=?2 WHERE id=?3",
        params![effective_volume_id, ts, chapter_id],
    ).map_err(|e| e.to_string())?;

    // 恢复后更新书籍总字数
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=(SELECT book_id FROM chapters WHERE id=?1) AND deleted_at IS NULL), updated_at=?2 WHERE id=(SELECT book_id FROM chapters WHERE id=?1)",
        params![chapter_id, ts],
    ).map_err(|e| e.to_string())?;

    Ok(RestoreChapterResult { volume_id: effective_volume_id })
}

/// 硬删除章节（真正从数据库删除记录）
#[tauri::command]
pub async fn hard_delete_chapter(db: State<'_, AppDb>, chapter_id: String) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let ts = now();
    conn.execute(
        "DELETE FROM chapters WHERE id=?1",
        params![chapter_id],
    ).map_err(|e| e.to_string())?;

    // 更新全书总字数
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(c.word_count),0) FROM chapters c WHERE c.book_id=books.id AND c.deleted_at IS NULL), updated_at=?1",
        params![ts],
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

/// 将章节移动到指定卷（或移到根目录 volume_id=NONE）
/// 同时更新 sort_order，放置在目标卷末尾
#[tauri::command]
pub async fn move_chapter_to_volume(
    db: State<'_, AppDb>,
    chapter_id: String,
    volume_id: Option<String>,
) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let ts = now();

    // 计算目标分组最大 sort_order + 1
    let max_order: i64 = if let Some(ref vid) = volume_id {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM chapters WHERE volume_id=?1 AND deleted_at IS NULL",
            params![vid],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?
    } else {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM chapters WHERE volume_id IS NULL AND deleted_at IS NULL AND book_id=(SELECT book_id FROM chapters WHERE id=?1)",
            params![chapter_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?
    };

    let new_sort = max_order + 1;

    conn.execute(
        "UPDATE chapters SET volume_id=?1, sort_order=?2, updated_at=?3 WHERE id=?4",
        params![volume_id, new_sort, ts, chapter_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

/// 保存章节的 AI 总结内容
#[tauri::command]
pub async fn save_chapter_summary(
    db: State<'_, AppDb>,
    chapter_id: String,
    summary: String,
) -> Result<(), String> {
    let ts = now();
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "UPDATE chapters SET summary=?1, summary_at=?2 WHERE id=?3",
        params![summary, ts, chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取章节的总结信息（summary 和 summary_at）
#[derive(serde::Serialize)]
pub struct ChapterSummaryInfo {
    pub summary: Option<String>,
    #[serde(rename = "summaryAt")]
    pub summary_at: Option<String>,
}

#[tauri::command]
pub async fn get_chapter_summary(
    db: State<'_, AppDb>,
    chapter_id: String,
) -> Result<ChapterSummaryInfo, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.query_row(
        "SELECT summary, summary_at FROM chapters WHERE id=?1",
        params![chapter_id],
        |row| {
            Ok(ChapterSummaryInfo {
                summary: row.get(0)?,
                summary_at: row.get(1)?,
            })
        },
    ).map_err(|e| e.to_string())
}

/// 清除章节的 AI 总结内容（将 summary/summary_at 置为 null）
#[tauri::command]
pub async fn clear_chapter_summary(
    db: State<'_, AppDb>,
    chapter_id: String,
) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "UPDATE chapters SET summary=NULL, summary_at=NULL WHERE id=?1",
        params![chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存章节大纲内容
#[tauri::command]
pub async fn save_chapter_outline(
    db: State<'_, AppDb>,
    chapter_id: String,
    outline: String,
) -> Result<(), String> {
    let ts = now();
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    conn.execute(
        "UPDATE chapters SET outline=?1, updated_at=?2 WHERE id=?3",
        params![outline, ts, chapter_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
