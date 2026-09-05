//! TimeWrite（智写时光）Tauri 应用主逻辑
//!
//! 负责：Tauri Builder 配置、插件注册、数据库初始化、IPC 命令注册。
//!
//! # 架构概览
//!
//! ```
//! Tauri App (lib.rs)
//! ├── 插件层：shell / dialog / fs / updater / deep_link / http
//! ├── 数据层：AppDb（SQLite，存储书籍/卷/章节/快照/世界观/记忆）
//! ├── Agent 引擎：纯 Rust（Skill Prompt 组装 + SSE 流式 ReAct 工具循环，
//! │             原 Python Agent(9877)/Bridge(9876) 已移除）
//! └── IPC 命令：books / volumes / chapters / snapshots / world_cards / ai / io / image / window / agent
//! ```

// ─── 模块声明 ───
mod commands; // Tauri IPC 命令集合
mod db; // 数据库连接与初始化
mod error; // 统一错误类型
mod logging; // 全局日志宏（app_log! / app_log_error!，双写控制台与调试窗口）
mod models; // 数据模型
mod repository; // 数据访问层（DAO）
mod service; // 业务逻辑层
mod utils; // 工具函数

// ─── 标准库 ───
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// ─── Tauri / Tokio ───
use tauri::{Emitter, Manager};

// ─── 内部模块 ───
use db::AppDb;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Tauri 应用的入口函数，负责构建并启动整个应用。
///
/// # 启动流程
///
/// 1. **注册插件** — shell / dialog / fs / updater / deep_link / http
/// 2. **初始化数据库** — 在 app_data_dir 下创建 `time_write.db`（SQLite）
/// 3. **迁移旧记忆库** — 若存在旧 Python Agent 记忆库，导入到 time_write.db
/// 4. **注册窗口销毁钩子** — 主窗口关闭时自动清理调试窗口
/// 5. **注册 IPC 命令** — 书籍/卷/章节/快照/世界观/AI/导入导出/图片/窗口/Agent
pub fn run() {
    tauri::Builder::default()
        // ────────── 插件注册 ──────────
        .plugin(tauri_plugin_shell::init()) // shell 命令调用
        .plugin(tauri_plugin_dialog::init()) // 文件选择对话框
        .plugin(tauri_plugin_fs::init()) // 文件系统访问
        .plugin(tauri_plugin_updater::Builder::new().build()) // 应用自动更新
        .plugin(tauri_plugin_deep_link::init()) // 深度链接
        .plugin(tauri_plugin_http::init()) // HTTP 请求
        .plugin(tauri_plugin_notification::init()) // 系统通知（任务卡到期提醒）
        // ────────── 应用启动配置 ──────────
        .setup(|app| {
            // ========== 1. 数据库初始化 ==========
            // 获取 Tauri 应用数据目录（跨平台兼容：macOS ~/Library/Application Support/...）
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法获取 AppData 目录: {e}"))?;
            std::fs::create_dir_all(&app_dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
            let db_path = app_dir.join("time_write.db");
            let db_path_str = db_path
                .to_str()
                .ok_or("数据库路径包含非 UTF-8 字符，无法启动")?;
            // 打开 SQLite 数据库连接，交由 Tauri 状态管理（全局访问）
            let db = AppDb::new(db_path_str).map_err(|e| format!("数据库初始化失败: {e}"))?;
            // 附件存储初始化：附件目录与 db 同数据根（attachments/），
            // 并自动迁移旧版 task-attachments 目录、清洗历史绝对路径为相对路径
            crate::service::attachment_service::ensure_store(app.handle(), &db)
                .map_err(|e| format!("附件存储初始化失败: {e}"))?;
            app.manage(db);

            // ========== 1.5 备份加密密钥初始化 ==========
            // 密钥来源：环境变量 TIMEWRITE_BACKUP_KEY > <app_data_dir>/backup.key
            commands::io::crypto::init_backup_key(app.handle())
                .map_err(|e| format!("备份密钥初始化失败: {e}"))?;

            // ========== 1.6 旧版 Agent 记忆库迁移 ==========
            // 原 Python Agent 的记忆存放在独立的 agent_memory.db（开发模式位于
            // 项目根 data/ 下，打包模式可能随 cwd / app data 变化）。若存在则将
            // 存量记忆一次性导入 time_write.db 的 memories 表（幂等，仅空库时导入）。
            {
                let mut legacy_candidates = Vec::new();
                if let Ok(cwd) = std::env::current_dir() {
                    legacy_candidates.push(cwd.join("data").join("agent_memory.db"));
                }
                legacy_candidates.push(app_dir.join("agent_memory.db"));
                legacy_candidates.dedup();

                let state = app.state::<AppDb>();
                if let Ok(conn) = state.pool.get() {
                    for path in legacy_candidates {
                        if path.exists() {
                            crate::app_log!(
                                "[Agent] 检测到旧版记忆库，尝试导入: {}",
                                path.display()
                            );
                            match commands::agent::memory::migrate_legacy_db(&conn, &path) {
                                Ok(n) => crate::app_log!("[Agent] 记忆库迁移完成: 导入 {n} 条"),
                                Err(e) => crate::app_log_error!(
                                    "[Agent] 记忆库迁移失败（跳过，不影响启动）: {}",
                                    e
                                ),
                            }
                            break;
                        }
                    }
                    // 启动兜底：清理存量超限/过期记忆（幂等，无则零开销）
                    if let Err(e) = commands::agent::memory::prune_all_memories(&conn) {
                        crate::app_log_error!("[Agent] 记忆库存量清理失败（跳过）: {}", e);
                    }
                }
            }

            // ========== 2. 窗口关闭拦截 ==========
            // 用户点击关闭按钮时：
            //   ① 阻止立即关闭（显示"正在关闭..."）
            //   ② 通知前端展示遮罩
            //   ③ 关闭调试窗口
            //   ④ 真正关闭窗口
            //
            // 使用 AtomicBool 防止死循环：api.prevent_close() 后调用
            // window.close() 会再次触发 CloseRequested，第二次直接放行。
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let is_closing = Arc::new(AtomicBool::new(false));
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 已进入清理流程，第二次 CloseRequested 直接放行
                        if is_closing.swap(true, Ordering::SeqCst) {
                            return;
                        }

                        // 阻止窗口立即关闭
                        api.prevent_close();

                        // 关闭调试窗口
                        if let Some(debug) = handle.get_webview_window("debug") {
                            let _ = debug.close();
                        }

                        // 通知前端：正在关闭
                        let _ = handle.emit(
                            "agent-status-changed",
                            serde_json::json!({
                                "status": "closing",
                                "message": "正在关闭服务..."
                            }),
                        );

                        // 无外部 Agent 进程需要清理，直接关闭
                        crate::app_log!("[Agent] 主窗口关闭请求，直接关闭窗口");
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.close();
                        }
                    }
                });
            }

            // ========== 3. 任务卡到期提醒后台循环 ==========
            // 应用启动 20 秒后开始，每 60 秒扫描一次；偏好关闭时内部自动跳过。
            // 注意：提醒需要应用保持运行，Tauri 窗口全部关闭后进程退出，循环随之停止。
            {
                use std::time::Duration;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(20)).await;
                    loop {
                        let app = handle.clone();
                        match crate::service::reminder_service::run_once(&app) {
                            Ok(sent) => {
                                if sent > 0 {
                                    crate::app_log!("[提醒] 本轮发出 {sent} 条到期提醒");
                                }
                            }
                            Err(e) => {
                                crate::app_log!("[提醒] 本轮扫描失败（自动忽略）: {e}");
                            }
                        }
                        // 回收站 30 天自动清理（内部按自然日守卫，每天实际执行一次）
                        {
                            let db = app.state::<crate::db::AppDb>();
                            if let Err(e) =
                                crate::service::task_service::purge_expired_trash(&app, &db)
                            {
                                crate::app_log!("[回收站] 自动清理失败（自动忽略）: {e}");
                            }
                        }
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    }
                });
            }

            Ok(())
        })
        // ────────── IPC 命令注册 ──────────
        // 所有前端可通过 invoke() 调用的后端函数
        .invoke_handler(tauri::generate_handler![
            // ══════ 书籍管理 ══════
            commands::book::list_books,
            commands::book::get_book,
            commands::book::create_book,
            commands::book::update_book,
            commands::book::set_book_cover,
            commands::book::set_book_cover_data,
            commands::book::delete_book,
            commands::book::list_deleted_books,
            commands::book::restore_book,
            commands::book::hard_delete_book,
            commands::book::clear_book_trash,
            // ══════ 卷管理 ══════
            commands::volume::list_volumes,
            commands::volume::list_deleted_volumes,
            commands::volume::create_volume,
            commands::volume::update_volume,
            commands::volume::delete_volume,
            commands::volume::restore_volume,
            commands::volume::hard_delete_volume,
            commands::volume::reorder_volumes,
            // ══════ 章节管理 ══════
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
            // ══════ 快照管理 ══════
            commands::snapshot::list_snapshots,
            commands::snapshot::create_snapshot,
            commands::snapshot::get_snapshot_content,
            commands::snapshot::restore_snapshot,
            commands::snapshot::delete_snapshot,
            // ══════ 世界观管理 ══════
            commands::world_card::list_world_cards,
            commands::world_card::create_world_card,
            commands::world_card::update_world_card,
            commands::world_card::delete_world_card,
            commands::world_card::search_world_cards,
            // ══════ 写作统计 ══════
            commands::writing_stats::get_writing_stats,
            // ══════ 日记管理 ══════
            commands::diary::list_month_diaries,
            commands::diary::list_all_diaries,
            commands::diary::get_diary,
            commands::diary::save_diary,
            commands::diary::delete_diary,
            // ══════ 日程管理 ══════
            commands::schedule::list_schedules_by_date,
            commands::schedule::list_schedules_by_month,
            commands::schedule::save_schedule,
            commands::schedule::delete_schedule,
            // ══════ AI — 连接测试 ══════
            commands::ai::test::test_ai_connection,
            // ══════ AI — RAG / Embedding ══════
            commands::ai::embedding::rag_search,
            commands::ai::embedding::trigger_embedding,
            commands::ai::embedding::check_embedding_status,
            commands::ai::embedding::test_rag_connection,
            // ══════ AI — 流式对话 ══════
            commands::ai::chat::stream_ai_chat,
            // ══════ AI — 内容总结 ══════
            commands::ai::summarize::summarize_chapter,
            commands::ai::summarize::summarize_conversation,
            // ══════ 英语生词本（艾宾浩斯 / SM-2 复习）══════
            commands::vocab::vocab_add,
            commands::vocab::vocab_update,
            commands::vocab::vocab_set_status,
            commands::vocab::vocab_delete,
            commands::vocab::vocab_list,
            commands::vocab::vocab_due,
            commands::vocab::vocab_get,
            commands::vocab::vocab_review,
            commands::vocab::vocab_logs,
            commands::vocab::vocab_stats,
            // ══════ 英语字典（离线词库 + AI 释义）══════
            commands::vocab_dict::dict_status,
            commands::vocab_dict::dict_import,
            commands::vocab_dict::dict_lookup,
            commands::vocab_dict::dict_explain_ai,
            commands::vocab_dict::check_word_ai,
            // ══════ TTS 朗读（豆包语音合成）══════
            commands::tts::tts_speak,
            // ══════ 导入导出 — 格式导出 ══════
            commands::io::export::export_book,
            // ══════ 导入导出 — TXT 导入 ══════
            commands::io::import_txt::import_txt,
            // ══════ 导入导出 — 加密备份 ══════
            commands::io::backup::export_all_data,
            commands::io::backup::export_single_book,
            commands::io::backup::import_backup,
            // ══════ 图片处理 ══════
            commands::image::process_image,
            commands::image::process_image_cropped,
            // ══════ 窗口管理 — 独立窗口 ══════
            commands::window::manager::open_world_window,
            commands::window::manager::close_world_window,
            commands::window::manager::open_history_window,
            commands::window::manager::close_history_window,
            commands::window::manager::open_summary_window,
            commands::window::manager::close_summary_window,
            commands::window::manager::open_ai_toolbox_window,
            commands::window::manager::close_ai_toolbox_window,
            commands::window::manager::open_vocab_window,
            commands::window::manager::close_vocab_window,
            commands::window::manager::is_vocab_window_open,
            commands::window::manager::open_tasks_window,
            commands::window::manager::close_tasks_window,
            commands::window::manager::is_tasks_window_open,
            commands::window::manager::open_diary_book_window,
            commands::window::manager::close_diary_book_window,
            // ══════ 任务卡模块 ══════
            commands::project::project_list,
            commands::project::project_get,
            commands::project::project_create,
            commands::project::project_update,
            commands::project::project_delete,
            commands::project::project_restore,
            commands::project::project_hard_delete,
            commands::project::project_list_deleted,
            commands::project::project_clear_trash,
            commands::task::task_list,
            commands::task::task_list_all,
            commands::task::task_get,
            commands::task::task_create,
            commands::task::task_update,
            commands::task::task_set_status,
            commands::task::task_drag,
            commands::task::task_copy,
            commands::task::task_move_to_project,
            commands::task::task_delete,
            commands::task::task_restore,
            commands::task::task_hard_delete,
            commands::task::task_list_deleted,
            commands::task::task_clear_trash,
            commands::task::task_purge_expired_trash,
            commands::task::task_roll_planned_today,
            commands::task::task_today_overview,
            commands::tag::tag_list,
            commands::tag::tag_create,
            commands::tag::tag_update,
            commands::tag::tag_delete,
            commands::task_meta::task_meta_get,
            commands::task_meta::task_meta_set,
            commands::task_meta::reminder_prefs_get,
            commands::task_meta::reminder_prefs_set,
            commands::reminder::reminder_check,
            commands::migrate::migrate_schedules,
            commands::subtask::subtask_list,
            commands::subtask::subtask_create,
            commands::subtask::subtask_update,
            commands::subtask::subtask_set_done,
            commands::subtask::subtask_reorder,
            commands::subtask::subtask_delete,
            commands::template::template_list,
            commands::template::template_create,
            commands::template::template_update,
            commands::template::template_delete,
            commands::template::task_create_from_template,
            commands::attachment::attachment_list,
            commands::attachment::attachment_pick_and_add,
            commands::attachment::attachment_open,
            commands::attachment::attachment_delete,
            commands::attachment::attachment_cleanup_orphans,
            commands::activity::activity_list_task,
            commands::activity::activity_list_project,
            commands::activity::project_weekly_stats,
            // ══════ 窗口管理 — 调试控制台 ══════
            commands::window::debug::open_debug_window,
            commands::window::debug::close_debug_window,
            commands::window::debug::log_message,
            commands::window::debug::get_debug_logs,
            commands::window::debug::clear_debug_logs,
            // ══════ 窗口管理 — 数据库校验 ══════
            commands::window::validate::validate_database,
            // ══════ Agent Skills ══════
            commands::agent::skills::execute_agent_skill,
            commands::agent::skills::cancel_agent_skill,
            // ══════ Agent 记忆管理 ══════
            commands::agent::skills::list_agent_memories,
            commands::agent::skills::update_agent_memory,
            commands::agent::skills::delete_agent_memory,
            commands::agent::skills::clear_agent_memories,
            // ══════ 系统检查 ══════
            commands::system_check::system_check,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败——可能是系统资源不足或配置文件损坏");
}
