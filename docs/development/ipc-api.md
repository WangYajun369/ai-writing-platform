# IPC 命令速查

> **适用版本**：`1.4.0`　|　**最后核对**：2026-09-03

TimeWrite 共注册 **109 个 IPC 命令**，全部在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中集中注册，前端通过 `src/lib/tauri-bridge.ts` 调用（Agent 命令为例外，见文末说明）。

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
| [日记](#日记-diary) | 5 | `commands/diary.rs` |
| [日程](#日程-schedule) | 4 | `commands/schedule.rs` |
| [生词本](#生词本-vocab) | 10 | `commands/vocab.rs` |
| [离线词典](#离线词典-vocab_dict) | 5 | `commands/vocab_dict.rs` |
| [语音合成](#语音合成-tts) | 1 | `commands/tts.rs` |
| [AI](#ai-commandsai) | 8 | `commands/ai/{test,embedding,chat,summarize}.rs` |
| [导入导出](#导入导出-commandsio) | 5 | `commands/io/{export,import_txt,backup}.rs` |
| [图片](#图片-image) | 2 | `commands/image.rs` |
| [窗口](#窗口-commandswindow) | 17 | `commands/window/{manager,debug,validate}.rs` |
| [Agent](#agent-commandsagent) | 6 | `commands/agent/skills.rs` |
| [系统](#系统检查-system_check) | 1 | `commands/system_check.rs` |
| **合计** | **109** | — |

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

## 日记 `diary`

| 命令 | 说明 |
|------|------|
| `list_month_diaries` | 列出指定年月的日记摘要（按日期升序，不含正文） |
| `list_all_diaries` | 列出全部日记摘要（书页式「看日记」跨月浏览用，按日期升序） |
| `get_diary` | 按日期获取日记全文（无记录返回 null） |
| `save_diary` | 保存日记（校验关键字数量/长度上限并入库；内容为空时前端转为删除该日记录） |
| `delete_diary` | 删除某日日记 |

## 日程 `schedule`

| 命令 | 说明 |
|------|------|
| `list_schedules_by_date` | 列出某日全部日程 |
| `list_schedules_by_month` | 列出某月全部日程（日历状态点用，按日期与创建时间排序） |
| `save_schedule` | 新增或更新日程（含完成状态） |
| `delete_schedule` | 删除日程 |

## 生词本 `vocab`

> v1.4.0 新增。业务集中在 `service/vocab_service.rs`；每次影响「今日待复习数」的写操作后向主窗口广播 `vocab-due-updated`（首页入口角标实时刷新）。

| 命令 | 说明 |
|------|------|
| `vocab_add` | 收录生词（单词已存在则更新释义并返回；参数含 phonetics/meanings/例句/例句翻译/可选 AI 学习知识/来源） |
| `vocab_update` | 编辑音标 / 释义 / 例句 / AI 知识 |
| `vocab_set_status` | 切换状态（learning / mastered / suspended） |
| `vocab_delete` | 删除生词（复习记录级联删除） |
| `vocab_list` | 列出生词（status 过滤 + 单词模糊搜索） |
| `vocab_due` | 今日到期复习队列 |
| `vocab_get` | 单条生词详情 |
| `vocab_review` | 提交复习反馈（rating：0 忘记 / 1 模糊 / 2 记得 / 3 轻松），按 SM-2 推进调度 |
| `vocab_logs` | 某生词的复习历史记录 |
| `vocab_stats` | 生词本统计（首页角标与统计页共用） |

## 离线词典 `vocab_dict`

> v1.4.0 新增。ECDICT 离线词库（sqlite 导入）查询为主；未命中 / 未导入时走 DeepSeek AI 释义兜底。

| 命令 | 说明 |
|------|------|
| `dict_status` | 词库安装状态（是否导入、词条规模） |
| `dict_import` | 导入 ECDICT 离线词库（source_path → 建表并复制到应用目录） |
| `dict_lookup` | 离线查词（音标 + 释义 + 例句） |
| `check_word_ai` | 单词拼写检查 + 首条英文释义 + 例句翻译（AI，兜底与录入提示用） |
| `dict_explain_ai` | AI 精讲：词根词缀 / 同反义词 / 固定搭配 / 词形变化 / 词性例句（DeepSeek） |

## 语音合成 `tts`

> v1.4.0 新增。豆包语音合成（seed-tts-2.0）接口封装，前端经 `tts-player.ts` 合成并本地播放。

| 命令 | 说明 |
|------|------|
| `tts_speak` | 合成文本为音频并返回本地临时文件路径（支持 speaker 音色参数） |

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
| `vocab-due-updated` | Rust → 所有窗口 | `()` —— 影响「今日待复习数」的写操作后广播，首页入口角标实时刷新 |
| `vocab-window-closed` | Rust → main | `()` —— 英语字典窗口被关闭 |

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
| `open_vocab_window` / `close_vocab_window` / `is_vocab_window_open` | `window/manager.rs` | 英语字典·生词本窗口（v1.4.0；关闭时广播 `vocab-window-closed`） |
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

`src/lib/tauri-bridge.ts` 中对应的 16 个 API 对象：

| API 对象 | 覆盖命令数 |
|----------|:---:|
| `bookApi` | 11 |
| `volumeApi` | 8 |
| `chapterApi` | 16 |
| `snapshotApi` | 5 |
| `worldCardApi` | 5 |
| `diaryApi` | 5 |
| `scheduleApi` | 4 |
| `vocabApi` | 10 |
| `dictApi` | 5 |
| `ttsApi` | 1 |
| `aiApi` | 8 |
| `importExportApi` | 5 |
| `imageApi` | 2 |
| `windowApi` | 11 |
| `debugApi` | 6 |
| `systemApi` | 1 |

> **例外说明**：Agent 命令（`execute_agent_skill` / `cancel_agent_skill` / 记忆管理）**未封装进
> `tauri-bridge.ts`**（无 `agentApi` 对象），由 `components/agent/useAgent.ts`、`AgentMemoryPanel.tsx`
> 与 `useAiChat.ts` 直接 `invoke`——与「唯一 IPC 入口」约定不一致，列为待重构项。

---

## 相关文档

- [项目结构](development/project-structure) — 目录组织与分层设计
- [架构总览](architecture/overview) — 双进程架构与数据流
- [Agent 引擎架构](architecture/agent-architecture) — Rust 原生 Agent 引擎（v1.2）
