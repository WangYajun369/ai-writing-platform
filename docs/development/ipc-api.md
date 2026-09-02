# IPC 命令速查

> **适用版本**：`1.0.0`　|　**最后核对**：2026-08-31

TimeWrite 共注册 **82 个 IPC 命令**，全部在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中集中注册，前端通过 `src/lib/tauri-bridge.ts` 调用。

> **架构约定**：`tauri-bridge.ts` 是全项目**唯一**允许调用 `invoke` 的模块。禁止在其他文件中直接 import `@tauri-apps/api` 的 `invoke`。

---

## 命令总览

| 模块 | 命令数 | Rust 源文件 |
|------|:---:|------|
| [书籍](#书籍-book) | 11 | `commands/book.rs` |
| [卷](#卷-volume) | 8 | `commands/volume.rs` |
| [章节](#章节-chapter) | 16 | `commands/chapter.rs` |
| [快照](#快照-snapshot) | 5 | `commands/snapshot.rs` |
| [世界观](#世界观-world_card) | 5 | `commands/world_card.rs` |
| [AI](#ai-commandsai) | 8 | `commands/ai/{test,embedding,chat,summarize}.rs` |
| [导入导出](#导入导出-commandsio) | 5 | `commands/io/{export,import_txt,backup}.rs` |
| [图片](#图片-image) | 2 | `commands/image.rs` |
| [窗口](#窗口-commandswindow) | 12 | `commands/window/{manager,debug,validate}.rs` |
| [Agent](#agent-commandsagent) | 9 | `commands/agent/skills.rs` |
| [系统](#系统检查-system_check) | 1 | `commands/system_check.rs` |
| **合计** | **82** | — |

---

## 分层调用链

```
React 组件 → Zustand/Jotai → tauri-bridge.ts → invoke()
  → commands/（参数校验，无 SQL）
    → service/（事务边界、业务规则、SQL 审计日志 emit_sql_log）
      → repository/（纯 SQL，接受 &Connection，无业务逻辑）
        → db/（r2d2 连接池 + SQLite WAL + FTS5）
```

各层职责边界在对应 `mod.rs` 注释中有明确约定：repository 层**不依赖 Tauri State / AppHandle**，命令层**不包含 SQL**。

---

## 书籍 `book`

| 命令 | 说明 |
|------|------|
| `list_books` | 列出所有书籍（排除软删除） |
| `get_book` | 获取单本书详情 |
| `create_book` | 创建新书籍（自动创建默认卷） |
| `update_book` | 更新书籍元信息 |
| `set_book_cover` | 设置书籍封面（文件路径） |
| `set_book_cover_data` | 设置封面（Base64 data URL 直传） |
| `delete_book` | 软删除书籍（级联子孙卷/章） |
| `list_deleted_books` | 列出回收站中的书籍 |
| `restore_book` | 恢复已删除书籍 |
| `hard_delete_book` | 彻底删除书籍 |
| `clear_book_trash` | 清空回收站 |

## 卷 `volume`

| 命令 | 说明 |
|------|------|
| `list_volumes` | 列出书籍下所有卷 |
| `list_deleted_volumes` | 列出回收站卷 |
| `create_volume` | 创建新卷 |
| `update_volume` | 更新卷名 |
| `delete_volume` | 软删除卷（级联章节） |
| `restore_volume` | 恢复已删除卷 |
| `hard_delete_volume` | 彻底删除卷 |
| `reorder_volumes` | 卷排序 |

## 章节 `chapter`

| 命令 | 说明 |
|------|------|
| `list_chapters` | 列出章节列表 |
| `list_deleted_chapters` | 列出回收站章节 |
| `get_chapter_content` | 获取章节正文 |
| `create_chapter` | 创建新章节 |
| `save_chapter` | 保存章节内容（事务：更新内容 + 重算全书字数） |
| `update_chapter_status` | 更新章节状态（大纲/草稿/润色中/已完成） |
| `rename_chapter` | 重命名章节 |
| `delete_chapter` | 软删除章节 |
| `restore_chapter` | 恢复章节 |
| `hard_delete_chapter` | 彻底删除章节 |
| `reorder_chapters` | 章节排序 |
| `move_chapter_to_volume` | 移动章节到其他卷 |
| `save_chapter_summary` | 保存 AI 章节总结 |
| `clear_chapter_summary` | 清除章节总结 |
| `get_chapter_summary` | 获取章节总结 |
| `save_chapter_outline` | 保存章节大纲 |

## 快照 `snapshot`

| 命令 | 说明 |
|------|------|
| `list_snapshots` | 列出章节所有快照 |
| `create_snapshot` | 创建新快照（auto / milestone） |
| `get_snapshot_content` | 获取快照内容 |
| `restore_snapshot` | 恢复快照内容到章节 |
| `delete_snapshot` | 删除快照 |

## 世界观 `world_card`

| 命令 | 说明 |
|------|------|
| `list_world_cards` | 列出所有世界观卡片 |
| `create_world_card` | 创建卡片（6 种类型） |
| `update_world_card` | 更新卡片内容 |
| `delete_world_card` | 删除卡片 |
| `search_world_cards` | FTS5 全文搜索 |

## AI `commands/ai/`

| 命令 | 源文件 | 说明 |
|------|--------|------|
| `test_ai_connection` | `ai/test.rs` | 测试对话服务连通性（返回可用模型列表） |
| `test_rag_connection` | `ai/test.rs` | 测试 RAG/Embedding 服务连通性 |
| `rag_search` | `ai/embedding.rs` | RAG 检索（向量优先，FTS5/LIKE 降级） |
| `trigger_embedding` | `ai/embedding.rs` | 批量生成 Embedding 向量 |
| `check_embedding_status` | `ai/embedding.rs` | 检查 Embedding 索引状态（含 `stale` 标记） |
| `stream_ai_chat` | `ai/chat.rs` | SSE 流式对话 |
| `summarize_chapter` | `ai/summarize.rs` | 章节内容总结（非流式） |
| `summarize_conversation` | `ai/summarize.rs` | 对话历史压缩（滑动窗口摘要） |

> v1.0.0 起 `commands/ai.rs` 已拆分为 4 个子模块，早期文档中的 `ai.rs ~1265 行` 说法已失效。

### 事件通道

| 事件名 | 方向 | 载荷 |
|--------|------|------|
| `ai-stream-chunk` | Rust → 前端 | `StreamEvent { content, thinking, phase, done, error, usage }` |
| `agent-stream-chunk` | Rust → 前端 | `{ event, data, requestId }` |
| `debug-log` | Rust → 所有窗口 | `LogEntry` |
| `debug-window-closed` | Rust → main | `()` |
| `chapter-summary-done` | Rust → 前端 | `()` |
| `agent-status-changed` | Rust → main | `{ status, message }`（关闭流程发出；`status=closing` 时前端显示退出遮罩） |

## 导入导出 `commands/io/`

| 命令 | 源文件 | 说明 |
|------|--------|------|
| `export_book` | `io/export.rs` | 导出为 TXT / Markdown / HTML |
| `import_txt` | `io/import_txt.rs` | 导入 TXT，正则识别章节分隔 |
| `export_all_data` | `io/backup.rs` | 全量加密备份（AES-256-GCM） |
| `export_single_book` | `io/backup.rs` | 单作品加密备份 |
| `import_backup` | `io/backup.rs` | 从备份恢复 |

## 图片 `image`

| 命令 | 说明 |
|------|------|
| `process_image` | 图片压缩/校验/编码（1200px 编辑器图、800px 封面图） |
| `process_image_cropped` | 按前端传入的裁剪参数处理图片 |

## 窗口 `commands/window/`

| 命令 | 源文件 | 说明 |
|------|--------|------|
| `open_world_window` / `close_world_window` | `window/manager.rs` | 世界观独立窗口 |
| `open_history_window` / `close_history_window` | `window/manager.rs` | 版本历史窗口 |
| `open_summary_window` / `close_summary_window` | `window/manager.rs` | 章节总结窗口 |
| `open_ai_toolbox_window` / `close_ai_toolbox_window` | `window/manager.rs` | AI 工具箱窗口 |
| `open_debug_window` / `close_debug_window` | `window/debug.rs` | 调试控制台窗口 |
| `log_message` | `window/debug.rs` | 前端日志上报（写入 LOG_BUFFER + 广播） |
| `get_debug_logs` | `window/debug.rs` | 获取历史日志（缓冲区上限 1000 条） |
| `clear_debug_logs` | `window/debug.rs` | 清空日志缓冲区 |
| `validate_database` | `window/validate.rs` | 数据库完整性校验 + FTS5 索引重建 |

## Agent `commands/agent/`

> v1.1 起 Agent 由 Python 外部进程迁移为 **Rust 原生引擎**（无 9877 / 9876 服务）。
> 原 `get_agent_status` / `start_agent` / `stop_agent` 兼容命令已随迁移一并移除。

| 命令 | 说明 |
|------|------|
| `execute_agent_skill` | 执行 Skill（Rust 引擎 ReAct 循环，增量经 `agent-stream-chunk` 推送） |
| `cancel_agent_skill` | 取消当前 Agent 任务（引擎全局取消标志） |
| `list_agent_memories` | 列出指定作品的记忆条目 |
| `update_agent_memory` | 更新记忆内容/关键词/类型 |
| `delete_agent_memory` | 删除单条记忆 |
| `clear_agent_memories` | 清空指定作品的全部记忆 |

## 系统检查 `system_check`

| 命令 | 说明 |
|------|------|
| `system_check` | 运行环境自检（v1.1 无外部服务依赖，校验内置引擎/数据库等） |

---

## 前端桥接层 API 模块

`src/lib/tauri-bridge.ts` 中对应的 11 个 API 对象：

| API 对象 | 覆盖命令数 |
|----------|:---:|
| `bookApi` | 11 |
| `volumeApi` | 8 |
| `chapterApi` | 16 |
| `snapshotApi` | 5 |
| `worldCardApi` | 5 |
| `aiApi` | 8 |
| `importExportApi` | 5 |
| `imageApi` | 2 |
| `windowApi` | 6 |
| `debugApi` | 6 |
| `agentApi` | 6 |
| `systemApi` | 1 |

---

## 相关文档

- [项目结构](development/project-structure) — 目录组织与分层设计
- [架构总览](architecture/overview) — 三进程架构与数据流
- [AI 架构](architecture/AI-architecture) — Rust 原生 Agent 引擎（v1.1）
