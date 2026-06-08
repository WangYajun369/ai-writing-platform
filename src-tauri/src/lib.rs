//! TimeWrite（智写时光）Tauri 应用主逻辑
//!
//! 负责：Tauri Builder 配置、插件注册、数据库初始化、38 个 IPC 命令注册。

mod commands;
mod db;
mod models;

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
            // 初始化数据库（应用级元数据库）
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("无法获取 AppData 目录");
            std::fs::create_dir_all(&app_dir)?;
            let db_path = app_dir.join("time_write.db");
            let db = AppDb::new(db_path.to_str().unwrap()).expect("数据库初始化失败");
            app.manage(db);
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
            // 卷
            commands::volume::list_volumes,
            commands::volume::create_volume,
            commands::volume::update_volume,
            commands::volume::delete_volume,
            commands::volume::reorder_volumes,
            // 章节
            commands::chapter::list_chapters,
            commands::chapter::get_chapter_content,
            commands::chapter::create_chapter,
            commands::chapter::save_chapter,
            commands::chapter::update_chapter_status,
            commands::chapter::rename_chapter,
            commands::chapter::delete_chapter,
            commands::chapter::reorder_chapters,
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
            // AI
            commands::ai::rag_search,
            commands::ai::trigger_embedding,
            commands::ai::check_embedding_status,
            commands::ai::stream_ai_chat,
            commands::ai::test_ai_connection,
            // 导入导出
            commands::io::export_book,
            commands::io::import_txt,
            // 窗口管理
            commands::window::open_world_window,
            commands::window::close_world_window,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
