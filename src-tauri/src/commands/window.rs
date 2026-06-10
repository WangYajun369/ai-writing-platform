//! 多窗口管理 IPC 命令
//!
//! 提供世界观资料库、版本历史、章节总结、AI 工具箱、调试控制台独立窗口的打开与关闭功能。
//! 独立窗口始终置顶于编辑页面之上。

use std::sync::{Mutex, OnceLock};
use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
    /// 源文件完整路径（如 src/components/editor/RichTextEditor.tsx）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// 文件名（如 RichTextEditor.tsx）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// 源文件行号
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

/// 前端批量上报的日志条目（不含 timestamp，由后端填充）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntryInput {
    pub level: String,
    pub message: String,
    pub file: Option<String>,
    pub file_name: Option<String>,
    pub line: Option<u32>,
}

/// 全局日志缓冲区（最近 1000 条），调试窗口启动时加载历史日志
static LOG_BUFFER: OnceLock<Mutex<Vec<LogEntry>>> = OnceLock::new();

fn log_buffer() -> &'static Mutex<Vec<LogEntry>> {
    LOG_BUFFER.get_or_init(|| Mutex::new(Vec::with_capacity(1000)))
}

/// 简单 URL 编码（百分号编码非 ASCII 和保留字符）
fn urlencoding(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => result.push(b as char),
            _ => result.push_str(&format!("%{:02X}", b)),
        }
    }
    result
}

/// 打开世界观资料库独立窗口
///
/// 如果已存在 world 窗口则先关闭再以新 bookId 重新打开。
/// 窗口设为 always_on_top，始终浮于主窗口之上。
/// `tab` 参数可指定初始标签页（"cards" / "outline"），省略则默认 "cards"。
#[tauri::command]
pub async fn open_world_window(app: AppHandle, book_id: String, tab: Option<String>) -> Result<(), String> {
    // 若已存在则先关闭
    if let Some(w) = app.get_webview_window("world") {
        w.close().map_err(|e| e.to_string())?;
    }

    let tab_param = tab.map(|t| format!("&tab={}", t)).unwrap_or_default();

    // 开发/生产环境 URL 区分
    #[cfg(debug_assertions)]
    let url_str = format!("http://localhost:1420?worldwin=1&bookId={}{}", book_id, tab_param);
    #[cfg(not(debug_assertions))]
    let url_str = format!("tauri://localhost?worldwin=1&bookId={}{}", book_id, tab_param);

    let url = tauri::Url::parse(&url_str).map_err(|e| format!("URL 解析失败: {}", e))?;

    let w = WebviewWindowBuilder::new(&app, "world", WebviewUrl::External(url))
        .title("世界观资料库")
        .inner_size(580.0, 680.0)
        .min_inner_size(380.0, 420.0)
        .always_on_top(true)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    // 监听 world 窗口被用户主动关闭，通知主窗口更新按钮状态
    if let Some(main) = app.get_webview_window("main") {
        w.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = main.emit("world-window-closed", ());
            }
        });
    }

    Ok(())
}

/// 关闭世界观资料库独立窗口
///
/// 同时通知主窗口更新按钮状态。
#[tauri::command]
pub async fn close_world_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("world") {
        w.close().map_err(|e| e.to_string())?;
    }
    // 通知主窗口复位按钮
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("world-window-closed", ());
    }
    Ok(())
}

/// 打开版本历史独立窗口
///
/// 如果已存在 history 窗口则先关闭再以新 chapterId 重新打开。
/// 窗口设为 always_on_top，始终浮于主窗口之上。
#[tauri::command]
pub async fn open_history_window(
    app: AppHandle,
    chapter_id: String,
    book_id: String,
    chapter_title: String,
) -> Result<(), String> {
    // 若已存在则先关闭
    if let Some(w) = app.get_webview_window("history") {
        w.close().map_err(|e| e.to_string())?;
    }

    // 开发/生产环境 URL 区分（chapterTitle 需 URL 编码）
    #[cfg(debug_assertions)]
    let url_str = format!(
        "http://localhost:1420?historywin=1&chapterId={}&bookId={}&chapterTitle={}",
        chapter_id, book_id, urlencoding(&chapter_title)
    );
    #[cfg(not(debug_assertions))]
    let url_str = format!(
        "tauri://localhost?historywin=1&chapterId={}&bookId={}&chapterTitle={}",
        chapter_id, book_id, urlencoding(&chapter_title)
    );

    let url = tauri::Url::parse(&url_str).map_err(|e| format!("URL 解析失败: {}", e))?;

    let w = WebviewWindowBuilder::new(&app, "history", WebviewUrl::External(url))
        .title("版本历史")
        .inner_size(400.0, 620.0)
        .min_inner_size(320.0, 400.0)
        .always_on_top(true)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    // 监听 history 窗口被用户主动关闭，通知主窗口更新按钮状态
    if let Some(main) = app.get_webview_window("main") {
        w.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = main.emit("history-window-closed", ());
            }
        });
    }

    Ok(())
}

/// 关闭版本历史独立窗口
///
/// 同时通知主窗口更新按钮状态。
#[tauri::command]
pub async fn close_history_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("history") {
        w.close().map_err(|e| e.to_string())?;
    }
    // 通知主窗口复位按钮
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("history-window-closed", ());
    }
    Ok(())
}

/// 打开章节总结独立窗口
///
/// 如果已存在 summary 窗口则先关闭再以新 chapterId 重新打开。
/// 窗口设为 always_on_top，始终浮于主窗口之上。
#[tauri::command]
pub async fn open_summary_window(
    app: AppHandle,
    chapter_id: String,
    book_id: String,
    chapter_title: String,
) -> Result<(), String> {
    // 若已存在则先关闭
    if let Some(w) = app.get_webview_window("summary") {
        w.close().map_err(|e| e.to_string())?;
    }

    // 开发/生产环境 URL 区分（chapterTitle 需 URL 编码）
    #[cfg(debug_assertions)]
    let url_str = format!(
        "http://localhost:1420?summarywin=1&chapterId={}&bookId={}&chapterTitle={}",
        chapter_id, book_id, urlencoding(&chapter_title)
    );
    #[cfg(not(debug_assertions))]
    let url_str = format!(
        "tauri://localhost?summarywin=1&chapterId={}&bookId={}&chapterTitle={}",
        chapter_id, book_id, urlencoding(&chapter_title)
    );

    let url = tauri::Url::parse(&url_str).map_err(|e| format!("URL 解析失败: {}", e))?;

    let w = WebviewWindowBuilder::new(&app, "summary", WebviewUrl::External(url))
        .title("章节总结")
        .inner_size(520.0, 640.0)
        .min_inner_size(360.0, 420.0)
        .always_on_top(true)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    // 监听 summary 窗口被用户主动关闭，通知主窗口更新按钮状态
    if let Some(main) = app.get_webview_window("main") {
        w.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = main.emit("summary-window-closed", ());
            }
        });
    }

    Ok(())
}

/// 关闭章节总结独立窗口
///
/// 同时通知主窗口更新按钮状态。
#[tauri::command]
pub async fn close_summary_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("summary") {
        w.close().map_err(|e| e.to_string())?;
    }
    // 通知主窗口复位按钮
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("summary-window-closed", ());
    }
    Ok(())
}

/// 打开 AI 工具箱独立窗口
///
/// 如果已存在 ai-toolbox 窗口则先关闭再重新打开。
/// 窗口设为 always_on_top，始终浮于主窗口之上。
#[tauri::command]
pub async fn open_ai_toolbox_window(app: AppHandle) -> Result<(), String> {
    // 若已存在则先关闭
    if let Some(w) = app.get_webview_window("ai-toolbox") {
        w.close().map_err(|e| e.to_string())?;
    }

    // 开发/生产环境 URL 区分
    #[cfg(debug_assertions)]
    let url_str = "http://localhost:1420?aitoolboxwin=1".to_string();
    #[cfg(not(debug_assertions))]
    let url_str = "tauri://localhost?aitoolboxwin=1".to_string();

    let url = tauri::Url::parse(&url_str).map_err(|e| format!("URL 解析失败: {}", e))?;

    let w = WebviewWindowBuilder::new(&app, "ai-toolbox", WebviewUrl::External(url))
        .title("AI 工具箱")
        .inner_size(820.0, 620.0)
        .min_inner_size(640.0, 460.0)
        .always_on_top(true)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    // 监听 ai-toolbox 窗口被用户主动关闭，通知主窗口更新按钮状态
    if let Some(main) = app.get_webview_window("main") {
        w.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = main.emit("ai-toolbox-window-closed", ());
            }
        });
    }

    Ok(())
}

/// 关闭 AI 工具箱独立窗口
///
/// 同时通知主窗口更新按钮状态。
#[tauri::command]
pub async fn close_ai_toolbox_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("ai-toolbox") {
        w.close().map_err(|e| e.to_string())?;
    }
    // 通知主窗口复位按钮
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("ai-toolbox-window-closed", ());
    }
    Ok(())
}

// ==================== SQL 操作日志 ====================

/// 向调试面板发送 SQL 操作日志
///
/// 所有命令文件通过此函数将 SQL 执行记录发送到调试窗口，
/// 便于开发者追踪数据库操作调用链和排查数据问题。
pub fn emit_sql_log(app: &tauri::AppHandle, operation: &str, table: &str, detail: &str, file: &str, line: u32) {
    let _ = app.emit("debug-log", &LogEntry {
        timestamp: Local::now().format("%H:%M:%S").to_string(),
        level: "info".to_string(),
        message: format!("[SQL] {} → {} | {}", operation, table, detail),
        file: Some(file.to_string()),
        file_name: Some(file.split('/').last().unwrap_or(file).to_string()),
        line: Some(line),
    });
}

// ==================== 调试控制台 ====================

/// 接收前端批量日志并广播到调试窗口
///
/// 所有窗口（包括独立窗口）的 console.log/warn/error 都会通过此命令
/// 汇聚到全局日志缓冲区，并实时广播给调试窗口。
/// entries 中每条日志含 level/message/file/fileName/line，timestamp 由后端填充。
#[tauri::command]
pub async fn log_message(app: AppHandle, entries: Vec<LogEntryInput>) -> Result<(), String> {
    let mut buffer = log_buffer().lock().map_err(|e| e.to_string())?;

    for input in entries {
        let entry = LogEntry {
            timestamp: Local::now().format("%H:%M:%S").to_string(),
            level: input.level,
            message: input.message,
            file: input.file,
            file_name: input.file_name,
            line: input.line,
        };

        if buffer.len() >= 1000 {
            buffer.remove(0);
        }
        buffer.push(entry.clone());

        // 逐条广播到所有窗口
        let _ = app.emit("debug-log", &entry);
    }

    Ok(())
}

/// 打开调试控制台独立窗口
///
/// 窗口设为 always_on_top，始终浮于其他窗口之上。
/// 主窗口关闭时此窗口自动关闭（由 setup 中的事件监听保证）。
#[tauri::command]
pub async fn open_debug_window(app: AppHandle) -> Result<(), String> {
    // 若已存在则先关闭
    if let Some(w) = app.get_webview_window("debug") {
        w.close().map_err(|e| e.to_string())?;
    }

    #[cfg(debug_assertions)]
    let url_str = "http://localhost:1420?debugwin=1".to_string();
    #[cfg(not(debug_assertions))]
    let url_str = "tauri://localhost?debugwin=1".to_string();

    let url = tauri::Url::parse(&url_str).map_err(|e| format!("URL 解析失败: {}", e))?;

    let w = WebviewWindowBuilder::new(&app, "debug", WebviewUrl::External(url))
        .title("调试控制台")
        .inner_size(820.0, 560.0)
        .min_inner_size(420.0, 320.0)
        .always_on_top(true)
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    // 监听 debug 窗口被用户主动关闭，通知主窗口更新按钮状态
    if let Some(main) = app.get_webview_window("main") {
        w.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = main.emit("debug-window-closed", ());
            }
        });
    }

    Ok(())
}

/// 关闭调试控制台独立窗口
///
/// 同时通知主窗口更新按钮状态。
#[tauri::command]
pub async fn close_debug_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("debug") {
        w.close().map_err(|e| e.to_string())?;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("debug-window-closed", ());
    }
    Ok(())
}

/// 获取所有已缓存的日志（调试窗口启动时加载历史日志）
#[tauri::command]
pub async fn get_debug_logs() -> Result<Vec<LogEntry>, String> {
    let buffer = log_buffer();
    let logs = buffer.lock().map_err(|e| e.to_string())?;
    Ok(logs.clone())
}

/// 清空所有缓存的日志
#[tauri::command]
pub async fn clear_debug_logs() -> Result<(), String> {
    let buffer = log_buffer();
    let mut logs = buffer.lock().map_err(|e| e.to_string())?;
    logs.clear();
    Ok(())
}

// ==================== 数据库校验 ====================

/// 数据库校验结果 — 单条问题
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    /// missing_table | missing_column | integrity_error | orphan_record
    pub issue_type: String,
    pub detail: String,
}

/// 数据库校验总结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub ok: bool,
    pub tables_count: usize,
    pub issues: Vec<ValidationIssue>,
}

/// 每张表的预期列定义
const EXPECTED_SCHEMA: &[(&str, &[&str])] = &[
    ("books", &["id", "title", "author", "description", "cover_image", "word_count", "daily_target", "today_count", "db_path", "tags", "created_at", "updated_at", "deleted_at", "outline"]),
    ("volumes", &["id", "book_id", "title", "sort_order", "created_at", "deleted_at"]),
    ("chapters", &["id", "book_id", "volume_id", "title", "content_html", "word_count", "status", "sort_order", "deleted_at", "created_at", "updated_at", "summary", "summary_at", "outline"]),
    ("snapshots", &["id", "chapter_id", "content_html", "word_count", "type", "label", "created_at"]),
    ("world_cards", &["id", "book_id", "type", "title", "content", "content_html", "tags", "vectorized", "created_at", "updated_at"]),
    ("embeddings", &["id", "source_type", "source_id", "embedding", "model", "created_at"]),
];

/// 校验本地 SQLite 数据库：表结构完整性 + 数据完整性（PRAGMA integrity_check + 外键孤儿检测）
#[tauri::command]
pub async fn validate_database(app: AppHandle) -> Result<ValidationResult, String> {
    let db = app.state::<crate::db::AppDb>();
    let conn = db.pool.get().map_err(|e| format!("获取数据库连接失败: {}", e))?;
    let mut issues = Vec::new();

    // 1. 检查所有表是否存在
    // 注意：LIKE 中 _ 是通配符，不能直接用 NOT LIKE '_%' 排除下划线开头
    let tables_sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
    let mut stmt = conn.prepare(tables_sql).map_err(|e| e.to_string())?;
    let existing_tables: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let tables_count = existing_tables.len();

    // 输出诊断日志到调试面板
    let _ = app.emit("debug-log", LogEntry {
        timestamp: Local::now().format("%H:%M:%S").to_string(),
        level: "log".to_string(),
        message: format!("[validate_database] 发现 {} 张表: {:?}", tables_count, existing_tables),
        file: Some("src-tauri/src/commands/window.rs".to_string()),
        file_name: Some("window.rs".to_string()),
        line: Some(line!()),
    });

    for (table_name, expected_cols) in EXPECTED_SCHEMA {
        if !existing_tables.contains(&table_name.to_string()) {
            issues.push(ValidationIssue {
                table: table_name.to_string(),
                column: None,
                issue_type: "missing_table".to_string(),
                detail: format!("缺少表: {}", table_name),
            });
            continue;
        }

        // 2. 检查每张表的列是否齐全
        let cols_sql = &format!("PRAGMA table_info({})", table_name);
        let mut col_stmt = conn.prepare(cols_sql).map_err(|e| e.to_string())?;
        let existing_cols: Vec<String> = col_stmt
            .query_map([], |row| row.get::<_, String>(1)) // column name is at index 1
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        for expected in *expected_cols {
            if !existing_cols.contains(&expected.to_string()) {
                issues.push(ValidationIssue {
                    table: table_name.to_string(),
                    column: Some(expected.to_string()),
                    issue_type: "missing_column".to_string(),
                    detail: format!("表 {} 缺少列: {}", table_name, expected),
                });
            }
        }
    }

    // 3. PRAGMA integrity_check 数据完整性校验
    let integrity_result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if integrity_result != "ok" {
        for line in integrity_result.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                issues.push(ValidationIssue {
                    table: "-".to_string(),
                    column: None,
                    issue_type: "integrity_error".to_string(),
                    detail: trimmed.to_string(),
                });
            }
        }
    }

    // 4. 外键孤儿检测
    // volumes.book_id → books.id
    {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM volumes WHERE book_id NOT IN (SELECT id FROM books)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            issues.push(ValidationIssue {
                table: "volumes".to_string(),
                column: Some("book_id".to_string()),
                issue_type: "orphan_record".to_string(),
                detail: format!("volumes 中有 {} 条记录的 book_id 指向不存在的书籍", count),
            });
        }
    }

    // chapters.book_id → books.id
    {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chapters WHERE book_id NOT IN (SELECT id FROM books)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            issues.push(ValidationIssue {
                table: "chapters".to_string(),
                column: Some("book_id".to_string()),
                issue_type: "orphan_record".to_string(),
                detail: format!("chapters 中有 {} 条记录的 book_id 指向不存在的书籍", count),
            });
        }
    }

    // chapters.volume_id → volumes.id（排除 NULL）
    {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chapters WHERE volume_id IS NOT NULL AND volume_id NOT IN (SELECT id FROM volumes)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            issues.push(ValidationIssue {
                table: "chapters".to_string(),
                column: Some("volume_id".to_string()),
                issue_type: "orphan_record".to_string(),
                detail: format!("chapters 中有 {} 条记录的 volume_id 指向不存在的卷", count),
            });
        }
    }

    // snapshots.chapter_id → chapters.id
    {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM snapshots WHERE chapter_id NOT IN (SELECT id FROM chapters)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            issues.push(ValidationIssue {
                table: "snapshots".to_string(),
                column: Some("chapter_id".to_string()),
                issue_type: "orphan_record".to_string(),
                detail: format!("snapshots 中有 {} 条记录的 chapter_id 指向不存在的章节", count),
            });
        }
    }

    // world_cards.book_id → books.id
    {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM world_cards WHERE book_id NOT IN (SELECT id FROM books)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if count > 0 {
            issues.push(ValidationIssue {
                table: "world_cards".to_string(),
                column: Some("book_id".to_string()),
                issue_type: "orphan_record".to_string(),
                detail: format!("world_cards 中有 {} 条记录的 book_id 指向不存在的书籍", count),
            });
        }
    }

    Ok(ValidationResult {
        ok: issues.is_empty(),
        tables_count,
        issues,
    })
}
