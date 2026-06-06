//! 多窗口管理 IPC 命令
//!
//! 提供世界观资料库独立窗口的打开与关闭功能。
//! 世界窗口始终置顶于编辑页面之上。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 打开世界观资料库独立窗口
///
/// 如果已存在 world 窗口则先关闭再以新 bookId 重新打开。
/// 窗口设为 always_on_top，始终浮于主窗口之上。
#[tauri::command]
pub async fn open_world_window(app: AppHandle, book_id: String) -> Result<(), String> {
    // 若已存在则先关闭
    if let Some(w) = app.get_webview_window("world") {
        w.close().map_err(|e| e.to_string())?;
    }

    // 开发/生产环境 URL 区分
    #[cfg(debug_assertions)]
    let url_str = format!("http://localhost:1420?worldwin=1&bookId={}", book_id);
    #[cfg(not(debug_assertions))]
    let url_str = format!("tauri://localhost?worldwin=1&bookId={}", book_id);

    let url = tauri::Url::parse(&url_str).map_err(|e| format!("URL 解析失败: {}", e))?;

    let w = WebviewWindowBuilder::new(&app, "world", WebviewUrl::External(url))
        .title("世界观资料库")
        .inner_size(420.0, 650.0)
        .min_inner_size(320.0, 400.0)
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
