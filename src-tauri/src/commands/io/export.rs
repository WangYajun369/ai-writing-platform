//! 基本格式导出（TXT / MD / HTML）
//!
//! 将书籍所有章节以指定格式导出为单一文件。

use tauri::{AppHandle, State};
use std::fmt::Write as FmtWrite;
use crate::db::AppDb;
use crate::error::AppError;
use crate::commands::window::emit_sql_log;
use crate::utils::strip_html;
use crate::repository::{book_repo, chapter_repo};

/// 导出书籍（TXT / MD / HTML）
#[tauri::command]
pub async fn export_book(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    format: String,
    output_path: String,
) -> Result<(), AppError> {
    let conn = db.pool.get()?;

    emit_sql_log(
        &app, "SELECT", "books",
        &format!("id={}, export info", book_id),
        file!(), line!(),
    );
    let (title, author) = book_repo::find_title_author(&conn, &book_id)?;

    emit_sql_log(
        &app, "SELECT", "chapters",
        &format!("book_id={}, export chapters", book_id),
        file!(), line!(),
    );
    let chapters = chapter_repo::list_titles_and_content(&conn, &book_id)?;

    let content = match format.as_str() {
        "txt" => build_txt(&title, &author, &chapters),
        "md" => build_md(&title, &author, &chapters),
        "html" => build_html(&title, &author, &chapters),
        _ => return Err(AppError::Business(format!("不支持的导出格式：{}", format))),
    };

    std::fs::write(&output_path, content)
        .map_err(|e| AppError::Business(format!("写入导出文件失败: {}", e)))?;
    Ok(())
}

fn build_txt(title: &str, author: &str, chapters: &[(String, String)]) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "{}", title);
    let _ = writeln!(out, "作者：{}\n", author);
    for (ch_title, html) in chapters {
        let _ = writeln!(out, "\n\n{}\n", ch_title);
        let _ = writeln!(out, "{}", strip_html(html));
    }
    out
}

fn build_md(title: &str, author: &str, chapters: &[(String, String)]) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# {}", title);
    let _ = writeln!(out, "> 作者：{}\n", author);
    for (ch_title, html) in chapters {
        let _ = writeln!(out, "\n## {}\n", ch_title);
        let _ = writeln!(out, "{}", strip_html(html));
    }
    out
}

fn build_html(title: &str, author: &str, chapters: &[(String, String)]) -> String {
    let mut body = String::new();
    for (ch_title, html) in chapters {
        let _ = writeln!(body, "<h2>{}</h2>\n{}", ch_title, html);
    }
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>{}</title>
<style>body{{max-width:800px;margin:40px auto;font-family:serif;line-height:2;}}h1,h2{{font-weight:bold;}}</style>
</head>
<body>
<h1>{}</h1><p>作者：{}</p>
{}
</body></html>"#,
        title, title, author, body
    )
}
