# 项目结构

> **适用版本**：`1.7.0`　|　**最后核对**：2026-09-05
>
> 本文档描述 TimeWrite 的目录组织与分层设计。IPC 命令清单见 [IPC 命令速查](development/ipc-api)。

---

## 顶层目录

```
MirageInk/
├── package.json              # 前端依赖与脚本（pnpm workspace，engines: Node≥22 / pnpm≥11）
├── pnpm-lock.yaml            # 依赖锁定
├── tsconfig.json             # TypeScript 配置（strict: true，paths: @/* → src/*）
├── tsconfig.node.json        # Node 端 TS 配置（vite.config / scripts）
├── vite.config.ts            # Vite 8 构建配置（manualChunks 分包、@ 别名）
├── index.html                # Vite 入口 HTML
├── README.md                 # 项目说明
├── src/                      # 🔵 前端源码（React 19 + TypeScript 6）
├── src-tauri/                # 🟠 Rust 后端（Tauri v2，内置 Agent 引擎）
├── scripts/                  # 🔧 构建/检查/环境脚本（5 个）
├── docs/                     # 📖 项目文档（自动同步到 GitHub Wiki）
├── product/                  # 🏠 产品落地页（GitHub Pages）
└── dist/                     # 📦 前端构建产物
```

> **注意**：TailwindCSS v4 起采用 CSS-first 配置，项目**不再有** `tailwind.config.ts` 和 `postcss.config.js`。主题变量定义于 `src/styles/theme.css`。

---

## 分层架构

```
commands/   IPC 命令层   —— 参数校验、调用 service、返回 DTO（无 SQL）
service/    业务编排层   —— 事务边界、业务规则、SQL 审计日志（emit_sql_log）
repository/ 数据访问层   —— 纯 SQL，接受 &Connection，无业务逻辑
db/         连接与 Schema —— r2d2 连接池、幂等迁移、FTS5 触发器、索引
```

各层职责边界在对应 `mod.rs` 注释中明确约定。共注册 **173 个 IPC 命令**（`#[tauri::command]` 计数）。

---

## 前端 `src/`

```
src/
├── main.tsx                  # ReactDOM.createRoot，包裹 ErrorBoundary
├── App.tsx                   # 根组件：JotaiProvider + 主题/字体初始化 + 窗口类型检测
├── vite-env.d.ts             # Vite 环境类型声明
├── pages/                    # 页面级组件
├── components/               # UI 组件（13 个业务域目录 + ErrorBoundary）
├── stores/                   # Zustand（3 slice + plugin/vocab/tts/taskCards stores）+ Jotai（21 atom）
├── lib/                      # 工具库（tauri-bridge.ts / utils / toast / image-utils）
├── hooks/                    # 自定义 Hooks
├── types/                    # TypeScript 类型定义
├── router/                   # React Router v7 配置
├── plugins/                  # 扩展点插件系统
└── styles/                   # CSS（TailwindCSS v4 + HSL 主题变量）
```

### 组件 `components/`（13 个业务域）

| 目录 | 核心文件 | 职责 |
|------|---------|------|
| `library/` | `BookCard`、`NewBookDialog`、`EditBookDialog`、`CoverPicker`、`TrashModal` | 书库网格/列表、封面裁剪、回收站 |
| `diary/` | `DiaryPanel`、`DiaryDialog`、`DiaryBookPage`、`DayTasksPanel` | 书库首页右栏：按月日历、TipTap 日记编辑器；当日任务（任务卡数据驱动）；「看日记」独立窗口（diary-book） |
| `vocabulary/` | `VocabularyWindow`、`tab/WordBookTab`、`tab/ReviewTab`、`tab/StatsTab`、`dialog/*`、`SpeakButton`、`VocabKnowledgeView`、`vocab-utils` | 英语字典·生词本独立窗口：生词本 / SM-2 复习 / 统计，含 AI 精讲与语音朗读（v1.4.0） |
| `taskCards/` | `TaskCardsWindow`、`TaskCardView`、`AllTasksView`、`ProjectDetailView`、`TodayView`、`TrashView`、`SettingsDrawer`、`ProjectFormModal`、`TaskModal`、`CompleteSummaryModal`、`TagManager`、`TemplatesTab`、`ScheduleMigrationTab`、`ReminderSettingsTab`、`ActivityTimeline`、`ProjectReportModal`、`RecurrencePicker`、`SubtaskEditor`、`AttachmentUploader` | 任务卡独立窗口：今日 / 项目看板 / 全部任务 / 回收站 / 设置（标签 / 模板 / 日程迁移 / 提醒）（v1.5.0） |
| `outline/` | `OutlinePanel`、`hooks/useOutlineDnd`、`hooks/useOutlineDialogs` | 卷-章两级目录树、拖拽排序（@dnd-kit）、虚拟滚动、回收站（拖拽 / 对话框逻辑已抽 hook，v1.6.0） |
| `editor/` | `RichTextEditor`、`EditorToolbar`、`SnapshotPanel`、`ImageCropperDialog`、`ImageViewerDialog` | TipTap 编辑、工具栏、版本快照、图片处理 |
| `ai/` | `AiSidePanel`、`AiToolboxPanel`、`MessageBubble`、`RequestDetailModal`、`useAiChat`、`hooks/useAgentChatStream`、`hooks/useAiChatMessages`、`hooks/useConversationSummarizer` | AI 对话面板、工具箱、请求详情（useAiChat 拆分流式 / 消息 / 总结逻辑，v1.6.0） |
| `agent/` | `useAgent`、`AgentMemoryPanel`、`AgentMessageBubble`、`types.ts` | Agent Skill 交互（Rust 原生引擎）、流式输出、记忆管理 |
| `worldbuilding/` | `WorldbuildingPanel`、`WorldCardEditor` | 6 类世界观卡片管理 |
| `settings/` | `AiConfigSection`、`RagConfigSection`、`AppearanceSection`、`AiToolboxSection` 等 12 个 | 设置页分区 |
| `app/` | `AppInit`、`AppClosingOverlay`、`windowDetection` | 应用初始化、关闭遮罩、窗口类型检测 |
| `common/` | `ContextMenu`、`DebugPanel`、`ToastContainer` | 通用组件 |
| `layout/` | `EditorLayout`、`StatusBar` | 编辑器三栏布局、底部状态栏 |
| 顶级 | `ErrorBoundary.tsx` | 全局渲染异常兜底 |

### 状态管理 `stores/`

| 文件 | 职责 |
|------|------|
| `booksSlice.ts` | 书籍/卷/章节/世界观数据的加载、CRUD、回收站、选中态 |
| `aiSlice.ts` | AI 对话消息、配置、RAG、总结、连接状态 |
| `preferencesSlice.ts` | 主题/护眼/字体/网格/编辑器宽度（localStorage 持久化） |
| `pluginStore.ts` | 插件启用状态 |
| `vocabStore.ts` | 英语字典数据：`words` / `due` / `stats` 三组查询 + `refreshAll` 全量刷新 |
| `ttsConfig.ts` | 豆包语音合成配置（API Key / 音色，localStorage 持久化） |
| `taskCardsStore.ts` | 任务卡窗口内 Zustand store（projects/tags/tasks/子任务/附件/模板等，不持久化，数据一律经 `taskCardApi` 拉取；变更后广播 `tasks-data-updated`） |
| `uiAtoms.ts` | **21 个** Jotai atom（UI 瞬态 + 核心独立窗口开关） |

详见 [状态管理](development/state-management)。

### 工具库 `lib/`

| 文件 | 说明 |
|------|------|
| `tauri-bridge.ts` | **全项目唯一允许调用 `invoke` 的模块**，17 个类型安全 API 对象 |
| `tts-player.ts` | 豆包语音合成：合成请求封装与 `playAudioFile` 本地播放 |
| `utils.ts` | `cn()` 类名合并、字数统计、HTML 清洗、日期格式化 |
| `image-utils.ts` | 图片压缩、Base64 转换、尺寸获取 |
| `toast.ts` | Toast 通知（成功/错误/警告/信息） |

### 路由 `router/`

React Router v7，懒加载：

| 路径 | 页面 |
|------|------|
| `/` | `LibraryPage` |
| `/editor/:bookId` | `EditorPage`（懒加载） |
| `/settings` | `SettingsPage`（懒加载） |

### 插件系统 `plugins/`

基于**扩展点（Extension Point）**的插件架构，7 个扩展点：`editor-toolbar` / `editor-sidebar` / `library-card` / `export-format` / `ai-prompt` / `command-palette` / `home-header`。

| 文件 / 目录 | 说明 |
|------|------|
| `types.ts` | 插件类型：`PluginManifest`、`Plugin`、`PluginCommand`、`CommandContext`、`PluginContext`、`ExtensionPoint` |
| `PluginManager.ts` | 单例：注册 / 启用 / 禁用 / 卸载与生命周期管理 |
| `bootstrap.ts` | 主窗口内置插件引导（模块级 Promise 幂等）：注册并启用「英语字典·生词本」与「任务卡·项目管理」，为 home-header 注入角标计数源 |
| `dictionary/` | home-header 内置插件：`plugin.ts` 命令声明 + `windowState.ts` 模块级窗口开关状态（v1.4.0） |
| `taskCards/` | home-header 内置插件：`plugin.ts`（命令面板 / 角标）+ `windowState.ts`（v1.5.0） |
| `examples/` | `charCounter.ts` 参考示例（不随内置引导启用） |

详见 [插件系统](development/plugin-system)。

---

## Rust 后端 `src-tauri/`

```
src-tauri/
├── Cargo.toml
├── build.rs
├── tauri.conf.json           # 应用配置（版本 1.5.0、窗口 1280×800、dmg/nsis 打包）
├── entitlements.plist
├── capabilities/
│   └── default.json          # 安全权限声明（CSP / FS / Shell / HTTP）
├── gen/schemas/              # 自动生成的 JSON Schema
├── icons/                    # 应用图标（25 PNG + ICNS + ICO）
└── src/
    ├── main.rs               # 程序入口
    ├── lib.rs                # Tauri Builder：7 插件 + 数据库 + 记忆迁移 + 173 命令注册
    ├── error.rs              # AppError 统一错误枚举（10 种变体）
    ├── logging.rs            # 日志模块
    ├── utils.rs              # HTTP 客户端工厂、HTML 工具、FTS5 转义、字段校验、local_now
    ├── commands/             # IPC 命令层（26 个模块，43 个 .rs 文件）
    ├── service/              # 业务编排层（20 个服务 + reminder/project_stats 等）
    ├── repository/           # 数据访问层（17 个仓库）
    ├── db/                   # r2d2 连接池 + Schema + FTS5 触发器
    ├── models/               # Serde 数据模型（统一 camelCase）
    └── commands/agent/       # Rust 原生 Agent 引擎（engine/prompts/tools/memory/skills）
```

### 命令层 `commands/`

| 模块 | 文件 | 命令数 |
|------|------|:---:|
| 书籍 | `book.rs` | 11 |
| 卷 | `volume.rs` | 8 |
| 章节 | `chapter.rs` | 16 |
| 快照 | `snapshot.rs` | 5 |
| 世界观 | `world_card.rs` | 5 |
| 日记 | `diary.rs` | 5 |
| 日程 | `schedule.rs` | 4 |
| 生词本 | `vocab.rs` | 10 |
| 离线词典 | `vocab_dict.rs` | 5 |
| 语音合成 | `tts.rs` | 1 |
| 图片 | `image.rs` | 2 |
| 系统检查 | `system_check.rs` | 1 |
| AI | `ai/{mod,chat,embedding,summarize,test}.rs` | 8 |
| 导入导出 | `io/{mod,export,import_txt,backup,crypto}.rs` | 8（v1.7.0 新增 `inspect_backup` / `cancel_book_export`） |
| 窗口 | `window/{mod,manager,debug,validate}.rs` | 22 |
| Agent | `agent/{mod,engine,prompts,tools,memory,skills}.rs` | 6 |
| 任务项目 | `project.rs` | 9 |
| 任务卡 | `task.rs` | 17 |
| 标签 | `tag.rs` | 4 |
| 任务元数据 | `task_meta.rs` | 4 |
| 子任务 | `subtask.rs` | 6 |
| 附件 | `attachment.rs` | 5 |
| 操作日志 | `activity.rs` | 3 |
| 任务模板 | `template.rs` | 5 |
| 提醒 | `reminder.rs` | 1 |
| 日程迁移 | `migrate.rs` | 1 |
| 写作统计 | `writing_stats.rs` | 1 |

### 业务服务 `service/`

| 文件 | 职责 |
|------|------|
| `book_service.rs` | 创建默认卷、级联删除、字数统计聚合 |
| `chapter_service.rs` | 保存时事务更新全书总字数、内容摘要提取 |
| `volume_service.rs` | 排序、级联操作 |
| `snapshot_service.rs` | 快照创建与恢复 |
| `search_service.rs` | FTS5 全文搜索 + LIKE 降级、向量语义搜索、混合排序 |
| `world_card_service.rs` | 世界观 CRUD + 搜索 |
| `diary_service.rs` | 日记保存（字数统计、关键字校验与入库）、查询、删除 |
| `schedule_service.rs` | 旧个人日程 CRUD（v1.5.0 起仅服务数据迁移） |
| `vocab_service.rs` | 生词簿 CRUD、SM-2 排程与复习、统计聚合（v1.4.0） |
| `project_service.rs` | 项目 CRUD、完成 / 归档、看板与统计聚合（v1.5.0） |
| `task_service.rs` | 任务卡 CRUD、看板状态流转 / 排序、搜索筛选、子任务进度汇总（v1.5.0） |
| `tag_service.rs` | 标签 CRUD、启停、删除级联（v1.5.0） |
| `task_meta_service.rs` | 模块级 key-value、提醒偏好（v1.5.0） |
| `subtask_service.rs` | 子任务 CRUD 与父任务进度联动（v1.5.0） |
| `attachment_service.rs` | 附件实体与本地文件、打开附件（v1.5.0） |
| `activity_log_service.rs` | 操作日志写入与时间线查询（v1.5.0） |
| `template_service.rs` | 任务模板 CRUD、套用生成任务（v1.5.0） |
| `project_stats_service.rs` | 近 8 周「新增 / 完成」周报统计（v1.5.0） |
| `reminder_service.rs` | 到期 / 逾期提醒扫描（系统通知）与「立即检查」（v1.5.0） |
| `migrate_service.rs` | 旧 `schedules` → 项目「日程迁移」幂等迁移（v1.5.0） |
| `writing_stats_service.rs` | 按日净增字数统计（保存章节时增量更新 `writing_stats`，v1.6.0） |

### 数据仓库 `repository/`

纯 SQL 访问层，不含业务逻辑。基础模块：`book_repo.rs` / `chapter_repo.rs` / `volume_repo.rs` / `snapshot_repo.rs` / `world_card_repo.rs` / `diary_repo.rs` / `schedule_repo.rs` / `vocab_repo.rs` / `embedding_repo.rs`（含 sqlite-vec `chunks_vec` 表维护）；任务卡模块（v1.5.0）：`project_repo.rs` / `task_repo.rs` / `tag_repo.rs` / `task_meta_repo.rs` / `subtask_repo.rs` / `attachment_repo.rs` / `activity_log_repo.rs` / `template_repo.rs`；v1.6.0：`writing_stats_repo.rs`。

### 数据库 `db/`

24 张业务表（v1.1 起含 `memories`；v1.3 新增 `diaries` / `schedules`；v1.4 新增 `vocab_words` / `vocab_reviews`；v1.5 新增任务卡 10 张；v1.6 新增 `writing_stats`；v1.7 新增 `import_log`，`import_rollback_log` 承载导入回退点）+ 2 张 FTS5 虚拟表 + sqlite-vec 动态 `chunks_vec` 镜像表：

| 表 | 关键字段 |
|----|---------|
| `books` | title, cover_image, word_count, daily_target, outline, deleted_at |
| `volumes` | book_id(FK), sort_order, deleted_at |
| `chapters` | book_id(FK), volume_id(FK SET NULL), content_html, word_count, status, summary, outline, deleted_at |
| `snapshots` | chapter_id(FK), content_html, type('auto'/'milestone'), label |
| `world_cards` | book_id(FK), type(6 类), content_html, tags, vectorized |
| `embeddings` | source_type, source_id, embedding(BLOB), model — UNIQUE(source_type, source_id) |
| `memories` | book_id, skill_type, memory_type(preference/decision/lesson), content, keywords, relevance_score, last_hit_at（命中时间，过期清理依据；v1.1 并入主库，v1.6 补列） |
| `diaries` | diary_date(UNIQUE), content_html, word_count, keywords(JSON 数组文本), created_at, updated_at（每天至多一篇） |
| `schedules` | schedule_date, content, done(0/1), created_at, updated_at（某天可有多条；v1.5.0 起仅保留历史数据供迁移） |
| `vocab_words` | word(唯一), phonetic, meanings JSON, example / example_zh, details_json（AI 精讲缓存）, ease_factor / repetitions / interval_days / queue / due_at（SM-2 记忆参数）, status（learning/mastered/suspended）, created_at |
| `vocab_reviews` | word_id(FK), rating(0-3 对应忘记/模糊/记得/轻松), interval_days, reviewed_at — 复习日志，用于详情时间线与统计曲线 |
| `projects`（v1.5.0） | name, description, color, icon, status(active/completed/archived), plan_start_date, plan_end_date, pinned, sort_order, deleted_at — 任务容器 |
| `tasks`（v1.5.0） | project_id(FK CASCADE), parent_id, title, description, status(todo/doing/done), priority, plan_start_time, due_time, planned_today, completed_time, note / note_html, remind_at, remind_type, recurrence, completion_summary, started_at, work_seconds, sort_order, deleted_at |
| `tags`（v1.5.0） | name(UNIQUE), color, status(enabled/disabled) |
| `task_tags`（v1.5.0） | task_id(FK), tag_id(FK) — 联合主键关联 |
| `task_meta`（v1.5.0） | key(PRIMARY), value — 模块级 key-value（提醒偏好、迁移幂等标记等） |
| `task_subtasks`（v1.5.0） | task_id(FK CASCADE), title, done, sort_order — 子任务清单 |
| `attachments`（v1.5.0） | task_id(FK CASCADE), file_name, file_type, file_size, local_path, deleted — 本地文件实体 |
| `task_activity_logs`（v1.5.0） | task_id / project_id, action, summary, created_at — 操作日志时间线 |
| `task_templates`（v1.5.0） | name, project_id, title, description, priority, due_offset_days, tag_ids, subtask_titles(JSON) |
| `project_milestones`（v1.5.0） | project_id(FK CASCADE), name, description, color, status(planned/doing/done), due_date, sort_order |
| `writing_stats`（v1.6.0） | book_id(FK CASCADE), stat_date, words — 按日净增字数，PK(book_id, stat_date)；衍生展示表，不纳入备份导出 |
| `import_rollback_log` | rollback_id, scope, created_at, tables(JSON) — 导入前的回退点（`__tw_rb_{ts}_{table}` 克隆表），24h 内可回滚，启动自动清理 |
| `import_log`（v1.7.0） | payload_hash, file_type, file_size, imported_at — 已导入备份的指纹日志，滚动保留最近 20 条，用于重复导入识别 |
| `chapters_fts` / `world_cards_fts` | FTS5（unicode61），由 6 个 CREATE TRIGGER 自动同步 |
| `chunks_vec` | sqlite-vec `vec0` 动态镜像表（`repository/embedding_repo.rs` 维护），供 KNN 语义检索 |

技术要点：

- r2d2 连接池（max_size=10，超时 10s，空闲 300s，最长存活 1800s）
- 每连接 `PRAGMA foreign_keys=ON; journal_mode=WAL`
- 幂等迁移：`safe_add_column` 检测 duplicate column 后跳过
- 软删除统一使用 `deleted_at` 时间戳

### Agent 引擎 `commands/agent/`（v1.1 起 Rust 原生）

Python Agent（`agent/`）与 Bridge（`src-tauri/src/python/`）已删除，Agent 引擎整体内嵌 Rust：

| 文件 | 职责 |
|------|------|
| `skills.rs` | IPC 命令层：`execute_agent_skill` / `cancel_agent_skill` + 记忆管理（6 个命令） |
| `engine.rs` | SSE 流式 ReAct 工具循环（`run_skill`）+ 全局取消标志 |
| `prompts.rs` | 4 个技能（writing/analysis/research/polish）System Prompt + 动态场景提示 |
| `tools.rs` | 6 个数据库工具（schema + 执行，经 repository 层直查 SQLite） |
| `memory.rs` | `memories` 表 CRUD、规则式提取、检索、旧库自动迁移 |

> 执行链路、事件协议（`agent-stream-chunk`）与记忆系统详见 [Agent 引擎架构](architecture/agent-architecture)。

---

## 脚本 `scripts/`

| 脚本 | 用途 |
|------|------|
| `check.mjs` | 完整性自检（200 项：tsc 产物 + Rust 模块 + Agent 迁移防回归断言；`--fast` 快速模式） |
| `check-npm-versions.ts` / `check-rust-versions.ts` | 前端 / Rust 依赖版本校验 |
| `node-manager.ts` | Node 版本管理（`pnpm node`） |
| `clean.ts` | 构建产物清理（`--all` 全清） |

> v1.1 起已删除 Python 相关：`setup-agent.ts` / `check-python-versions.ts` / `pyrightconfig.json`。

---

## 相关文档

- [IPC 命令速查](development/ipc-api) — 173 条命令完整清单
- [技术栈](development/tech-stack)
- [架构总览](architecture/overview)
- [代码架构深度分析](architecture/code-architecture)
