//! TimeWrite（智写时光）Tauri 应用主逻辑
//!
//! 负责：Tauri Builder 配置、插件注册、数据库初始化、IPC 命令注册。
//!
//! # 架构概览
//!
//! ```
//! Tauri App (lib.rs)
//! ├── 插件层：shell / dialog / fs / updater / deep_link / http
//! ├── 数据层：AppDb（SQLite，存储书籍/卷/章节/快照/世界观）
//! ├── Agent 服务：Python AgentManager（本地 HTTP Server，端口 9877）
//! ├── Bridge 服务：Rust tiny_http Server（端口 9876，供 Python 回调查询数据）
//! └── IPC 命令：books / volumes / chapters / snapshots / world_cards / ai / io / image / window / agent
//! ```

// ─── 模块声明 ───
mod commands;   // Tauri IPC 命令集合
mod db;         // 数据库连接与初始化
mod error;      // 统一错误类型
mod models;     // 数据模型
mod python;     // Agent/Bridge 管理（Python 子进程 + Rust HTTP Bridge）
mod repository; // 数据访问层（DAO）
mod service;    // 业务逻辑层
mod utils;      // 工具函数

// ─── 标准库 ───
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ─── Tauri / Tokio ───
use tauri::{Emitter, Manager};

// ─── 内部模块 ───
use db::AppDb;
use python::{AgentManager, AgentServerConfig, bridge::{self, BridgeConfig}};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Tauri 应用的入口函数，负责构建并启动整个应用。
///
/// # 启动流程
///
/// 1. **注册插件** — shell / dialog / fs / updater / deep_link / http
/// 2. **初始化数据库** — 在 app_data_dir 下创建 `time_write.db`（SQLite）
/// 3. **启动 Agent Server** — 异步启动 Python Agent HTTP 服务（端口 9877）
/// 4. **启动看门狗** — 定期健康检查，Agent 异常退出时自动重启
/// 5. **启动 Bridge Server** — Rust tiny_http 服务（端口 9876），供 Python Agent 回调查询数据
/// 6. **等待 Bridge 就绪** — 轮询 TCP 连接，最多等 5 秒
/// 7. **注册窗口销毁钩子** — 主窗口关闭时自动清理调试窗口 + 停止 Agent
/// 8. **注册 IPC 命令** — 书籍/卷/章节/快照/世界观/AI/导入导出/图片/窗口/Agent
pub fn run() {
    tauri::Builder::default()
        // ────────── 插件注册 ──────────
        .plugin(tauri_plugin_shell::init())       // shell 命令调用
        .plugin(tauri_plugin_dialog::init())       // 文件选择对话框
        .plugin(tauri_plugin_fs::init())           // 文件系统访问
        .plugin(tauri_plugin_updater::Builder::new().build())  // 应用自动更新
        .plugin(tauri_plugin_deep_link::init())    // 深度链接
        .plugin(tauri_plugin_http::init())         // HTTP 请求
        // ────────── 应用启动配置 ──────────
        .setup(|app| {
            // ========== 1. 数据库初始化 ==========
            // 获取 Tauri 应用数据目录（跨平台兼容：macOS ~/Library/Application Support/...）
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
            // 打开 SQLite 数据库连接，交由 Tauri 状态管理（全局访问）
            let db = AppDb::new(db_path_str)
                .map_err(|e| format!("数据库初始化失败: {e}"))?;
            app.manage(db);

            // ========== 2. Agent Server 初始化 ==========
            // Agent 是一个独立的 Python FastAPI 服务，用于执行 AI Skill 调用
            let agent_config = AgentServerConfig::default();
            let agent = Arc::new(AgentManager::new(agent_config));

            // 异步启动 Agent Server（非阻塞，不阻塞 Tauri setup）
            let agent_clone = agent.clone();
            let handle_clone = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match agent_clone.start().await {
                    Ok(()) => {
                        // 启动成功：向前端推送 running 状态
                        let _ = handle_clone.emit("agent-status-changed", serde_json::json!({
                            "status": "running",
                            "message": "Agent 服务已启动"
                        }));
                    }
                    Err(e) => {
                        // 启动失败：向前端推送 crashed 状态（非致命，应用仍可使用）
                        eprintln!("[Agent] Server 启动失败（非致命）: {}", e);
                        let _ = handle_clone.emit("agent-status-changed", serde_json::json!({
                            "status": "crashed",
                            "message": format!("Agent 服务启动失败: {}", e)
                        }));
                    }
                }
            });

            // ========== 3. 健康检查看门狗 ==========
            // 定期检测 Agent Server 是否存活，异常退出时自动重启
            {
                let agent_wd = agent.clone();
                let handle_wd = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    AgentManager::spawn_watchdog(agent_wd, handle_wd);
                });
            }

            // 将 AgentManager 注入 Tauri 状态，供 IPC 命令通过 app.state() 访问
            app.manage(agent);

            // ========== 4. Bridge Server 初始化 ==========
            // Python Agent 通过 HTTP 回调 Rust 获取数据库数据（如书籍列表、章节内容等）
            // 在独立线程中启动 tiny_http server，监听 127.0.0.1:9876
            {
                let bridge_config = BridgeConfig::default();
                bridge::spawn_bridge(app_dir.join("time_write.db"), bridge_config);
            }

            // ========== 5. Bridge 就绪等待 ==========
            // Bridge Server 在独立线程中启动，需要短暂等待确保端口已监听。
            // 否则 Python Agent 工具在 Bridge 未就绪时调用会导致 "All connection attempts failed"。
            {
                let bridge_addr = format!("127.0.0.1:{}", BridgeConfig::default().port);
                eprintln!("[Bridge] 等待 Bridge Server 就绪: {}...", bridge_addr);
                let mut bridge_ready = false;
                // 轮询检测 TCP 连接：最多等待 5 秒，每 100ms 尝试一次
                for i in 0..50 {
                    std::thread::sleep(Duration::from_millis(100));
                    match TcpStream::connect_timeout(
                        &bridge_addr.parse().unwrap(),
                        Duration::from_millis(200),
                    ) {
                        Ok(_) => {
                            bridge_ready = true;
                            eprintln!("[Bridge] Bridge Server 已就绪 ({}ms)", (i + 1) * 100);
                            break;
                        }
                        Err(_) => {}  // 连接失败，继续等待
                    }
                }
                if !bridge_ready {
                    eprintln!("[Bridge] 警告: Bridge Server 在 5 秒内未就绪，Agent 工具调用可能失败");
                }
            }

            // ========== 6. 窗口关闭拦截 ==========
            // 用户点击关闭按钮时：
            //   ① 阻止立即关闭（显示"正在关闭..."）
            //   ② 通知前端展示遮罩
            //   ③ 后台清理 Agent Server + 关闭调试窗口
            //   ④ 清理完成后真正关闭窗口
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
                        let _ = handle.emit("agent-status-changed", serde_json::json!({
                            "status": "closing",
                            "message": "正在关闭服务..."
                        }));
                        eprintln!("[Agent] 主窗口关闭请求，开始清理 Agent Server...");

                        // 后台线程执行清理，完成后关闭窗口
                        if let Some(agent) = handle.try_state::<Arc<AgentManager>>() {
                            let agent = agent.inner().clone();
                            let handle_close = handle.clone();
                            std::thread::spawn(move || {
                                agent.force_shutdown_sync();
                                eprintln!("[Agent] ✅ Agent Server 清理完成，关闭窗口");
                                if let Some(w) = handle_close.get_webview_window("main") {
                                    let _ = w.close();
                                }
                            });
                        } else {
                            // 没有 Agent 状态，直接关闭
                            eprintln!("[Agent] 无 Agent 状态，直接关闭窗口");
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.close();
                            }
                        }
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
            // ══════ 窗口管理 — 调试控制台 ══════
            commands::window::debug::open_debug_window,
            commands::window::debug::close_debug_window,
            commands::window::debug::log_message,
            commands::window::debug::get_debug_logs,
            commands::window::debug::clear_debug_logs,
            // ══════ 窗口管理 — 数据库校验 ══════
            commands::window::validate::validate_database,
            // ══════ Agent Skills ══════
            commands::agent::skills::get_agent_status,
            commands::agent::skills::start_agent,
            commands::agent::skills::stop_agent,
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
