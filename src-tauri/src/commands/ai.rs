use tauri::State;
use serde::Serialize;
use crate::db::AppDb;

#[derive(Serialize)]
pub struct RagResult {
    pub snippet: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    pub distance: f64,
}

/// RAG 语义检索（Phase 4 占位实现，待接入 sqlite-vec）
#[tauri::command]
pub async fn rag_search(
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
    top_n: usize,
) -> Result<Vec<RagResult>, String> {
    // Phase 1 降级：使用 LIKE 全文检索近似实现
    let conn = db.conn.lock().unwrap();
    let pattern = format!("%{}%", query.chars().take(20).collect::<String>());
    let mut stmt = conn.prepare(
        "SELECT id, title, content_html FROM chapters WHERE book_id=?1 AND content_html LIKE ?2 AND deleted_at IS NULL LIMIT ?3"
    ).map_err(|e| e.to_string())?;

    let results = stmt.query_map(rusqlite::params![book_id, pattern, top_n as i64], |row| {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let html: String = row.get(2)?;
        // 简单截取片段
        let snippet: String = html.chars().filter(|&c| c != '<' && c != '>').take(200).collect();
        Ok(RagResult { snippet, source_id: id, source_title: title, distance: 0.5 })
    }).map_err(|e| e.to_string())?;

    results.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 触发 Embedding 生成（Phase 4 占位）
#[tauri::command]
pub async fn trigger_embedding(_db: State<'_, AppDb>, book_id: String) -> Result<(), String> {
    // Phase 4 将在此处调用 Ollama Embedding API 并存入 sqlite-vec
    println!("触发 Embedding 生成：book_id={}", book_id);
    Ok(())
}
