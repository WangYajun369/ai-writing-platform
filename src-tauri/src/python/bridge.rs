//! Python → Rust 数据桥接 HTTP Server
//!
//! 启动一个轻量 HTTP Server 监听 127.0.0.1:9876，
//! 接收 Python Agent 的 LangChain Tool 回调请求，
//! 读取 SQLite 数据库并返回 JSON 数据。
//!
//! 支持的路由：
//! - POST /agent/read_chapter      → 读取章节内容
//! - POST /agent/list_chapters     → 列出所有章节
//! - POST /agent/search_world_cards → 搜索世界观卡片
//! - POST /agent/book_context      → 获取书籍上下文

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use r2d2::Pool;
use serde_json::Value;
use tiny_http::{Header, Response, Server, StatusCode};

use crate::db::SqliteConnectionManager;
use crate::error::AppError;
use crate::repository;

/// Bridge Server 配置
pub struct BridgeConfig {
    pub port: u16,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self { port: 9876 }
    }
}

/// Bridge Server 是否已就绪（原子标志，跨线程可见）
static BRIDGE_READY: AtomicBool = AtomicBool::new(false);

/// 检查 Bridge Server 是否已启动并监听
#[allow(dead_code)]
pub fn is_bridge_ready() -> bool {
    BRIDGE_READY.load(Ordering::Relaxed)
}

/// 处理单个 Bridge 请求
fn handle_bridge(
    pool: &Pool<SqliteConnectionManager>,
    method: &str,
    params: &Value,
) -> Result<Value, AppError> {
    let conn = pool.get().map_err(|e| AppError::DbPool(e.to_string()))?;

    match method {
        "read_chapter" => {
            let book_id = params["book_id"].as_str().unwrap_or("");
            let chapter_id = params["chapter_id"].as_str().unwrap_or("");

            let chapters = repository::chapter_repo::list_by_book(&conn, book_id)?;
            let chapter = chapters
                .iter()
                .find(|c| c.id == chapter_id)
                .ok_or_else(|| AppError::Business(format!("章节 {} 不存在", chapter_id)))?;

            let content = repository::chapter_repo::find_content(&conn, chapter_id)?;

            Ok(serde_json::json!({
                "id": chapter.id,
                "title": chapter.title,
                "content": content,
                "summary": chapter.summary,
            }))
        }

        "list_chapters" => {
            let book_id = params["book_id"].as_str().unwrap_or("");

            let chapters = repository::chapter_repo::list_by_book(&conn, book_id)?;

            let list: Vec<Value> = chapters
                .into_iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "title": c.title,
                        "summary": c.summary,
                    })
                })
                .collect();

            Ok(serde_json::json!({ "chapters": list }))
        }

        "search_world_cards" => {
            let book_id = params["book_id"].as_str().unwrap_or("");
            let query = params["query"].as_str().unwrap_or("");

            let cards = repository::world_card_repo::search_fts5(&conn, book_id, query, 20)
                .or_else(|_| {
                    repository::world_card_repo::search_like(
                        &conn,
                        book_id,
                        &format!("%{}%", query),
                        20,
                    )
                })?;

            let list: Vec<Value> = cards
                .into_iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.title,
                        "category": c.card_type,
                        "content": c.content,
                        "tags": c.tags,
                    })
                })
                .collect();

            Ok(serde_json::json!({ "cards": list }))
        }

        "book_context" => {
            let book_id = params["book_id"].as_str().unwrap_or("");

            let book = repository::book_repo::find_by_id(&conn, book_id)?;
            let chapters = repository::chapter_repo::list_by_book(&conn, book_id)?;
            let cards = repository::world_card_repo::list_by_book(&conn, book_id)?;

            let chapter_list: Vec<Value> = chapters
                .into_iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "title": c.title,
                        "summary": c.summary,
                    })
                })
                .collect();

            let card_list: Vec<Value> = cards
                .into_iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.title,
                        "category": c.card_type,
                        "content": c.content,
                        "tags": c.tags,
                    })
                })
                .collect();

            Ok(serde_json::json!({
                "book_id": book.id,
                "book_name": book.title,
                "chapters": chapter_list,
                "world_cards": card_list,
            }))
        }

        _ => Err(AppError::Business(format!("未知的回调方法: {}", method))),
    }
}

/// 启动 Bridge HTTP Server（阻塞式，需在独立线程中运行）
fn start_bridge_server(db_path: PathBuf, config: BridgeConfig) {
    // 在 Bridge 线程中创建独立的连接池
    let manager = SqliteConnectionManager::new(db_path.to_string_lossy().to_string());
    let pool = match Pool::builder()
        .max_size(4)
        .connection_timeout(std::time::Duration::from_secs(5))
        .build(manager)
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[Bridge] ❌ 无法创建 SQLite 连接池: {}", e);
            eprintln!("[Bridge] 数据库路径: {}", db_path.display());
            eprintln!("[Bridge] Agent 工具调用将全部失败！请检查数据库文件是否存在。");
            return;
        }
    };

    let addr = format!("127.0.0.1:{}", config.port);
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Bridge] ❌ 无法启动 Bridge Server ({}): {}", addr, e);
            eprintln!("[Bridge] 可能原因: 端口 {} 已被占用，请检查是否有其他进程监听此端口", config.port);
            eprintln!("[Bridge] 排查命令: lsof -i :{}", config.port);
            return;
        }
    };

    // 标记 Bridge 已就绪
    BRIDGE_READY.store(true, Ordering::Relaxed);
    eprintln!("[Bridge] ✅ Server 已启动，监听 {}", addr);

    for mut request in server.incoming_requests() {
        let url = request.url().to_string();

        // 只处理 POST /agent/{endpoint}
        if *request.method() != tiny_http::Method::Post || !url.starts_with("/agent/") {
            let resp = Response::from_string("Not Found")
                .with_status_code(StatusCode(404));
            let _ = request.respond(resp);
            continue;
        }

        let endpoint = url.trim_start_matches("/agent/");

        // 读取请求体
        let mut body = String::new();
        if let Err(e) = request.as_reader().read_to_string(&mut body) {
            eprintln!("[Bridge] ❌ 读取请求体失败: {} (endpoint={})", e, endpoint);
            let resp = Response::from_string(
                serde_json::json!({"success": false, "error": "读取请求体失败"}).to_string(),
            )
            .with_status_code(StatusCode(400))
            .with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
            );
            let _ = request.respond(resp);
            continue;
        }

        let params: Value = match serde_json::from_str(&body) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[Bridge] JSON 解析失败: {}", e);
                let resp = Response::from_string(
                    serde_json::json!({"success": false, "error": format!("JSON 解析失败: {}", e)}).to_string(),
                )
                .with_status_code(StatusCode(400))
                .with_header(
                    Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
                );
                let _ = request.respond(resp);
                continue;
            }
        };

        let result = handle_bridge(&pool, endpoint, &params);

        let response_body = match &result {
            Ok(data) => serde_json::json!({
                "data": data,
            }),
            Err(e) => serde_json::json!({
                "data": null,
                "error": e.to_string(),
            }),
        };

        let status = if result.is_ok() {
            StatusCode(200)
        } else {
            StatusCode(500)
        };

        let resp = Response::from_string(response_body.to_string())
            .with_status_code(status)
            .with_header(
                Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
            );

        if let Err(e) = request.respond(resp) {
            eprintln!("[Bridge] 响应发送失败: {}", e);
        }
    }
}

/// 在后台线程启动 Bridge Server
pub fn spawn_bridge(db_path: PathBuf, config: BridgeConfig) {
    thread::Builder::new()
        .name("bridge-server".into())
        .spawn(move || {
            start_bridge_server(db_path, config);
        })
        .expect("启动 Bridge Server 线程失败");
}
