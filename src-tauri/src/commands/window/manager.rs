//! 独立窗口打开/关闭
//!
//! 世界观资料库、版本历史、章节总结、AI 工具箱独立窗口管理。
//! 独立窗口始终置顶于编辑页面之上。

use super::urlencoding;
use crate::error::AppError;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 窗口配置参数
#[derive(Clone, Copy)]
struct WindowConfig {
    label: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    query_param: &'static str,
    close_event: &'static str,
}

/// 构建子窗口 URL（根据 debug/release 选择 localhost 或 tauri://）
fn build_window_url(query_param: &str, extra_params: &str) -> Result<tauri::Url, AppError> {
    #[cfg(debug_assertions)]
    let url_str = format!("http://localhost:1420?{}=1{}", query_param, extra_params);
    #[cfg(not(debug_assertions))]
    let url_str = format!("tauri://localhost?{}=1{}", query_param, extra_params);

    tauri::Url::parse(&url_str).map_err(|e| AppError::Business(format!("URL 解析失败: {}", e)))
}

/// 创建子窗口并注册 Destroyed 事件回调
fn create_sub_window(
    app: &AppHandle,
    config: &WindowConfig,
    extra_params: &str,
) -> Result<(), AppError> {
    let url = build_window_url(config.query_param, extra_params)?;

    let w = WebviewWindowBuilder::new(app, config.label, WebviewUrl::External(url))
        .title(config.title)
        .inner_size(config.width, config.height)
        .min_inner_size(config.min_width, config.min_height)
        .always_on_top(true)
        .build()
        .map_err(|e| AppError::Business(format!("创建窗口失败: {}", e)))?;

    if let Some(main) = app.get_webview_window("main") {
        let close_event = config.close_event.to_string();
        w.on_window_event(move |win_event| {
            if let tauri::WindowEvent::Destroyed = win_event {
                let _ = main.emit(&close_event, ());
            }
        });
    }

    Ok(())
}

/// 关闭子窗口并通知主窗口
fn close_sub_window(app: &AppHandle, label: &str, close_event: &str) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(label) {
        w.close()
            .map_err(|e| AppError::Business(format!("关闭窗口失败: {}", e)))?;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(close_event, ());
    }
    Ok(())
}

// ---- 世界观资料库 ----

const WORLD_CONFIG: WindowConfig = WindowConfig {
    label: "world",
    title: "世界观资料库",
    width: 580.0,
    height: 680.0,
    min_width: 380.0,
    min_height: 420.0,
    query_param: "worldwin",
    close_event: "world-window-closed",
};

#[tauri::command]
pub async fn open_world_window(
    app: AppHandle,
    book_id: String,
    tab: Option<String>,
) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(WORLD_CONFIG.label) {
        w.close()
            .map_err(|e| AppError::Business(format!("关闭旧窗口失败: {}", e)))?;
    }
    let tab_param = tab.map(|t| format!("&tab={}", t)).unwrap_or_default();
    let extra = format!("&bookId={}{}", book_id, tab_param);
    create_sub_window(&app, &WORLD_CONFIG, &extra)
}

#[tauri::command]
pub async fn close_world_window(app: AppHandle) -> Result<(), AppError> {
    close_sub_window(&app, WORLD_CONFIG.label, WORLD_CONFIG.close_event)
}

// ---- 版本历史 ----

const HISTORY_CONFIG: WindowConfig = WindowConfig {
    label: "history",
    title: "版本历史",
    width: 400.0,
    height: 620.0,
    min_width: 320.0,
    min_height: 400.0,
    query_param: "historywin",
    close_event: "history-window-closed",
};

#[tauri::command]
pub async fn open_history_window(
    app: AppHandle,
    chapter_id: String,
    book_id: String,
    chapter_title: String,
) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(HISTORY_CONFIG.label) {
        w.close()
            .map_err(|e| AppError::Business(format!("关闭旧窗口失败: {}", e)))?;
    }
    let extra = format!(
        "&chapterId={}&bookId={}&chapterTitle={}",
        chapter_id,
        book_id,
        urlencoding(&chapter_title)
    );
    create_sub_window(&app, &HISTORY_CONFIG, &extra)
}

#[tauri::command]
pub async fn close_history_window(app: AppHandle) -> Result<(), AppError> {
    close_sub_window(&app, HISTORY_CONFIG.label, HISTORY_CONFIG.close_event)
}

// ---- 章节总结 ----

const SUMMARY_CONFIG: WindowConfig = WindowConfig {
    label: "summary",
    title: "章节总结",
    width: 520.0,
    height: 640.0,
    min_width: 360.0,
    min_height: 420.0,
    query_param: "summarywin",
    close_event: "summary-window-closed",
};

#[tauri::command]
pub async fn open_summary_window(
    app: AppHandle,
    chapter_id: String,
    book_id: String,
    chapter_title: String,
) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(SUMMARY_CONFIG.label) {
        w.close()
            .map_err(|e| AppError::Business(format!("关闭旧窗口失败: {}", e)))?;
    }
    let extra = format!(
        "&chapterId={}&bookId={}&chapterTitle={}",
        chapter_id,
        book_id,
        urlencoding(&chapter_title)
    );
    create_sub_window(&app, &SUMMARY_CONFIG, &extra)
}

#[tauri::command]
pub async fn close_summary_window(app: AppHandle) -> Result<(), AppError> {
    close_sub_window(&app, SUMMARY_CONFIG.label, SUMMARY_CONFIG.close_event)
}

// ---- AI 工具箱 ----

const AI_TOOLBOX_CONFIG: WindowConfig = WindowConfig {
    label: "ai-toolbox",
    title: "AI 工具箱",
    width: 820.0,
    height: 620.0,
    min_width: 640.0,
    min_height: 460.0,
    query_param: "aitoolboxwin",
    close_event: "ai-toolbox-window-closed",
};

#[tauri::command]
pub async fn open_ai_toolbox_window(app: AppHandle) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(AI_TOOLBOX_CONFIG.label) {
        w.close()
            .map_err(|e| AppError::Business(format!("关闭旧窗口失败: {}", e)))?;
    }
    create_sub_window(&app, &AI_TOOLBOX_CONFIG, "")
}

#[tauri::command]
pub async fn close_ai_toolbox_window(app: AppHandle) -> Result<(), AppError> {
    close_sub_window(&app, AI_TOOLBOX_CONFIG.label, AI_TOOLBOX_CONFIG.close_event)
}

// ---- 英语字典（生词本 / 艾宾浩斯复习）----

const VOCAB_CONFIG: WindowConfig = WindowConfig {
    label: "vocab",
    title: "英语字典 · 生词本",
    width: 920.0,
    height: 680.0,
    min_width: 720.0,
    min_height: 520.0,
    query_param: "vocabwin",
    close_event: "vocab-window-closed",
};

#[tauri::command]
pub async fn open_vocab_window(app: AppHandle) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(VOCAB_CONFIG.label) {
        w.close()
            .map_err(|e| AppError::Business(format!("关闭旧窗口失败: {}", e)))?;
    }
    create_sub_window(&app, &VOCAB_CONFIG, "")
}

#[tauri::command]
pub async fn close_vocab_window(app: AppHandle) -> Result<(), AppError> {
    close_sub_window(&app, VOCAB_CONFIG.label, VOCAB_CONFIG.close_event)
}

/// 查询英语字典窗口是否打开（供主窗口头部徽标/按钮状态使用）
#[tauri::command]
pub fn is_vocab_window_open(app: AppHandle) -> bool {
    app.get_webview_window(VOCAB_CONFIG.label).is_some()
}

// ---- 任务卡（个人项目管理）----

const TASKS_CONFIG: WindowConfig = WindowConfig {
    label: "tasks",
    title: "任务卡 · 项目管理",
    width: 960.0,
    height: 700.0,
    min_width: 760.0,
    min_height: 540.0,
    query_param: "taskswin",
    close_event: "tasks-window-closed",
};

/// 任务卡窗口可直达的视图区段（命令面板深链 / tasks-nav 导航事件）
pub const TASK_SECTION_TODAY: &str = "today";
pub const TASK_SECTION_ALL: &str = "all";

#[tauri::command]
pub async fn open_tasks_window(app: AppHandle, section: Option<String>) -> Result<(), AppError> {
    // 校验区段白名单
    if let Some(s) = section.as_deref() {
        if s != TASK_SECTION_TODAY && s != TASK_SECTION_ALL {
            return Err(AppError::Business(format!("无效的任务卡视图区段: {}", s)));
        }
    }

    if let Some(w) = app.get_webview_window(TASKS_CONFIG.label) {
        if let Some(s) = section {
            // 窗口已打开：定向导航（命令面板"打开今日/全部任务"语义）
            app.emit_to(TASKS_CONFIG.label, "tasks-nav", s)
                .map_err(|e| AppError::Business(format!("任务卡导航失败: {}", e)))?;
            w.set_focus().ok();
            return Ok(());
        }
        // 无区段：维持原 toggle 语义（点击首页入口开→再点关）
        w.close()
            .map_err(|e| AppError::Business(format!("关闭旧窗口失败: {}", e)))?;
        return Ok(());
    }
    let extra = section
        .map(|s| format!("&section={}", s))
        .unwrap_or_default();
    create_sub_window(&app, &TASKS_CONFIG, &extra)
}

#[tauri::command]
pub async fn close_tasks_window(app: AppHandle) -> Result<(), AppError> {
    close_sub_window(&app, TASKS_CONFIG.label, TASKS_CONFIG.close_event)
}

/// 查询任务卡窗口是否打开（供主窗口头部徽标/按钮状态使用）
#[tauri::command]
pub fn is_tasks_window_open(app: AppHandle) -> bool {
    app.get_webview_window(TASKS_CONFIG.label).is_some()
}

// ---- 看日记（书页式只读浏览）----

const DIARY_BOOK_CONFIG: WindowConfig = WindowConfig {
    label: "diary-book",
    title: "看日记",
    width: 1180.0,
    height: 780.0,
    min_width: 920.0,
    min_height: 600.0,
    query_param: "diarybookwin",
    close_event: "diary-book-window-closed",
};

/// 打开/切换「看日记」独立窗口（已打开则关闭，未打开则创建）
#[tauri::command]
pub async fn open_diary_book_window(app: AppHandle) -> Result<(), AppError> {
    if let Some(w) = app.get_webview_window(DIARY_BOOK_CONFIG.label) {
        w.close()
            .map_err(|e| AppError::Business(format!("关闭旧窗口失败: {}", e)))?;
        return Ok(());
    }
    create_sub_window(&app, &DIARY_BOOK_CONFIG, "")
}

#[tauri::command]
pub async fn close_diary_book_window(app: AppHandle) -> Result<(), AppError> {
    close_sub_window(&app, DIARY_BOOK_CONFIG.label, DIARY_BOOK_CONFIG.close_event)
}
