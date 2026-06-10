//! 多窗口管理 IPC 命令
//!
//! 提供世界观资料库、版本历史、章节总结、AI 工具箱独立窗口的打开与关闭功能。
//! 独立窗口始终置顶于编辑页面之上。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

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
