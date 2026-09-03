# TimeWrite（智写时光）代码架构深度分析

> **适用版本**：`1.5.0`　|　**最后核对**：2026-09-03
>
> 基于当前源码（前端 `src/`、Rust 后端 `src-tauri/`、脚本 `scripts/`）整理。
> v1.1 起 Agent 已迁移为 **Rust 原生引擎**（`src-tauri/src/commands/agent/`），
> Python Agent（`agent/`）与 Bridge（`src-tauri/src/python/`）已删除，运行时为**双进程模型**。

---

## 1. 系统总览：双进程架构

本项目是一个 **Tauri 桌面应用 + Rust 原生 AI/Agent 引擎** 的架构，运行时包含 2 个进程：

```
┌────────────────────────────────────────────────────────────────────────┐
│  进程 1: WebView 前端（React 19 + TypeScript + TailwindCSS 4）            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ pages/ (书库/编辑器/设置)                                          │  │
│  │ components/ (按业务域分组的 UI 组件)                                │  │
│  │ stores/ (Zustand 业务状态 + Jotai UI 原子状态)                      │  │
│  │ plugins/ (PluginManager 扩展点系统 + 2 个内置插件)                   │  │
│  │ lib/tauri-bridge.ts (唯一 IPC 调用入口，17 个 API 模块)              │  │
│  └───────────────────────────┬──────────────────────────────────────┘  │
│                              │ Tauri IPC (invoke / event)              │
├──────────────────────────────┼─────────────────────────────────────────┤
│  进程 2: Rust Core（Tauri v2）                                           │
│  ┌───────────────────────────┴──────────────────────────────────────┐  │
│  │ lib.rs (Builder / 插件注册 / 状态注入 / 事件)                      │  │
│  │ commands/  (IPC 命令层，169 个命令 / 26 个模块)                     │  │
│  │ service/   (业务编排层: 事务、审计日志、业务规则)                    │  │
│  │ repository/(数据访问层: 纯 SQL，无业务逻辑)                         │  │
│  │ db/        (r2d2 连接池 + SQLite WAL + FTS5，含 memories 表)       │  │
│  │ commands/agent/ (Rust 原生 Agent 引擎：engine/prompts/tools/       │  │
│  │                  memory/skills，内嵌运行，无外部进程)                │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

**核心设计思想**：Rust 作为"唯一的数据拥有者"（SQLite 独占），前端只通过 IPC 访问数据；
AI 对话与 Agent 引擎均内嵌 Rust 主进程，直接经 repository 层读写数据库，无跨进程 HTTP 回调。

> **历史**：v1.0 曾为三进程架构（Python FastAPI Agent @9877 + tiny_http Bridge @9876），v1.1 整体迁移为 Rust 原生。

---

## 2. 前端架构（src/）

### 2.1 入口与初始化链路

```
main.tsx
  └─ <ErrorBoundary>            # 全局渲染异常兜底
       └─ <App> (JotaiProvider)
            └─ <AppInit>        # 初始化编排
                 ├─ useAppVersion()       # 获取应用版本
                 ├─ useThemeFontInit()    # 主题/字体初始化
                 ├─ useConsoleInterceptor() # 前端 console 日志拦截上报
                 ├─ detectXxxWindow()     # URL 参数判定是否为独立窗口
                 └─ AppRouter / 各独立窗口面板
```

关键点：
- **AppInit 是"窗口路由器"**：通过 URL 参数（`?worldwin=1`、`?historywin=1`、`?summarywin=1`、`?aitoolboxwin=1`、`?debugwin=1`、`?vocabwin=1`、`?taskswin=1`、`?diarybookwin=1`）决定渲染哪个独立窗口面板（v1.5.0 起 8 种），主窗口则渲染 `AppRouter`。
- **路由**：React Router v7，`/`（书库）、`/editor/:bookId`（编辑器）、`/settings`（设置），Editor/Settings 懒加载。

### 2.2 状态管理：Zustand（业务）+ Jotai（UI）双轨制

**Zustand — 业务状态（`stores/`）**，采用 slice 模式：

| Slice | 文件 | 职责 |
|-------|------|------|
| `booksSlice` | `stores/booksSlice.ts` | 书籍/卷/章节/世界观数据的加载、CRUD、回收站、选中态 |
| `aiSlice` | `stores/aiSlice.ts` | AI 对话消息、配置、RAG、总结、连接状态 |
| `preferencesSlice` | `stores/preferencesSlice.ts` | 主题/护眼/字体/网格/编辑器宽度等个性化偏好（localStorage 持久化） |
| `pluginStore` | `stores/pluginStore.ts` | 插件启用状态 |
| `vocabStore` / `ttsConfig` | `stores/vocabStore.ts` / `ttsConfig.ts` | 英语字典数据 + TTS 配置（v1.4.0，独立 store） |
| `taskCardsStore` | `stores/taskCardsStore.ts` | 任务卡窗口数据（v1.5.0，独立 store，不持久化，经 `taskCardApi` 拉取并广播 `tasks-data-updated`） |

**Jotai — UI 原子状态（`stores/uiAtoms.ts`）**，21 个 atom：
- 编辑器类：`editorInstanceAtom`（TipTap 实例）、`editorFocusAtom`、`editorScrollPositionAtom`、`editorCursorPositionAtom`
- 面板类：`sidebarOpenAtom`、`aiPanelOpenAtom`、`historyPanelOpenAtom`、`zenModeAtom`
- 独立窗口开关：`worldWindowOpenAtom`、`historyWindowOpenAtom`、`summaryWindowOpenAtom`、`aiToolboxWindowOpenAtom`、`debugWindowOpenAtom`（跨页面/跨窗口共享）
- 其他：`modalStackAtom`（模态框栈）、`isSavingAtom`、`wordCountAtom`、`contentRefreshAtom` 等

**分工原则**：跨页面共享且需要持久化的数据 → Zustand；单窗口内高频变化的 UI 瞬态 → Jotai。

### 2.3 组件层次（components/）

按业务域组织 13 个目录：

| 目录 | 核心组件 | 职责 |
|------|---------|------|
| `library/` | BookCard, NewBookDialog, TrashModal, CoverPicker | 书库网格/列表、封面裁剪选择、回收站 |
| `outline/` | OutlinePanel, DraggableVolume, DraggableChapter | 卷-章两级目录树、拖拽排序、回收站 |
| `editor/` | RichTextEditor, EditorToolbar, SnapshotPanel, ImageCropperDialog | TipTap 富文本编辑、工具栏、版本快照 |
| `ai/` | AiSidePanel, useAiChat, MessageBubble, panel/* | AI 对话面板、工具箱、请求详情 |
| `agent/` | useAgent, AgentMemoryPanel, AgentMessageBubble | Agent Skill 交互、流式输出、记忆管理 |
| `worldbuilding/` | WorldbuildingPanel, WorldCardEditor | 6 类世界观卡片管理 |
| `diary/` | DiaryPanel, DiaryDialog, DiaryBookPage, DayTasksPanel | 首页右栏：按月日历 + 日记 + 当日任务（v1.5.0 任务卡驱动），「看日记」独立窗口 |
| `vocabulary/` | VocabularyWindow, WordBookTab, ReviewTab, StatsTab | 英语字典·生词本独立窗口（v1.4.0） |
| `taskCards/` | TaskCardsWindow, TaskCardView, AllTasksView, TodayView, SettingsDrawer 等 | 任务卡·项目管理独立窗口（v1.5.0） |
| `settings/` | AiConfigSection, RagConfigSection, AppearanceSection 等 12 个 | 设置页分区 |
| `app/` | AppInit, AppClosingOverlay, windowDetection | 应用初始化、关闭遮罩、窗口检测 |
| `common/` | ContextMenu, DebugPanel, ToastContainer | 通用组件 |
| `layout/` | EditorLayout, StatusBar | 编辑器布局、状态栏 |

> v1.2：`agent/` 下的 `AgentPanel`（启停面板）与 `ai/panel/EmbeddingStatus` 已随 Rust 迁移移除。

**编辑器（RichTextEditor）关键技术细节**：
- TipTap 扩展：StarterKit + Underline + Color + TextStyle + Table（4 件套）+ TaskList/Item + CodeBlockLowlight（34 种语言高亮）+ CharacterCount + 自定义 `ResizableImageExtension`（拖拽缩放）
- **双保险自动保存**：300ms 防抖 + 3 分钟定时器，保存结果用后端返回的全书总字数校正 `wordCountAtom`
- 编辑位置恢复：滚动位置 + 光标选区（from/to）自动保存，切章后恢复
- 字数统计：`countWordsFromHtml`（HTML 解析去标签）

### 2.4 IPC 桥接层（lib/tauri-bridge.ts）

**设计约定**：`tauri-bridge.ts` 是唯一允许 `invoke` 的模块（代码注释明确禁止在其他文件中直接 import `invoke`），封装类型安全 API：

| API 模块 | 对应 Rust 命令 | 功能 |
|---------|--------------|------|
| `bookApi` | book.rs | 书籍 CRUD、封面、回收站 |
| `volumeApi` | volume.rs | 卷 CRUD、排序、回收站 |
| `chapterApi` | chapter.rs | 章节 CRUD、保存、总结、大纲 |
| `snapshotApi` | snapshot.rs | 版本快照 |
| `worldCardApi` | world_card.rs | 世界观卡片 + FTS5 搜索 |
| `vocabApi` | vocab.rs | 生词本 CRUD + SM-2 复习 + 统计（v1.4.0） |
| `dictApi` | vocab_dict.rs | 离线词典查询 / 导入 / AI 释义（v1.4.0） |
| `ttsApi` | tts.rs | 豆包语音合成（v1.4.0） |
| `taskCardApi` | project.rs / task.rs / tag.rs / task_meta.rs / subtask.rs / attachment.rs / activity.rs / template.rs / reminder.rs / migrate.rs | 任务卡全量命令（55 条，v1.5.0） |
| `aiApi` | ai/ (chat/embedding/summarize/test) | 流式对话、RAG、Embedding（预留）、总结 |
| `importExportApi` | io/ (export/import_txt/backup) | 格式导出、TXT 导入、加密备份 |
| `imageApi` | image.rs | 图片压缩/裁剪 |
| `windowApi` | window/manager.rs | 独立窗口开关 |
| `debugApi` | window/debug.rs + validate.rs | 调试控制台、数据库校验 |
| `systemApi` | system_check.rs | 环境检查 |

> **例外（待重构）**：Agent 相关 invoke（`execute_agent_skill` / `cancel_agent_skill` / 记忆 CRUD）由
> `useAgent.ts` / `AgentMemoryPanel.tsx` / `useAiChat.ts` 组件直接调用，未封装进 `tauri-bridge.ts`。

### 2.5 插件系统（plugins/）

- 7 个扩展点：`editor-toolbar` / `editor-sidebar` / `library-card` / `export-format` / `ai-prompt` / `command-palette` / `home-header`（v1.4.0；支持入口激活态 `isActive` 与角标 `badgeCount`）
- `PluginManager` 单例：register → enable（调用 init）→ executeCommand → disable（调用 destroy）→ unregister
- 插件生命周期：`installed → active → disabled → error`
- 运行时上下文 `PluginContext` 提供 `app`（书籍/章节获取、通知）、`editor`（选中文本、插入）、`storage`（独立 key-value 存储）
- 内置引导 `plugins/bootstrap.ts`：home-header 插件「英语字典·生词本」（v1.4.0）与「任务卡·项目管理」（v1.5.0），窗口状态分别存放于 `dictionary/windowState.ts` 与 `taskCards/windowState.ts`
- 任务卡插件为 multi-command 形态：4 个命令面板命令（打开 / 直达今日 / 直达全部，深链 `?taskswin=1&section=today|all`）+ home-header 入口角标（今日应办数）
- 示例插件：字符统计（`plugins/examples/charCounter.ts`，不随内置引导启用）

---

## 3. Rust 后端架构（src-tauri/）

### 3.1 分层设计（严格 4 层）

```
commands/   IPC 命令层   —— 参数校验、调用 service、返回 DTO（无 SQL）
service/    业务编排层   —— 事务边界、业务规则、SQL 审计日志（emit_sql_log）
repository/ 数据访问层   —— 纯 SQL 操作，接受 &Connection，无业务逻辑
db/         连接与 Schema —— r2d2 连接池、迁移、FTS5 触发器、索引
```

各层职责边界在 `mod.rs` 注释中有明确约定，例如 repository 层"不依赖 Tauri State / AppHandle，不包含任何业务逻辑"。

### 3.2 启动流程（lib.rs）

1. 注册 7 个 Tauri 插件：shell / dialog / fs / updater / deep-link / http / notification（v1.5.0 起）
2. **数据库初始化**：`app_data_dir/time_write.db` → `AppDb::new()`（建表 + 迁移 + 索引）
3. **旧版 Agent 记忆库迁移**：检测旧 `agent_memory.db`（`<cwd>/data/` 与 `<app_data_dir>/`），存在则将存量记忆导入 `memories` 表（幂等，失败仅记日志）
4. **窗口关闭拦截**：CloseRequested → prevent_close → emit `agent-status-changed {status:"closing"}` → 关调试窗口 → 真正关闭（AtomicBool 防死循环）
5. 注册 169 个 IPC 命令（26 个命令模块：books / volumes / chapters / snapshots / world_cards / diaries / schedules / vocab / vocab_dict / tts / ai / io / image / window / agent / system_check + 任务卡 project/task/tag/task_meta/subtask/attachment/activity/template/reminder/migrate）

### 3.3 数据库设计（db/schema.rs + db/mod.rs）

**21 张业务表 + 2 张 FTS5 虚拟表**（v1.1 起新增 `memories`；v1.3 新增 `diaries` / `schedules`；v1.4 新增 `vocab_words` / `vocab_reviews`；v1.5 新增任务卡 10 张）：

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `books` | title, cover_image, word_count, daily_target, outline, deleted_at | 软删除 |
| `volumes` | book_id(FK), sort_order, deleted_at | 软删除 |
| `chapters` | book_id(FK), volume_id(FK SET NULL), content_html, word_count, status, summary, outline, deleted_at | 软删除 + AI 总结 |
| `snapshots` | chapter_id(FK), content_html, type('auto'/'milestone'), label | 版本快照 |
| `world_cards` | book_id(FK), type(6 类), content_html, tags, vectorized | 世界观 |
| `embeddings` | source_type, source_id, embedding(BLOB), model | 向量索引，UNIQUE(source_type, source_id) |
| `memories` | book_id, skill_type, memory_type, content, keywords, relevance_score | Agent 记忆（索引：book_skill / type） |
| `diaries` | diary_date(UNIQUE), content_html, word_count, keywords(JSON 数组文本), created_at, updated_at | 日记（每天至多一篇） |
| `schedules` | schedule_date, content, done(0/1), created_at, updated_at | 旧个人日程（某天多条；v1.5.0 起仅供迁移） |
| `vocab_words` | word(唯一), phonetic, meanings JSON, example/example_zh, details_json（AI 精讲缓存）, SM-2 参数（ease_factor/repetitions/interval_days/queue/due_at）, status | 生词本（v1.4.0） |
| `vocab_reviews` | word_id(FK), rating(0-3), interval_days, reviewed_at | 复习日志（v1.4.0） |
| `projects` / `project_milestones` | name/color/icon/status/pinned；project_id(FK)/name/due_date | 任务项目 + 里程碑（v1.5.0） |
| `tasks` | project_id(FK), title, description, status(todo/doing/done), priority, due_time, planned_today, completion_summary, deleted_at | 任务卡（v1.5.0） |
| `tags` / `task_tags` | 标签元数据 + 任务-标签关联 | 任务标签（v1.5.0） |
| `task_meta` | key(PRIMARY), value | 模块元数据 / 提醒偏好 / 铃铛已读（v1.5.0） |
| `task_subtasks` | task_id(FK), title, done, sort_order | 子任务清单（v1.5.0） |
| `attachments` | task_id(FK), file_name, file_type, local_path | 附件（v1.5.0） |
| `task_activity_logs` | task_id/project_id, action, summary, created_at | 操作日志时间线（v1.5.0） |
| `task_templates` | name, project_id, title, priority, due_offset_days, subtask_titles | 任务模板（v1.5.0） |
| `chapters_fts` / `world_cards_fts` | FTS5 (unicode61) | 全文搜索，INSERT/UPDATE/DELETE 三触发器自动同步 |

技术要点：
- r2d2 连接池（max_size=10，超时 10s，空闲 300s，最长存活 1800s）
- 每连接 `PRAGMA foreign_keys=ON; journal_mode=WAL`
- 幂等迁移：`safe_add_column` 检测 duplicate column 跳过
- 7 个关键索引（book_id、sort_order、deleted_at 组合）

### 3.4 Agent 引擎层（commands/agent/）—— v1.1 起 Rust 原生

Python 子进程时代已整体移除，替换为 6 个 Rust 模块，**内嵌主进程、无外部服务**：

| 文件 | 职责 |
|------|------|
| `skills.rs` | IPC 命令层：`execute_agent_skill` / `cancel_agent_skill` + 记忆管理命令（list/update/delete/clear） |
| `engine.rs` | SSE 流式 ReAct 工具循环（`run_skill`）、全局取消标志 |
| `prompts.rs` | 4 技能 System Prompt + 动态场景提示 + Token 估算 |
| `tools.rs` | 6 个数据库工具（schema + 执行，经 repository 层） |
| `memory.rs` | memories 表 CRUD / 规则提取 / 检索 / 旧库迁移 |

> 原 `python/manager.rs`（子进程管理 + 看门狗）、`python/client.rs`（HTTP 客户端）、
> `python/bridge.rs`（tiny_http 回调 Server）已删除，`tiny_http` 依赖已移除。
> 引擎细节见 [Agent 引擎架构](agent-architecture)。

### 3.5 AI 通信层（commands/ai/）

| 文件 | 职责 |
|------|------|
| `chat.rs` | `stream_ai_chat` — OpenAI 兼容 SSE 流式对话（智谱/DeepSeek/自定义端点/Ollama） |
| `embedding.rs` | RAG 向量检索、Embedding 索引/状态检查（`rag_search` / `trigger_embedding` / `check_embedding_status`） |
| `summarize.rs` | 章节总结、对话总结（滑动窗口压缩） |
| `test.rs` | AI / RAG 连接测试 |

**chat.rs 技术细节**：
- 自动重试：最多 2 次，指数退避（1s/2s），`is_retryable_error` 白名单过滤永久性错误
- 10 分钟全局超时 + 60s 单 chunk 读取超时（`tokio::time::timeout` 双层保护）
- 断流保底：`flush_sse_buffer` 刷新残留 buffer，已有内容时以 done 事件收尾而非报错
- DeepSeek 思考模式：`reasoning_content` 独立累积并推送 thinking 阶段事件；KV Cache 命中统计（`prompt_cache_hit_tokens`）
- 事件协议：`ai-stream-chunk`，StreamEvent { content, thinking, phase: thinking/answering/retrying/done, done, error, usage }

> v1.2 现状：Embedding/RAG 后端命令已实现并注册，但前端设置页将其标为「预留能力」——
> 当前对话上下文由 Agent 引擎内置工具全文检索提供，`triggerEmbedding` 无 UI 接线。

### 3.6 错误处理（error.rs）

`AppError` 枚举（10 种变体：DbPool/Db/Http/Serde/Io/Crypto/Validation/NotFound/Business/General），实现 `Serialize`（序列化为字符串）、`From<rusqlite::Error/r2d2::Error/anyhow::Error/String>`，可直接作为 Tauri 命令 Err 返回。

### 3.7 工具层（utils.rs）

- 时间戳 `now()`、HTML 剥离 `strip_html`（正则 OnceLock 缓存）、`snippet`
- HTTP 客户端工厂：普通客户端（代理探测 HTTPS_PROXY→ALL_PROXY）+ SSE 客户端（HTTP/1.1、禁压缩、TCP keepalive 120s）
- FTS5 安全转义 `escape_fts5_query`、LIKE 降级 `like_pattern`
- 字段长度校验常量 + `validate_len`

---

## 4. Agent 引擎（核心要点）

> 完整设计见 [Agent 引擎架构](agent-architecture)。此处仅列要点，便于快速索引：

- **执行链路**：`execute_agent_skill` → `engine::run_skill` → ReAct 循环（Prompt 组装 → 云端 SSE → 工具调用 → 文本流）
- **事件协议**：`agent-stream-chunk`，`{ event: chunk/done/error/cancelled, data, requestId }`，前端 RAF 缓冲合并
- **技能 × 工具**：writing / analysis / research / polish 各自裁剪工具集（共 6 个 DB 工具）
- **记忆**：`memories` 表（preference/decision/lesson），规则式提取（零 LLM）、关键词交集 + 类型加权检索（≤600 tokens）
- **默认模型**：DeepSeek（`deepseek-chat`），推理参数 `reasoning_effort=max`；每请求可选自定义 ai_config

---

## 5. 核心数据流详解

### 5.1 AI 流式对话（前端 → 云端）

```
用户输入
  → useAiChat hook
  → aiApi.streamChat(args)
  → invoke('stream_ai_chat')
  → commands/ai/chat.rs: reqwest POST {endpoint}/chat/completions (stream: true)
  → 云端 SSE 流
  → Rust 解析 data: 行（thinking/content 分离，[DONE] 终止）
  → app.emit('ai-stream-chunk', StreamEvent)
  → 前端 listen('ai-stream-chunk') 实时更新 MessageList
```

### 5.2 Agent Skill 执行（前端 → Rust 引擎 → repository → SQLite）

```
Agent 面板/AI 侧面板发送消息
  → useAgent.executeSkill() / useAiChat（生成 requestId，注入 aiConfig）
  → invoke('execute_agent_skill', { skill, bookId, message, aiConfig, requestId, ... })
  → commands/agent/skills.rs → engine::run_skill
  → prompts.rs: 基础 Prompt + 动态场景提示 + memory_prompt 记忆段
  → reqwest POST {endpoint}/chat/completions（tools = 技能工具集 schema）
  → SSE 解析：文本增量 → emit chunk；tool_calls → execute_tool
  → tools.rs → repository 层（chapter/world_card/book 仓库）→ SQLite
  → 工具结果回填 → 继续 ReAct 循环（≤15 轮）或结束
  → emit('agent-stream-chunk', { event: done, ... })
  → 前端按 requestId 过滤 → RAF 缓冲合并 → 批量更新 UI
  → 异步 extract_and_save 沉淀记忆到 memories 表
```

> 对比 v1.0：去除了 Python 侧两跳 HTTP（前端→9877 与工具回调 9876），数据流全部收敛在 Rust 进程内。

### 5.3 自动保存（双保险）

```
用户输入 → TipTap onUpdate
  ├─ 300ms 防抖 → chapterApi.save(chapterId, html, frontendCount)
  └─ 3 分钟定时器 → 同上（兜底）
    → commands/chapter.rs save_chapter（事务更新 chapters + 重算 books.word_count）
    → 返回 { wordCount, bookWordCount } → 前端校正字数与保存状态
```

---

## 6. 构建与工程化（scripts/ + 配置）

| 脚本 | 用途 |
|------|------|
| `scripts/check.mjs` | 完整性自检（200 项：tsc 产物 + Rust 模块 + Agent 迁移防回归断言，`--fast` 快速模式） |
| `scripts/check-npm-versions.ts` / `check-rust-versions.ts` | 前端 / Rust 依赖版本校验 |
| `scripts/node-manager.ts` | Node 版本管理（`pnpm node`） |
| `scripts/clean.ts` | 构建产物清理（`--all` 全清，含 Python 缓存清理项已移除） |

> v1.1 起已删除：`setup-agent.ts` / `check-python-versions.ts`（Python Agent 相关）、`pyrightconfig.json`。

- **Vite 8**：`@` → `src` 别名；manualChunks 将 react/tiptap/lucide/state/router/markdown/utils/virtual/highlight/katex/dnd-kit/tauri-vendor 拆为独立 chunk
- **Tauri 打包**：dmg（macOS）+ nsis（Windows，简体中文/English 双语言），deep-link 协议 `com.ukcoder.timewrite://`（不再随包分发 `agent/` 资源）
- **CSP**：严格白名单（`connect-src` 仅放行 AI API 端点等，无 9877/9876 本地端口）

---

## 7. 关键技术决策与设计亮点

1. **数据写操作唯一入口在 Rust**：Agent 工具与 AI 对话均内嵌 Rust，直接经 repository 层读写 SQLite，无多进程并发写锁竞争。
2. **Agent 引擎 Rust 化**：免除 Python 运行时依赖与子进程生命周期管理（解释器探测/看门狗/优雅关闭），应用启动更快、更稳。
3. **记忆并入主数据库**：`memories` 表与业务数据同库同事务，旧 `agent_memory.db` 自动幂等迁移，无需维护第二套 SQLite。
4. **双模型/多服务商对话**：AI 助手支持智谱/DeepSeek/Ollama/自定义，配置解耦、独立 API Key；DeepSeek 思考模式深度适配（reasoning_content 独立流、KV Cache 友好 Prompt、reasoning_effort=max、TTFT 监控）。
5. **前端 RAF 缓冲**：Agent 流式输出按帧合并更新，避免高频 chunk 触发大量重渲染。
6. **双轨状态管理**：Zustand 承载业务数据（slice 模式），Jotai 承载 UI 瞬态（21 个 atom），各司其职。
7. **双保险自动保存**：防抖 + 定时器组合，配合后端事务更新全书字数。
8. **多层网络容错**：AI 对话重试白名单、SSE 断流保留已生成内容、双层超时（10 分钟全局 / 60s chunk）。
9. **权限最小化**：capabilities/default.json 仅向窗口授予核心权限，CSP 严格限定 connect-src。
10. **独立窗口系统**：通过 URL 参数路由到 8 种独立窗口，Jotai 原子（核心窗口）与插件模块状态（英语字典 / 任务卡）跨窗口同步开关状态。

---

## 8. 目录速查

```
MirageInk/
├── src/                      # 🔵 前端（React 19 + TS 6）
│   ├── pages/                #   LibraryPage / EditorPage / SettingsPage
│   ├── components/           #   13 个业务域组件目录 + ErrorBoundary
│   ├── stores/               #   Zustand 3 slices + 独立 stores（plugin/vocab/tts/taskCards）+ Jotai 21 atoms
│   ├── lib/                  #   tauri-bridge.ts（IPC 入口）/ utils / toast / image
│   ├── hooks/                #   useAppVersion / useConsoleInterceptor / useResizeHandle / useThemeFontInit
│   ├── plugins/              #   PluginManager 单例 + 7 扩展点 + 2 个内置插件（dictionary / taskCards）
│   ├── router/               #   React Router v7（懒加载）
│   ├── types/                #   全部领域类型 + DTO 对齐
│   └── styles/               #   TailwindCSS 4 + HSL 主题变量（4 套主题）
├── src-tauri/                # 🟠 Rust 后端（Tauri v2）
│   ├── src/
│   │   ├── lib.rs            #   Builder / 插件 / 启动编排 / 169 命令注册
│   │   ├── commands/         #   26 个模块：基础域 + ai/io/window/agent + 任务卡 10 文件
│   │   │   └── agent/        #   engine / prompts / tools / memory / skills（Rust 原生 Agent）
│   │   ├── service/          #   20 个业务服务（事务 + 审计，含 task/reminder/migrate 等）
│   │   ├── repository/       #   17 个数据仓库（纯 SQL）
│   │   ├── db/               #   r2d2 连接池 + Schema（21 业务表 + 2 FTS5）
│   │   ├── error.rs          #   AppError 统一错误
│   │   └── utils.rs          #   HTTP 客户端 / HTML 工具 / 校验
│   ├── capabilities/         #   权限声明
│   └── tauri.conf.json       #   App 配置 + 打包 + 插件
├── scripts/                  # 🔧 5 个工程化脚本
├── docs/                     # 📖 Wiki 文档（含本文件）
└── product/                  # 🏠 产品落地页
```
