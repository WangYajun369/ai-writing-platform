use tauri::State;
use rusqlite::params;
use std::fmt::Write as FmtWrite;
use crate::db::AppDb;

/// 导出书籍（TXT / MD / HTML）
#[tauri::command]
pub async fn export_book(
    db: State<'_, AppDb>,
    book_id: String,
    format: String,
    output_path: String,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();

    // 获取书籍信息
    let (title, author): (String, String) = conn.query_row(
        "SELECT title,author FROM books WHERE id=?1",
        params![book_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    // 获取所有章节（按 sort_order）
    let mut stmt = conn.prepare(
        "SELECT title, content_html FROM chapters WHERE book_id=?1 AND deleted_at IS NULL ORDER BY sort_order"
    ).map_err(|e| e.to_string())?;

    let chapters: Vec<(String, String)> = stmt.query_map(params![book_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    let content = match format.as_str() {
        "txt" => build_txt(&title, &author, &chapters),
        "md" => build_md(&title, &author, &chapters),
        "html" => build_html(&title, &author, &chapters),
        _ => return Err(format!("不支持的导出格式：{}", format)),
    };

    std::fs::write(&output_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

fn strip_html(html: &str) -> String {
    let mut in_tag = false;
    let mut result = String::new();
    for c in html.chars() {
        if c == '<' { in_tag = true; continue; }
        if c == '>' { in_tag = false; continue; }
        if !in_tag { result.push(c); }
    }
    result
}

fn build_txt(title: &str, author: &str, chapters: &[(String, String)]) -> String {
    let mut out = String::new();
    writeln!(out, "{}", title).unwrap();
    writeln!(out, "作者：{}\n", author).unwrap();
    for (ch_title, html) in chapters {
        writeln!(out, "\n\n{}\n", ch_title).unwrap();
        writeln!(out, "{}", strip_html(html)).unwrap();
    }
    out
}

fn build_md(title: &str, author: &str, chapters: &[(String, String)]) -> String {
    let mut out = String::new();
    writeln!(out, "# {}", title).unwrap();
    writeln!(out, "> 作者：{}\n", author).unwrap();
    for (ch_title, html) in chapters {
        writeln!(out, "\n## {}\n", ch_title).unwrap();
        writeln!(out, "{}", strip_html(html)).unwrap();
    }
    out
}

fn build_html(title: &str, author: &str, chapters: &[(String, String)]) -> String {
    let mut body = String::new();
    for (ch_title, html) in chapters {
        writeln!(body, "<h2>{}</h2>\n{}", ch_title, html).unwrap();
    }
    format!(r#"<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>{}</title>
<style>body{{max-width:800px;margin:40px auto;font-family:serif;line-height:2;}}h1,h2{{font-weight:bold;}}</style>
</head>
<body>
<h1>{}</h1><p>作者：{}</p>
{}
</body></html>"#, title, title, author, body)
}

/// 导入 TXT 文件（正则自动分章）
#[tauri::command]
pub async fn import_txt(
    db: State<'_, AppDb>,
    book_id: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("读取文件失败：{}", e))?;

    // 常见章节分隔正则（第X章 / Chapter N / 卷X）
    let chapter_re = regex_lite::Regex::new(r"(?m)^(第[零一二三四五六七八九十百千\d]+[章节卷回].*|Chapter\s+\d+.*)$")
        .map_err(|e| e.to_string())?;

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
    // 最后一章
    let tail = content[last_start..].trim().to_string();
    if !tail.is_empty() {
        chapters.push((last_title, tail));
    }
    if chapters.is_empty() {
        chapters.push(("全文".to_string(), content.trim().to_string()));
    }

    let created_count = chapters.len();
    let conn = db.conn.lock().unwrap();
    use chrono::Utc;
    use uuid::Uuid;

    for (i, (title, body)) in chapters.iter().enumerate() {
        let id = Uuid::new_v4().to_string();
        let ts = Utc::now().to_rfc3339();
        let html = format!("<p>{}</p>", body.replace('\n', "</p><p>"));
        let wc = body.chars().filter(|c| !c.is_whitespace()).count() as i64;
        conn.execute(
            "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at) VALUES (?1,?2,NULL,?3,?4,?5,'draft',?6,?7,?8)",
            params![id, book_id, title, html, wc, i as i64, ts, ts],
        ).map_err(|e| e.to_string())?;
    }

    // 更新总字数
    let ts = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=?1 AND deleted_at IS NULL), updated_at=?2 WHERE id=?1",
        params![book_id, ts],
    ).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "chaptersCreated": created_count }))
}
