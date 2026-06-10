use tauri::{AppHandle, State};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use chrono::Utc;
use std::fmt::Write as FmtWrite;
use crate::db::AppDb;
use crate::models::{Book, Volume, Snapshot, WorldCard};
use crate::commands::window::emit_sql_log;

use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, KeyInit};
use rand::Rng;

/// 导出书籍（TXT / MD / HTML）
#[tauri::command]
pub async fn export_book(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    format: String,
    output_path: String,
) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

    // 获取书籍信息
    emit_sql_log(&app, "SELECT", "books", &format!("id={}, export info", book_id), file!(), line!());
    let (title, author): (String, String) = conn.query_row(
        "SELECT title,author FROM books WHERE id=?1",
        params![book_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| e.to_string())?;

    // 获取所有章节（按 sort_order）
    emit_sql_log(&app, "SELECT", "chapters", &format!("book_id={}, export chapters", book_id), file!(), line!());
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
    app: AppHandle,
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
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    use chrono::Utc;
    use uuid::Uuid;

    emit_sql_log(&app, "INSERT", "chapters", &format!("import_txt, {} chapters for book_id={}", created_count, book_id), file!(), line!());
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
    emit_sql_log(&app, "UPDATE", "books", &format!("recalc word_count for book_id={}", book_id), file!(), line!());
    conn.execute(
        "UPDATE books SET word_count=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=?1 AND deleted_at IS NULL), updated_at=?2 WHERE id=?1",
        params![book_id, ts],
    ).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "chaptersCreated": created_count }))
}

// ==================== 加密/解密工具 ====================

/// AES-256-GCM 加密密钥（32 字节）
const ENCRYPTION_KEY: &[u8; 32] = b"TimeWrite2024SecretKey!MirageInk";

/// 待加密的引导标识字符串
const MAGIC_PREFIX: &str = "TimeWrite";

/// AES-256-GCM 加密：nonce[12] + ciphertext + tag[16]
fn encrypt_bytes(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::from_slice(ENCRYPTION_KEY);
    let cipher = Aes256Gcm::new(key);
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("加密失败: {}", e))?;
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// AES-256-GCM 解密：输入为 nonce[12] + ciphertext + tag[16]
fn decrypt_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 28 {
        return Err("数据块太短，无法解密".to_string());
    }
    let key = Key::<Aes256Gcm>::from_slice(ENCRYPTION_KEY);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(&data[..12]);
    let plaintext = cipher
        .decrypt(nonce, &data[12..])
        .map_err(|e| format!("解密失败，密文可能已损坏或密钥不匹配: {}", e))?;
    Ok(plaintext)
}

/// 文件格式（二进制 `.tw`）：
///
///   [2 bytes: u16 BE = prefix_block 长度]
///   [prefix_block: encrypt_bytes(MAGIC_PREFIX)]
///   [data_block:   encrypt_bytes(JSON 载荷)]
fn build_encrypted_file(json_payload: &[u8]) -> Result<Vec<u8>, String> {
    let prefix_block = encrypt_bytes(MAGIC_PREFIX.as_bytes())?;
    let data_block = encrypt_bytes(json_payload)?;

    let prefix_len = prefix_block.len() as u16;
    let mut file_bytes = Vec::with_capacity(2 + prefix_block.len() + data_block.len());
    file_bytes.extend_from_slice(&prefix_len.to_be_bytes());
    file_bytes.extend_from_slice(&prefix_block);
    file_bytes.extend_from_slice(&data_block);
    Ok(file_bytes)
}

/// 解析加密文件并校验引导标识，校验通过后返回解密的 JSON 载荷
fn parse_encrypted_file(file_bytes: &[u8]) -> Result<String, String> {
    if file_bytes.len() < 4 {
        return Err("文件格式错误：文件内容太短，可能不是有效的 TimeWrite 备份文件。".to_string());
    }

    // 读取前缀块长度
    let prefix_len = u16::from_be_bytes([file_bytes[0], file_bytes[1]]) as usize;
    if prefix_len < 28 || file_bytes.len() < 2 + prefix_len + 28 {
        return Err("文件格式错误：前缀块长度异常，文件可能已损坏。".to_string());
    }

    // 解密前缀块
    let prefix_block = &file_bytes[2..2 + prefix_len];
    let prefix_plain = decrypt_bytes(prefix_block)
        .map_err(|e| format!("引导标识解密失败：{}", e))?;
    let prefix_str = String::from_utf8(prefix_plain)
        .map_err(|e| format!("引导标识编码异常: {}", e))?;

    if prefix_str != MAGIC_PREFIX {
        return Err(format!(
            "文件校验失败：引导标识不匹配，该文件不是有效的 TimeWrite 备份文件。\n期望: {}\n实际: {}",
            MAGIC_PREFIX, prefix_str
        ));
    }

    // 解密数据块
    let data_block = &file_bytes[2 + prefix_len..];
    let data_plain = decrypt_bytes(data_block)
        .map_err(|e| format!("数据解密失败：{}", e))?;

    let json_str = String::from_utf8(data_plain)
        .map_err(|e| format!("解密后的数据不是有效的 UTF-8 文本: {}", e))?;

    Ok(json_str)
}

/// 校验 JSON 载荷是否包含必需的字段结构
fn validate_payload_structure(json_str: &str) -> Result<(), String> {
    let val: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("JSON 格式校验失败：{}", e))?;

    let obj = val.as_object()
        .ok_or("JSON 格式校验失败：根节点必须是对象")?;

    // 必须字段
    for field in &["version", "exportedAt", "backupType", "database", "cache"] {
        if !obj.contains_key(*field) {
            return Err(format!("JSON 结构校验失败：缺少必需字段 \"{}\"", field));
        }
    }

    let backup_type = obj.get("backupType")
        .and_then(|v| v.as_str())
        .ok_or("JSON 结构校验失败：backupType 字段格式错误")?;

    if backup_type != "full" && backup_type != "single" {
        return Err(format!(
            "JSON 结构校验失败：backupType 必须是 \"full\" 或 \"single\"，当前值: \"{}\"",
            backup_type
        ));
    }

    let db = obj.get("database").and_then(|v| v.as_object())
        .ok_or("JSON 结构校验失败：database 字段缺失或格式错误")?;

    for table in &["books", "volumes", "chapters", "snapshots", "worldCards", "embeddings"] {
        if !db.contains_key(*table) {
            return Err(format!("JSON 结构校验失败：database 缺少表 \"{}\"", table));
        }
        if !db[*table].is_array() {
            return Err(format!("JSON 结构校验失败：database.{} 必须是数组", table));
        }
    }

    Ok(())
}

// ==================== 全量数据导出 ====================

/// 章节导出结构（含 HTML 正文内容，区别于列表场景不返回正文的 Chapter 模型）
#[derive(Serialize, Deserialize)]
struct ChapterExport {
    id: String,
    #[serde(rename = "bookId")]
    book_id: String,
    #[serde(rename = "volumeId")]
    volume_id: Option<String>,
    title: String,
    #[serde(rename = "contentHtml")]
    content_html: String,
    #[serde(rename = "wordCount")]
    word_count: i64,
    status: String,
    #[serde(rename = "sortOrder")]
    sort_order: i64,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "deletedAt")]
    deleted_at: Option<String>,
    summary: Option<String>,
    #[serde(rename = "summaryAt")]
    summary_at: Option<String>,
    outline: String,
}

/// Embedding 元数据导出（不含 BLOB 向量，可重新生成）
#[derive(Serialize, Deserialize)]
struct EmbeddingMetaExport {
    #[serde(rename = "sourceType")]
    source_type: String,
    #[serde(rename = "sourceId")]
    source_id: String,
    model: String,
    #[serde(rename = "createdAt")]
    created_at: String,
}

/// 数据库全量导出子模块
#[derive(Serialize, Deserialize)]
struct DatabaseExport {
    books: Vec<Book>,
    volumes: Vec<Volume>,
    chapters: Vec<ChapterExport>,
    snapshots: Vec<Snapshot>,
    #[serde(rename = "worldCards")]
    world_cards: Vec<WorldCard>,
    embeddings: Vec<EmbeddingMetaExport>,
}

/// 全量导出总载荷
#[derive(Serialize, Deserialize)]
struct ExportPayload {
    version: String,
    #[serde(rename = "exportedAt")]
    exported_at: String,
    /// 备份类型："full" = 全量备份，"single" = 单作品备份
    #[serde(rename = "backupType")]
    backup_type: String,
    database: DatabaseExport,
    /// 前端 localStorage 缓存数据（原样 JSON）
    cache: serde_json::Value,
}

/// 导出全部数据（数据库 + 前端缓存）为加密的 `.tw` 文件
///
/// `output_path` — 用户通过原生保存对话框选择的文件路径
/// `cache_json` — 前端收集的 localStorage 缓存数据（JSON 字符串）
#[tauri::command]
pub async fn export_all_data(
    app: AppHandle,
    db: State<'_, AppDb>,
    output_path: String,
    cache_json: String,
) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

    // 全量查询所有书籍（含已删除）
    emit_sql_log(&app, "SELECT", "books", "full export, all books", file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline FROM books"
    ).map_err(|e| e.to_string())?;
    let books: Vec<Book> = stmt.query_map([], |row| {
        let tags_str: String = row.get(9)?;
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
            tags: serde_json::from_str(&tags_str).unwrap_or_default(),
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            deleted_at: row.get(12)?,
            outline: row.get(13)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    emit_sql_log(&app, "SELECT", "volumes", "full export, all volumes", file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at,deleted_at FROM volumes"
    ).map_err(|e| e.to_string())?;
    let volumes: Vec<Volume> = stmt.query_map([], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    emit_sql_log(&app, "SELECT", "chapters", "full export, all chapters", file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline FROM chapters"
    ).map_err(|e| e.to_string())?;
    let chapters: Vec<ChapterExport> = stmt.query_map([], |row| {
        Ok(ChapterExport {
            id: row.get(0)?,
            book_id: row.get(1)?,
            volume_id: row.get(2)?,
            title: row.get(3)?,
            content_html: row.get::<_, String>(4).unwrap_or_default(),
            word_count: row.get(5)?,
            status: row.get(6)?,
            sort_order: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
            summary: row.get(11)?,
            summary_at: row.get(12)?,
            outline: row.get::<_, String>(13).unwrap_or_default(),
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    emit_sql_log(&app, "SELECT", "snapshots", "full export, all snapshots", file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,chapter_id,content_html,word_count,type,label,created_at FROM snapshots"
    ).map_err(|e| e.to_string())?;
    let snapshots: Vec<Snapshot> = stmt.query_map([], |row| {
        Ok(Snapshot {
            id: row.get(0)?,
            chapter_id: row.get(1)?,
            content_html: row.get(2)?,
            word_count: row.get(3)?,
            snapshot_type: row.get(4)?,
            label: row.get(5)?,
            created_at: row.get(6)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    emit_sql_log(&app, "SELECT", "world_cards", "full export, all world_cards", file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards"
    ).map_err(|e| e.to_string())?;
    let world_cards: Vec<WorldCard> = stmt.query_map([], |row| {
        let tags_str: String = row.get(6)?;
        Ok(WorldCard {
            id: row.get(0)?,
            book_id: row.get(1)?,
            card_type: row.get(2)?,
            title: row.get(3)?,
            content: row.get(4)?,
            content_html: row.get(5)?,
            tags: serde_json::from_str(&tags_str).unwrap_or_default(),
            vectorized: row.get::<_, i64>(7)? != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    emit_sql_log(&app, "SELECT", "embeddings", "full export, all embeddings meta", file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT source_type, source_id, COALESCE(model, '') as model, COALESCE(created_at, '') as created_at FROM embeddings"
    ).map_err(|e| e.to_string())?;
    let embeddings: Vec<EmbeddingMetaExport> = stmt.query_map([], |row| {
        Ok(EmbeddingMetaExport {
            source_type: row.get(0)?,
            source_id: row.get(1)?,
            model: row.get(2)?,
            created_at: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    let cache: serde_json::Value = serde_json::from_str(&cache_json)
        .map_err(|e| format!("缓存数据解析失败: {}", e))?;

    let payload = ExportPayload {
        version: "1.0".to_string(),
        exported_at: Utc::now().to_rfc3339(),
        backup_type: "full".to_string(),
        database: DatabaseExport { books, volumes, chapters, snapshots, world_cards, embeddings },
        cache,
    };

    let json = serde_json::to_string(&payload)
        .map_err(|e| format!("JSON 序列化失败: {}", e))?;

    // 加密并写入 .tw 文件
    let encrypted = build_encrypted_file(json.as_bytes())?;
    std::fs::write(&output_path, encrypted)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}

// ==================== 单作品数据导出 ====================

/// 导出单个作品的完整数据（数据库 + 前端缓存）为加密的 `.tw` 文件
///
/// 仅导出指定 `book_id` 关联的书籍、卷、章节、快照、世界观卡片和 embedding 元数据。
#[tauri::command]
pub async fn export_single_book(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    output_path: String,
    cache_json: String,
) -> Result<(), String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

    // 查询单本书籍
    emit_sql_log(&app, "SELECT", "books", &format!("id={}, single export", book_id), file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline FROM books WHERE id=?1"
    ).map_err(|e| e.to_string())?;
    let books: Vec<Book> = stmt.query_map(params![book_id], |row| {
        let tags_str: String = row.get(9)?;
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
            tags: serde_json::from_str(&tags_str).unwrap_or_default(),
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            deleted_at: row.get(12)?,
            outline: row.get(13)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    // 查询该作品的卷
    emit_sql_log(&app, "SELECT", "volumes", &format!("book_id={}, single export", book_id), file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,book_id,title,sort_order,created_at,deleted_at FROM volumes WHERE book_id=?1"
    ).map_err(|e| e.to_string())?;
    let volumes: Vec<Volume> = stmt.query_map(params![book_id], |row| {
        Ok(Volume {
            id: row.get(0)?,
            book_id: row.get(1)?,
            title: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    // 查询该作品的章节
    emit_sql_log(&app, "SELECT", "chapters", &format!("book_id={}, single export", book_id), file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline FROM chapters WHERE book_id=?1"
    ).map_err(|e| e.to_string())?;
    let chapters: Vec<ChapterExport> = stmt.query_map(params![book_id], |row| {
        Ok(ChapterExport {
            id: row.get(0)?,
            book_id: row.get(1)?,
            volume_id: row.get(2)?,
            title: row.get(3)?,
            content_html: row.get::<_, String>(4).unwrap_or_default(),
            word_count: row.get(5)?,
            status: row.get(6)?,
            sort_order: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
            summary: row.get(11)?,
            summary_at: row.get(12)?,
            outline: row.get::<_, String>(13).unwrap_or_default(),
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    // 查询该作品章节的快照（通过 chapter_id 关联）
    emit_sql_log(&app, "SELECT", "snapshots+chapters", &format!("book_id={}, single export", book_id), file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT s.id, s.chapter_id, s.content_html, s.word_count, s.type, s.label, s.created_at \
         FROM snapshots s INNER JOIN chapters c ON s.chapter_id = c.id WHERE c.book_id=?1"
    ).map_err(|e| e.to_string())?;
    let snapshots: Vec<Snapshot> = stmt.query_map(params![book_id], |row| {
        Ok(Snapshot {
            id: row.get(0)?,
            chapter_id: row.get(1)?,
            content_html: row.get(2)?,
            word_count: row.get(3)?,
            snapshot_type: row.get(4)?,
            label: row.get(5)?,
            created_at: row.get(6)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    // 查询该作品的世界观卡片
    emit_sql_log(&app, "SELECT", "world_cards", &format!("book_id={}, single export", book_id), file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at FROM world_cards WHERE book_id=?1"
    ).map_err(|e| e.to_string())?;
    let world_cards: Vec<WorldCard> = stmt.query_map(params![book_id], |row| {
        let tags_str: String = row.get(6)?;
        Ok(WorldCard {
            id: row.get(0)?,
            book_id: row.get(1)?,
            card_type: row.get(2)?,
            title: row.get(3)?,
            content: row.get(4)?,
            content_html: row.get(5)?,
            tags: serde_json::from_str(&tags_str).unwrap_or_default(),
            vectorized: row.get::<_, i64>(7)? != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    // 查询该作品章节的 embedding（通过 source_id 关联章节）
    // embedding 的 source_id 可能是 chapter_id 或 world_card_id
    emit_sql_log(&app, "SELECT", "embeddings", &format!("book_id={}, single export meta", book_id), file!(), line!());
    let mut stmt = conn.prepare(
        "SELECT e.source_type, e.source_id, COALESCE(e.model, '') as model, COALESCE(e.created_at, '') as created_at \
         FROM embeddings e WHERE e.source_id IN (SELECT id FROM chapters WHERE book_id=?1) \
         OR e.source_id IN (SELECT id FROM world_cards WHERE book_id=?1)"
    ).map_err(|e| e.to_string())?;
    let embeddings: Vec<EmbeddingMetaExport> = stmt.query_map(params![book_id], |row| {
        Ok(EmbeddingMetaExport {
            source_type: row.get(0)?,
            source_id: row.get(1)?,
            model: row.get(2)?,
            created_at: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    let cache: serde_json::Value = serde_json::from_str(&cache_json)
        .map_err(|e| format!("缓存数据解析失败: {}", e))?;

    let payload = ExportPayload {
        version: "1.0".to_string(),
        exported_at: Utc::now().to_rfc3339(),
        backup_type: "single".to_string(),
        database: DatabaseExport { books, volumes, chapters, snapshots, world_cards, embeddings },
        cache,
    };

    let json = serde_json::to_string(&payload)
        .map_err(|e| format!("JSON 序列化失败: {}", e))?;

    // 加密并写入 .tw 文件
    let encrypted = build_encrypted_file(json.as_bytes())?;
    std::fs::write(&output_path, encrypted)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}

// ==================== 统一数据导入 ====================

/// 校验全量备份：backupType 必须为 "full"
fn validate_full_backup_payload(json_str: &str) -> Result<(), String> {
    let val: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("JSON 解析失败: {}", e))?;

    let backup_type = val.get("backupType")
        .and_then(|v| v.as_str())
        .ok_or("校验失败：缺少 backupType 字段")?;

    if backup_type != "full" {
        return Err(format!(
            "备份类型不匹配：期望 \"full\"，实际为 \"{}\"",
            backup_type
        ));
    }
    Ok(())
}

/// 校验单作品备份：backupType 必须为 "single"，且 database.books 恰好包含 1 本书
fn validate_single_backup_payload(json_str: &str) -> Result<String, String> {
    // 先做通用结构校验
    validate_payload_structure(json_str)?;

    let val: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("JSON 解析失败: {}", e))?;

    let backup_type = val.get("backupType")
        .and_then(|v| v.as_str())
        .ok_or("校验失败：缺少 backupType 字段")?;
    if backup_type != "single" {
        return Err(format!(
            "备份类型不匹配：期望 \"single\"，实际为 \"{}\"",
            backup_type
        ));
    }

    let db = val.get("database")
        .and_then(|v| v.as_object())
        .ok_or("校验失败：database 字段格式错误")?;

    let books_arr = db.get("books")
        .and_then(|v| v.as_array())
        .ok_or("校验失败：database.books 不是数组")?;

    if books_arr.is_empty() {
        return Err("单作品备份校验失败：备份中不包含任何书籍数据".to_string());
    }
    if books_arr.len() > 1 {
        return Err(format!(
            "单作品备份校验失败：备份包含 {} 本书，这不是单作品备份文件",
            books_arr.len()
        ));
    }

    let book_id = books_arr[0]
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("校验失败：备份中的书籍缺少 id 字段")?
        .to_string();

    Ok(book_id)
}

/// 将备份数据写入数据库（通用，不管理事务）
fn write_backup_data(app: &AppHandle, conn: &rusqlite::Connection, dbx: &DatabaseExport) -> Result<(), rusqlite::Error> {
    emit_sql_log(app, "INSERT", "books", &format!("backup import: {} books", dbx.books.len()), file!(), line!());
    for book in &dbx.books {
        let tags_json = serde_json::to_string(&book.tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO books (id,title,author,description,cover_image,word_count,daily_target,today_count,db_path,tags,created_at,updated_at,deleted_at,outline) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                book.id, book.title, book.author, book.description,
                book.cover_image, book.word_count, book.daily_target, book.today_count,
                book.db_path, tags_json, book.created_at, book.updated_at,
                book.deleted_at, book.outline,
            ],
        )?;
    }

    emit_sql_log(app, "INSERT", "volumes", &format!("backup import: {} volumes", dbx.volumes.len()), file!(), line!());
    for vol in &dbx.volumes {
        conn.execute(
            "INSERT INTO volumes (id,book_id,title,sort_order,created_at,deleted_at) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![vol.id, vol.book_id, vol.title, vol.sort_order, vol.created_at, vol.deleted_at],
        )?;
    }

    emit_sql_log(app, "INSERT", "chapters", &format!("backup import: {} chapters", dbx.chapters.len()), file!(), line!());
    for ch in &dbx.chapters {
        conn.execute(
            "INSERT INTO chapters (id,book_id,volume_id,title,content_html,word_count,status,sort_order,created_at,updated_at,deleted_at,summary,summary_at,outline) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                ch.id, ch.book_id, ch.volume_id, ch.title, ch.content_html,
                ch.word_count, ch.status, ch.sort_order, ch.created_at, ch.updated_at,
                ch.deleted_at, ch.summary, ch.summary_at, ch.outline,
            ],
        )?;
    }

    emit_sql_log(app, "INSERT", "snapshots", &format!("backup import: {} snapshots", dbx.snapshots.len()), file!(), line!());
    for snap in &dbx.snapshots {
        conn.execute(
            "INSERT INTO snapshots (id,chapter_id,content_html,word_count,type,label,created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                snap.id, snap.chapter_id, snap.content_html, snap.word_count,
                snap.snapshot_type, snap.label, snap.created_at,
            ],
        )?;
    }

    emit_sql_log(app, "INSERT", "world_cards", &format!("backup import: {} world_cards", dbx.world_cards.len()), file!(), line!());
    for card in &dbx.world_cards {
        let tags_json = serde_json::to_string(&card.tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO world_cards (id,book_id,type,title,content,content_html,tags,vectorized,created_at,updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                card.id, card.book_id, card.card_type, card.title, card.content,
                card.content_html, tags_json, card.vectorized as i64,
                card.created_at, card.updated_at,
            ],
        )?;
    }

    Ok(())
}

/// 执行全量数据写入（事务内：清空所有表 → 写入备份数据）
fn run_full_import(app: &AppHandle, conn: &rusqlite::Connection, payload: &ExportPayload) -> Result<(), rusqlite::Error> {
    emit_sql_log(app, "DELETE", "all tables", "full import: clearing all data", file!(), line!());
    conn.execute("DELETE FROM embeddings", [])?;
    conn.execute("DELETE FROM snapshots", [])?;
    conn.execute("DELETE FROM world_cards", [])?;
    conn.execute("DELETE FROM chapters", [])?;
    conn.execute("DELETE FROM volumes", [])?;
    conn.execute("DELETE FROM books", [])?;

    write_backup_data(app, conn, &payload.database)
}

/// 执行单作品数据写入（事务内：仅删除目标作品数据 → 写入备份数据）
fn run_single_import(app: &AppHandle, conn: &rusqlite::Connection, payload: &ExportPayload, book_id: &str) -> Result<(), rusqlite::Error> {
    // 注意删除顺序：先删子表（embeddings、snapshots），再删主表（world_cards、chapters、volumes、books）
    emit_sql_log(app, "DELETE", "all tables", &format!("single import: clearing data for book_id={}", book_id), file!(), line!());
    conn.execute(
        "DELETE FROM embeddings WHERE source_id IN (SELECT id FROM chapters WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_id IN (SELECT id FROM world_cards WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute(
        "DELETE FROM snapshots WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute("DELETE FROM world_cards WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM chapters WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM volumes WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM books WHERE id=?1", params![book_id])?;

    write_backup_data(app, conn, &payload.database)
}

/// 统一数据导入命令
///
/// 流程：
/// 1. 读取加密 .tw 文件 → 解密 → 校验引导标识 "TimeWrite"
/// 2. 校验 JSON 结构完整性（含 backupType 字段必须为 "full" 或 "single"）
/// 3. 根据 backupType 进行针对性校验：
///    - "full"：全量备份校验
///    - "single"：单作品备份校验（恰好 1 本书）
/// 4. 全部校验通过后，在事务内写入数据库
///
/// 返回值：`{ cache: ..., backupType: "full" | "single" }`，前端据此恢复 localStorage 并展示提示
#[tauri::command]
pub async fn import_backup(
    app: AppHandle,
    db: State<'_, AppDb>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    // 1. 读取二进制文件
    let file_bytes = std::fs::read(&file_path)
        .map_err(|e| format!("读取文件失败：{}", e))?;

    // 2. 解密并校验引导标识
    let json_str = parse_encrypted_file(&file_bytes)?;

    // 3. 通用结构校验（含 backupType 字段校验）
    validate_payload_structure(&json_str)?;

    // 4. 解析为 ExportPayload
    let payload: ExportPayload = serde_json::from_str(&json_str)
        .map_err(|e| format!("JSON 解析失败（文件可能已损坏或版本不兼容）：{}", e))?;

    let backup_type = payload.backup_type.clone();
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;

    // 5. 根据备份类型进行针对性校验 → 校验通过后事务内写入
    match backup_type.as_str() {
        "full" => {
            // 全量备份校验
            validate_full_backup_payload(&json_str)?;

            let payload = payload; // 转移所有权避免借用冲突
            emit_sql_log(&app, "BEGIN", "transaction", "full import transaction", file!(), line!());
            conn.execute("BEGIN", [])
                .map_err(|e| format!("开始事务失败: {}", e))?;

            match run_full_import(&app, &conn, &payload) {
                Ok(()) => {
                    emit_sql_log(&app, "COMMIT", "transaction", "full import committed", file!(), line!());
                    conn.execute("COMMIT", [])
                        .map_err(|e| format!("提交事务失败: {}", e))?;
                }
                Err(e) => {
                    emit_sql_log(&app, "ROLLBACK", "transaction", "full import rolled back", file!(), line!());
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(format!("导入失败（事务已回滚，原数据未受影响）：{}", e));
                }
            }

            Ok(serde_json::json!({
                "cache": payload.cache,
                "backupType": "full",
            }))
        }
        "single" => {
            // 单作品备份校验（恰好 1 本书）
            let book_id = validate_single_backup_payload(&json_str)?;

            emit_sql_log(&app, "BEGIN", "transaction", &format!("single import transaction for book_id={}", book_id), file!(), line!());
            conn.execute("BEGIN", [])
                .map_err(|e| format!("开始事务失败: {}", e))?;

            match run_single_import(&app, &conn, &payload, &book_id) {
                Ok(()) => {
                    emit_sql_log(&app, "COMMIT", "transaction", "single import committed", file!(), line!());
                    conn.execute("COMMIT", [])
                        .map_err(|e| format!("提交事务失败: {}", e))?;
                }
                Err(e) => {
                    emit_sql_log(&app, "ROLLBACK", "transaction", "single import rolled back", file!(), line!());
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(format!("导入失败（事务已回滚，原数据未受影响）：{}", e));
                }
            }

            Ok(serde_json::json!({
                "cache": payload.cache,
                "backupType": "single",
            }))
        }
        _ => Err(format!("不支持的备份类型：\"{}\"", backup_type)),
    }
}
