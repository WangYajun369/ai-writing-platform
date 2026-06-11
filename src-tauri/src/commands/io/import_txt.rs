//! TXT 文件导入
//!
//! 通过正则自动分章将纯文本文件导入为章节。

use std::sync::OnceLock;
use tauri::{AppHandle, State};
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::commands::window::emit_sql_log;
use crate::utils::now;
use crate::repository::{chapter_repo, book_repo};

/// 缓存章节检测正则，避免每次导入时重复编译
static CHAPTER_REGEX: OnceLock<regex_lite::Regex> = OnceLock::new();

fn get_chapter_regex() -> &'static regex_lite::Regex {
    CHAPTER_REGEX.get_or_init(|| {
        regex_lite::Regex::new(
            r"(?m)^(第[零一二三四五六七八九十百千\d]+[章节卷回].*|Chapter\s+\d+.*)$",
        )
        .expect("章节检测正则编译失败")
    })
}

/// 导入 TXT 文件（正则自动分章）
#[tauri::command]
pub async fn import_txt(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    let content =
        std::fs::read_to_string(&file_path).map_err(|e| AppError::Business(format!("读取文件失败：{}", e)))?;

    let chapter_re = get_chapter_regex();

    let mut chapters: Vec<(String, String)> = Vec::new();
    let mut last_title = "第一章".to_string();
    let mut last_start = 0usize;

    for cap in chapter_re.find_iter(&content) {
        if cap.start() > last_start {
            let body = content[last_start..cap.start()].trim().to_string();
            if !body.is_empty() {
                chapters.push((last_title.clone(), body));
            }
        }
        last_title = cap.as_str().trim().to_string();
        last_start = cap.end();
    }
    let tail = content[last_start..].trim().to_string();
    if !tail.is_empty() {
        chapters.push((last_title, tail));
    }
    if chapters.is_empty() {
        chapters.push(("全文".to_string(), content.trim().to_string()));
    }

    let created_count = chapters.len();
    let conn = db.pool.get()?;

    emit_sql_log(
        &app, "INSERT", "chapters",
        &format!("import_txt, {} chapters for book_id={}", created_count, book_id),
        file!(), line!(),
    );
    for (i, (title, body)) in chapters.iter().enumerate() {
        let id = Uuid::new_v4().to_string();
        let ts = now();
        let html = format!("<p>{}</p>", body.replace('\n', "</p><p>"));
        let wc = body.chars().filter(|c| !c.is_whitespace()).count() as i64;
        chapter_repo::insert_with_content(&conn, &id, &book_id, title, &html, wc, i as i64, &ts)?;
    }

    emit_sql_log(
        &app, "UPDATE", "books",
        &format!("recalc word_count for book_id={}", book_id),
        file!(), line!(),
    );
    book_repo::recalc_word_count(&conn, &book_id, &now())?;

    Ok(serde_json::json!({ "chaptersCreated": created_count }))
}
