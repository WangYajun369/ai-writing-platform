//! TimeWrite（智写时光）Tauri 应用主逻辑
//!
//! 负责：Tauri Builder 配置、插件注册、数据库初始化、IPC 命令注册。

mod commands;
mod db;
mod error;
mod models;
mod repository;
mod service;
mod utils;

use tauri::Manager;
use db::AppDb;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法获取 AppData 目录: {e}"))?;
            std::fs::create_dir_all(&app_dir)
                .map_err(|e| format!("创建数据目录失败: {e}"))?;
            let db_path = app_dir.join("time_write.db");
            let db_path_str = db_path
                .to_str()
                .ok_or("数据库路径包含非 UTF-8 字符，无法启动")?;
            let db = AppDb::new(db_path_str)
                .map_err(|e| format!("数据库初始化失败: {e}"))?;
            app.manage(db);

            // 主窗口关闭时自动关闭调试窗口
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        if let Some(debug) = handle.get_webview_window("debug") {
                            let _ = debug.close();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 书籍
            commands::book::list_books,
            commands::book::get_book,
            commands::book::create_book,
            commands::book::update_book,
            commands::book::set_book_cover,
            commands::book::delete_book,
            commands::book::list_deleted_books,
            commands::book::restore_book,
            commands::book::hard_delete_book,
            commands::book::clear_book_trash,
            // 卷
            commands::volume::list_volumes,
            commands::volume::list_deleted_volumes,
            commands::volume::create_volume,
            commands::volume::update_volume,
            commands::volume::delete_volume,
            commands::volume::restore_volume,
            commands::volume::hard_delete_volume,
            commands::volume::reorder_volumes,
            // 章节
            commands::chapter::list_chapters,
            commands::chapter::list_deleted_chapters,
            commands::chapter::get_chapter_content,
            commands::chapter::create_chapter,
            commands::chapter::save_chapter,
            commands::chapter::update_chapter_status,
            commands::chapter::rename_chapter,
            commands::chapter::delete_chapter,
            commands::chapter::restore_chapter,
            commands::chapter::hard_delete_chapter,
            commands::chapter::reorder_chapters,
            commands::chapter::move_chapter_to_volume,
            commands::chapter::save_chapter_summary,
            commands::chapter::clear_chapter_summary,
            commands::chapter::get_chapter_summary,
            commands::chapter::save_chapter_outline,
            // 快照
            commands::snapshot::list_snapshots,
            commands::snapshot::create_snapshot,
            commands::snapshot::get_snapshot_content,
            commands::snapshot::restore_snapshot,
            commands::snapshot::delete_snapshot,
            // 世界观
            commands::world_card::list_world_cards,
            commands::world_card::create_world_card,
            commands::world_card::update_world_card,
            commands::world_card::delete_world_card,
            commands::world_card::search_world_cards,
            // AI — 连接测试
            commands::ai::test::test_ai_connection,
            // AI — RAG / Embedding
            commands::ai::embedding::rag_search,
            commands::ai::embedding::trigger_embedding,
            commands::ai::embedding::check_embedding_status,
            commands::ai::embedding::test_rag_connection,
            // AI — 流式对话
            commands::ai::chat::stream_ai_chat,
            // AI — 内容总结
            commands::ai::summarize::summarize_chapter,
            commands::ai::summarize::summarize_conversation,
            // 导入导出 — 格式导出
            commands::io::export::export_book,
            // 导入导出 — TXT 导入
            commands::io::import_txt::import_txt,
            // 导入导出 — 加密备份
            commands::io::backup::export_all_data,
            commands::io::backup::export_single_book,
            commands::io::backup::import_backup,
            // 图片处理
            commands::image::process_image,
            // 窗口管理 — 独立窗口
            commands::window::manager::open_world_window,
            commands::window::manager::close_world_window,
            commands::window::manager::open_history_window,
            commands::window::manager::close_history_window,
            commands::window::manager::open_summary_window,
            commands::window::manager::close_summary_window,
            commands::window::manager::open_ai_toolbox_window,
            commands::window::manager::close_ai_toolbox_window,
            // 窗口管理 — 调试控制台
            commands::window::debug::open_debug_window,
            commands::window::debug::close_debug_window,
            commands::window::debug::log_message,
            commands::window::debug::get_debug_logs,
            commands::window::debug::clear_debug_logs,
            // 窗口管理 — 数据库校验
            commands::window::validate::validate_database,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败——可能是系统资源不足或配置文件损坏");
}
