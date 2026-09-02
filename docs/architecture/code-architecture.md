# TimeWrite（智写时光）代码架构深度分析

> **适用版本**：`1.0.0`（v1.0 归档文档）。
>
> 基于 v1.0 源码（前端 `src/`、Rust 后端 `src-tauri/`、Python Agent `agent/`、脚本 `scripts/`）整理。
> v1.1 起 Agent 已迁移为 Rust 原生引擎，Python Agent/Bridge 已移除，运行时为双进程模型。
> 本文涉及 Python/三进程章节仅作历史参考；最新实现以 [AI 架构](AI-architecture) 与源码为准。

---

## 1. 系统总览：三进程分层架构

本项目是一个典型的 **Tauri 桌面应用 + 本地 Python AI 服务** 的混合架构，运行时包含 3 个独立进程：

```
┌────────────────────────────────────────────────────────────────────────┐
│  进程 1: WebView 前端（React 19 + TypeScript + TailwindCSS 4）            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ pages/ (书库/编辑器/设置)                                          │  │
│  │ components/ (按业务域分组的 UI 组件)                                │  │
│  │ stores/ (Zustand 业务状态 + Jotai UI 原子状态)                      │  │
│  │ plugins/ (PluginManager 扩展点系统)                                │  │
│  │ lib/tauri-bridge.ts (唯一 IPC 调用入口，11 个 API 模块)              │  │
│  └───────────────────────────┬──────────────────────────────────────┘  │
│                              │ Tauri IPC (invoke / event)              │
├──────────────────────────────┼─────────────────────────────────────────┤
│  进程 2: Rust Core（Tauri v2）                                           │
│  ┌───────────────────────────┴──────────────────────────────────────┐  │
│  │ lib.rs (Builder / 插件注册 / 状态注入 / 事件)                      │  │
│  │ commands/  (IPC 命令层，约 80+ 个命令)                             │  │
│  │ service/   (业务编排层: 事务、审计日志、业务规则)                    │  │
│  │ repository/(数据访问层: 纯 SQL，无业务逻辑)                         │  │
│  │ db/        (r2d2 连接池 + SQLite WAL + FTS5)                      │  │
│  │ python/    (AgentManager 子进程管理 + HTTP Bridge 9876)           │  │
│  └───────────────┬──────────────────────────────┬───────────────────┘  │
│                  │ HTTP (SSE)                    │ HTTP (数据回调)      │
├──────────────────┼──────────────────────────────┼─────────────────────┤
│  进程 3: Python Agent（FastAPI @ 127.0.0.1:9877）│                      │
│  ┌───────────────┴──────────────────────────────┴───────────────────┐  │
│  │ server/routes.py → skills/engine.py (LangGraph ReAct)            │  │
│  │ models/router.py (Ollama 本地 / DeepSeek 云端双模型路由)            │  │
│  │ tools/db_tools.py (6 个工具，经 9876 Bridge 回调 Rust 读数据)        │  │
│  │ memory/ (SQLite 三层记忆: store/retriever/summarizer)            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

**核心设计思想**：Rust 作为"唯一的数据拥有者"（SQLite 独占），前端只通过 IPC 访问数据；Python Agent 作为"AI 执行体"，不直接触碰数据库，而是通过 HTTP Bridge（端口 9876）反向回调 Rust 获取数据。三者之间数据流向单向清晰。

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
- **AppInit 是"窗口路由器"**：通过 URL 参数（`?worldwin=1`、`?historywin=1`、`?summarywin=1`、`?aitoolboxwin=1`、`?debugwin=1`）决定渲染哪个独立窗口面板，主窗口则渲染 `AppRouter`。
- **路由**：React Router v7，`/`（书库）、`/editor/:bookId`（编辑器）、`/settings`（设置），Editor/Settings 懒加载。

### 2.2 状态管理：Zustand（业务）+ Jotai（UI）双轨制

**Zustand — 业务状态（`stores/`）**，采用 slice 模式：

| Slice | 文件 | 职责 |
|-------|------|------|
| `booksSlice` | `stores/booksSlice.ts` | 书籍/卷/章节/世界观数据的加载、CRUD、回收站、选中态 |
| `aiSlice` | `stores/aiSlice.ts` | AI 对话消息、配置、RAG、总结、连接状态 |
| `preferencesSlice` | `stores/preferencesSlice.ts` | 主题/护眼/字体/网格/编辑器宽度等个性化偏好（localStorage 持久化） |
| `pluginStore` | `stores/pluginStore.ts` | 插件启用状态 |

**Jotai — UI 原子状态（`stores/uiAtoms.ts`）**，21 个 atom：
- 编辑器类：`editorInstanceAtom`（TipTap 实例）、`editorFocusAtom`、`editorScrollPositionAtom`、`editorCursorPositionAtom`
- 面板类：`sidebarOpenAtom`、`aiPanelOpenAtom`、`historyPanelOpenAtom`、`zenModeAtom`
- 独立窗口开关：`worldWindowOpenAtom`、`historyWindowOpenAtom`、`summaryWindowOpenAtom`、`aiToolboxWindowOpenAtom`、`debugWindowOpenAtom`（跨页面/跨窗口共享）
- 其他：`modalStackAtom`（模态框栈）、`isSavingAtom`、`wordCountAtom`、`contentRefreshAtom` 等

**分工原则**：跨页面共享且需要持久化的数据 → Zustand；单窗口内高频变化的 UI 瞬态 → Jotai。

### 2.3 组件层次（components/）

按业务域组织 10 个目录：

| 目录 | 核心组件 | 职责 |
|------|---------|------|
| `library/` | BookCard, NewBookDialog, TrashModal, CoverPicker | 书库网格/列表、封面裁剪选择、回收站 |
| `outline/` | OutlinePanel, DraggableVolume, DraggableChapter | 卷-章两级目录树、拖拽排序、回收站 |
| `editor/` | RichTextEditor, EditorToolbar, SnapshotPanel, ImageCropperDialog | TipTap 富文本编辑、工具栏、版本快照 |
| `ai/` | AiSidePanel, useAiChat, panel/*（12 个） | AI 对话面板、工具箱、请求详情、Embedding 状态 |
| `agent/` | AgentPanel, useAgent, AgentMemoryPanel | Agent Skill 侧边面板、记忆管理 |
| `worldbuilding/` | WorldbuildingPanel, WorldCardEditor | 6 类世界观卡片管理 |
| `settings/` | AiConfigSection, RagConfigSection, AppearanceSection 等 12 个 | 设置页分区 |
| `app/` | AppInit, AppClosingOverlay, windowDetection | 应用初始化、关闭遮罩、窗口检测 |
| `common/` | ContextMenu, DebugPanel, ToastContainer | 通用组件 |
| `layout/` | EditorLayout, StatusBar | 编辑器布局、状态栏 |

**编辑器（RichTextEditor）关键技术细节**：
- TipTap 扩展：StarterKit + Underline + Color + TextStyle + Table（4 件套）+ TaskList/Item + CodeBlockLowlight（34 种语言高亮）+ CharacterCount + 自定义 `ResizableImageExtension`（拖拽缩放）
- **双保险自动保存**：300ms 防抖 + 3 分钟定时器，保存结果用后端返回的全书总字数校正 `wordCountAtom`
- 编辑位置恢复：滚动位置 + 光标选区（from/to）自动保存，切章后恢复
- 字数统计：`countWordsFromHtml`（HTML 解析去标签）

### 2.4 IPC 桥接层（lib/tauri-bridge.ts）

**唯一允许 `invoke` 的模块**（代码注释明确禁止在其他文件中直接 import `invoke`），封装 11 个类型安全 API：

| API 模块 | 对应 Rust 命令 | 功能 |
|---------|--------------|------|
| `bookApi` | book.rs (10) | 书籍 CRUD、封面、回收站 |
| `volumeApi` | volume.rs (8) | 卷 CRUD、排序、回收站 |
| `chapterApi` | chapter.rs (17) | 章节 CRUD、保存、总结、大纲 |
| `snapshotApi` | snapshot.rs (5) | 版本快照 |
| `worldCardApi` | world_card.rs (5) | 世界观卡片 + FTS5 搜索 |
| `aiApi` | ai/ (chat/embedding/summarize/test) | 流式对话、RAG、Embedding、总结 |
| `importExportApi` | io/ (export/import_txt/backup) | 格式导出、TXT 导入、加密备份 |
| `imageApi` | image.rs (2) | 图片压缩/裁剪 |
| `windowApi` | window/manager.rs (8) | 4 类独立窗口开关 |
| `debugApi` | window/debug.rs + validate.rs | 调试控制台、数据库校验 |
| `systemApi` | system_check.rs | 环境检查 |

### 2.5 插件系统（plugins/）

- 6 个扩展点：`editor-toolbar` / `editor-sidebar` / `library-card` / `export-format` / `ai-prompt` / `command-palette`
- `PluginManager` 单例：register → enable（调用 init）→ executeCommand → disable（调用 destroy）→ unregister
- 插件生命周期：`installed → active → disabled → error`
- 运行时上下文 `PluginContext` 提供 `app`（书籍/章节获取、通知）、`editor`（选中文本、插入）、`storage`（独立 key-value 存储）
- 内置示例：字符统计插件（`plugins/examples/`）

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

1. 注册 6 个 Tauri 插件：shell / dialog / fs / updater / deep-link / http
2. **数据库初始化**：`app_data_dir/time_write.db` → `AppDb::new()`（建表 + 迁移 + 索引）
3. **Agent Server 异步启动**：`AgentManager::start()`（Python 子进程）
4. **看门狗**：`spawn_watchdog()` 每 10s 健康检查，崩溃自动重启（最多 3 次）
5. **Bridge Server**：`bridge::spawn_bridge()` 在独立线程启动 tiny_http（127.0.0.1:9876）
6. **Bridge 就绪等待**：轮询 TCP 连接最多 5s
7. **窗口关闭拦截**：CloseRequested → prevent_close → 清理 Agent + 关调试窗口 → 真正关闭（AtomicBool 防死循环）
8. 注册约 80 个 IPC 命令

### 3.3 数据库设计（db/schema.rs + migrate）

6 张业务表 + 2 张 FTS5 虚拟表：

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `books` | title, cover_image, word_count, daily_target, outline, deleted_at | 软删除 |
| `volumes` | book_id(FK), sort_order, deleted_at | 软删除 |
| `chapters` | book_id(FK), volume_id(FK SET NULL), content_html, word_count, status, summary, outline, deleted_at | 软删除 + AI 总结 |
| `snapshots` | chapter_id(FK), content_html, type('auto'/'milestone'), label | 版本快照 |
| `world_cards` | book_id(FK), type(6 类), content_html, tags, vectorized | 世界观 |
| `embeddings` | source_type, source_id, embedding(BLOB), model | 向量索引，UNIQUE(source_type, source_id) |
| `chapters_fts` / `world_cards_fts` | FTS5 (unicode61) | 全文搜索，INSERT/UPDATE/DELETE 三触发器自动同步 |

技术要点：
- r2d2 连接池（max_size=10，超时 10s，空闲 300s，最长存活 1800s）
- 每连接 `PRAGMA foreign_keys=ON; journal_mode=WAL`
- 幂等迁移：`safe_add_column` 检测 duplicate column 跳过
- 7 个关键索引（book_id、sort_order、deleted_at 组合）

### 3.4 Python 集成层（python/）

**三个模块三种职责**：

```
python/manager.rs  AgentManager —— Python 子进程全生命周期管理
python/client.rs   HTTP 客户端  —— Rust → Python 调用（SSE 消费、记忆管理 CRUD）
python/bridge.rs   数据桥接    —— Python → Rust 数据回调 HTTP Server
```

**AgentManager 关键能力**：
- `find_python()`：优先级 用户指定 → `agent/.venv`（验证 uvicorn 可用性）→ `which python`（验证 uvicorn）→ 降级 `"python"`
- `find_agent_entry()`：开发模式（工作目录）→ 生产模式（macOS bundle Resources / flat resources 目录）
- 端口管理：`wait_for_port_free`（轮询 + auto-kill 僵尸进程）、`kill_process_on_port`（lsof/netstat 找 PID，libc SIGKILL 进程组 + 主进程双重保障）
- 优雅关闭：SIGTERM → 等 10s → SIGKILL → 端口释放验证
- 看门狗：`spawn_watchdog` 10s 间隔健康检查，状态机驱动（Stopped/Starting/Running/Crashed）

**Bridge Server（端口 9876）**：4 个路由 `read_chapter` / `list_chapters` / `search_world_cards` / `book_context`，直接调用 repository 层查询 SQLite 返回 JSON。

### 3.5 AI 通信层（commands/ai/）

| 文件 | 职责 |
|------|------|
| `chat.rs` | `stream_ai_chat` — OpenAI 兼容 SSE 流式对话（智谱/DeepSeek/自定义端点） |
| `embedding.rs` | RAG 向量检索（向量优先，FTS5/LIKE 降级）、Embedding 索引触发/状态检查 |
| `summarize.rs` | 章节总结、对话总结（滑动窗口压缩） |
| `test.rs` | AI 连接测试 |

**chat.rs 技术细节**：
- 自动重试：最多 2 次，指数退避（1s/2s），`is_retryable_error` 白名单过滤永久性错误
- 10 分钟全局超时 + 60s 单 chunk 读取超时（`tokio::time::timeout` 双层保护）
- 断流保底：`flush_sse_buffer` 刷新残留 buffer，已有内容时以 done 事件收尾而非报错
- DeepSeek 思考模式：`reasoning_content` 独立累积并推送 thinking 阶段事件；KV Cache 命中统计（`prompt_cache_hit_tokens`）
- 事件协议：`ai-stream-chunk`，StreamEvent { content, thinking, phase: thinking/answering/retrying/done, done, error, usage }

### 3.6 错误处理（error.rs）

`AppError` 枚举（10 种变体：DbPool/Db/Http/Serde/Io/Crypto/Validation/NotFound/Business/General），实现 `Serialize`（序列化为字符串）、`From<rusqlite::Error/r2d2::Error/anyhow::Error/String>`，可直接作为 Tauri 命令 Err 返回。

### 3.7 工具层（utils.rs）

- 时间戳 `now()`、HTML 剥离 `strip_html`（正则 OnceLock 缓存）、`snippet`
- HTTP 客户端工厂：普通客户端（代理探测 HTTPS_PROXY→ALL_PROXY）+ SSE 客户端（HTTP/1.1、禁压缩、TCP keepalive 120s）
- FTS5 安全转义 `escape_fts5_query`、LIKE 降级 `like_pattern`
- 字段长度校验常量 + `validate_len`

---

## 4. Python Agent 架构（agent/）

### 4.1 模块地图

```
agent/
├── main.py            # FastAPI 入口：日志初始化、CORS、信号处理、优雅关闭
├── config.py          # AgentConfig 数据类 + SkillType 枚举 + 任务复杂度→模型层级映射
├── tracer.py          # 统一埋点：@trace 装饰器（传参/返参/耗时）、独立 logger
├── server/
│   ├── routes.py      # HTTP API：/health、/skills/execute、/memory/* CRUD
│   └── sse.py         # SSE 流式响应生成器（chunk/done/cancelled/error 事件）
├── skills/
│   ├── engine.py      # LangGraph ReAct Agent 构建与流式执行
│   └── prompts.py     # 4 个核心 Skill Prompt + 动态场景提示 + Token 估算
├── models/
│   └── router.py      # 双模型路由：Ollama 本地 / DeepSeek 云端（按缓存+哈希）
├── tools/
│   └── db_tools.py    # 6 个 LangChain 工具（经 9876 Bridge 回调 Rust）
├── memory/
│   ├── store.py       # SQLite 记忆持久化 + 规则式记忆提取
│   ├── retriever.py   # 关键词匹配 + 类型加权 + 时间衰减检索
│   └── summarizer.py  # 本地模型对话历史压缩（>6 轮压缩，保留 4 轮）
└── models/__init__.py # 仅导出 get_model_for_skill / stream_model
```

### 4.2 Skill 执行引擎（skills/engine.py）

**LangGraph ReAct 架构**：

```
execute_skill_stream(skill, book_id, message, ...)
  ├─ _build_agent()
  │    ├─ get_model_for_skill()      # 按 Skill 选本地/云端模型
  │    ├─ get_dynamic_prompt()       # 核心 Prompt + 关键词匹配的场景提示（最多 3 个）
  │    ├─ MemoryRetriever.get_memory_prompt()  # 注入相关记忆（≤600 tokens）
  │    ├─ 拼接 System Prompt（KV Cache 友好：前缀结构稳定 + 时间戳 + 摘要段）
  │    └─ 选择性工具集（SKILL_TOOLS_MAP 按 Skill 定制）
  ├─ 历史消息清洗（剥离 reasoning_content，保留 tool_calls/ToolMessage 配对）
  ├─ 历史压缩（前端已传摘要则跳过；否则本地 Ollama 压缩，>6 轮触发保留 4 轮）
  ├─ agent.astream_events()          # v2 事件流，thread_id 每次请求 uuid4 唯一
  │    ├─ on_tool_start/on_tool_end  # 工具调用追踪
  │    └─ on_chat_model_stream       # 文本增量 yield（首 Token 延迟监控 TTFT）
  └─ 异步保存记忆（extract_and_save，不阻塞响应）
```

**4 个 Skill 与模型/工具映射**：

| Skill | 核心能力 | 模型层级 | 工具集 |
|-------|---------|---------|--------|
| WRITING（写作） | 大纲/情节/对话/冲突 | 云端 DeepSeek | summary/chunk/list/search/context |
| ANALYSIS（分析） | 文风/连贯/伏笔/弧光 | 云端 DeepSeek | read/chunk/list/search/context |
| RESEARCH（研究） | 检索/一致性/扩展/图谱 | 云端 DeepSeek | summary/list/search/context |
| POLISH（润色） | 语法/文笔/风格/精简 | 本地 Ollama | read/chunk/context |

### 4.3 双模型路由（models/router.py）

- **本地模型**：`ChatOllama(qwen2.5:7b @ 127.0.0.1:11434)`，懒加载单例，temperature 0.7，num_predict 4096
- **云端模型**：按请求 `ai_config` 动态创建，缓存 key = `(endpoint, model, api_key_hash, thinking_enabled, reasoning_effort)`
- DeepSeek 适配：`model_kwargs` 注入 `thinking: {type: enabled}` + `reasoning_effort: max`（Agent 场景）
- 兼容 camelCase（前端）/ snake_case（Python）双格式配置读取
- API Key 安全：sha256 哈希做缓存键、首尾去空白、缺失时给出对应服务商获取指引

### 4.4 工具链（tools/db_tools.py）

6 个工具全部通过 HTTP 回调 Rust Bridge（`POST /agent/{endpoint}`）：

| 工具 | 用途 | 调用端点 |
|------|------|---------|
| `read_chapter` | 读取完整章节 | read_chapter |
| `read_chapter_summary` | 摘要优先，节省 Token | read_chapter |
| `read_chapter_chunk` | 大章节分页读取（2000 字/段） | read_chapter |
| `list_book_chapters` | 章节列表 | list_chapters |
| `search_world_cards` | 世界观搜索（截断 300 字/条，限 5 条） | search_world_cards |
| `get_book_context` | 整书上下文（近 5 章摘要 + 世界观概览） | book_context |

健壮性设计：
- `ToolCache`：请求级 LRU 缓存（32 条，TTL 300s）
- Bridge 连接错误重试：3 次指数退避（0.5s→1s→2s），成功后重建 httpx 连接池
- Bridge 业务错误（404/500）不重试直接报错并输出详细诊断

### 4.5 记忆体系统（memory/）

**三层记忆类型**：`preference`（偏好）/ `decision`（决策）/ `lesson`（经验）

- **store.py**：SQLite（`data/agent_memory.db`）WAL 模式 + 单例 + 线程锁；`extract_and_save` 基于规则从对话中自动提取记忆（关键词触发，不消耗额外 LLM 调用）
- **retriever.py**：检索策略 = 关键词交集打分 + 类型加权（preference 1.2 > decision 1.0 > lesson 0.8）+ 时间衰减 + Token 预算 600
- **summarizer.py**：本地 Ollama 压缩对话（>6 轮触发，保留最近 4 轮），结构化输出（关键决策/用户偏好/讨论要点/已确认设定）

### 4.6 追踪系统（tracer.py）

- 独立 logger `agent.tracer`（propagate=False），避免被 uvicorn 覆盖
- `@trace` 装饰器自动记录函数传参/返参/耗时
- `trace_event` 输出带 `[TRACE]` 前缀的结构化事件（HTTP_REQUEST、SSE_PROGRESS、AGENT_TOOL_START、MEMORY_* 等）
- `AGENT_TRACE_LEVEL` 环境变量控制级别（DEBUG/INFO/WARN），默认 DEBUG

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

### 5.2 Agent Skill 执行（前端 → Rust → Python → Rust → SQLite）

```
AgentPanel 发送消息
  → useAgent.executeSkill()（生成 requestId，注入 aiConfig）
  → invoke('execute_agent_skill', { skill, bookId, message, aiConfig, requestId })
  → commands/agent/skills.rs
  → python/client.rs: POST http://127.0.0.1:9877/skills/execute
  → server/routes.py → sse.py
  → skills/engine.py: LangGraph ReAct（动态 Prompt + 记忆注入 + 模型路由）
  → Agent 选择工具 → tools/db_tools.py
  → httpx POST http://127.0.0.1:9876/agent/read_chapter
  → python/bridge.rs: repository 查询 SQLite → JSON 返回
  → Agent 流式输出 → sse.py (chunk 事件)
  → python/client.rs 解析 SSE → app.emit('agent-stream-chunk', {event, data, requestId})
  → 前端按 requestId 过滤 → RAF 缓冲合并 → 批量更新 UI
```

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
| `scripts/setup-agent.ts` | Agent 环境准备：创建 `.venv`、安装依赖、下载模型、检查 |
| `scripts/check.mjs` | 完整性自检 |
| `scripts/check-npm-versions.ts` / `check-python-versions.ts` / `check-rust-versions.ts` | 三端依赖版本校验 |
| `scripts/node-manager.ts` | Node 版本管理（`pnpm node`） |
| `scripts/clean.ts` | 构建产物清理（`--all` 全清） |

- **Vite 8**：`@` → `src` 别名；manualChunks 将 react/tiptap/lucide/state/router/markdown/utils/virtual/highlight/katex/dnd-kit/tauri-vendor 拆为独立 chunk
- **Tauri 打包**：dmg（macOS）+ nsis（Windows，简体中文/English 双语言），`agent/` 目录作为 resource 随包分发，deep-link 协议 `com.ukcoder.timewrite://`
- **CSP**：严格白名单（connect-src 含 `127.0.0.1:9877`/`9876` Agent/Bridge 端口）

---

## 7. 关键技术决策与设计亮点

1. **Python Agent 不直接访问 SQLite**：通过 9876 Bridge 回调，保证数据库写操作唯一入口在 Rust，避免多进程并发写 SQLite 的锁竞争与数据一致性风险。
2. **子进程全生命周期管理**：解释器探测（venv 符号链接陷阱规避）、端口僵尸清理（进程组 SIGKILL）、看门狗自动重启（3 次上限）、优雅关闭（SIGTERM→10s→SIGKILL）。
3. **双模型路由按任务复杂度分配**：润色（简单任务）走本地 Ollama 省成本，写作/分析/研究（复杂推理）走云端 DeepSeek。
4. **DeepSeek 思考模式深度适配**：reasoning_content 独立流、KV Cache 友好 Prompt 前缀、reasoning_effort=max、TTFT 监控。
5. **前端 RAF 缓冲**：Agent 流式输出按帧合并更新，避免高频 chunk 触发大量重渲染。
6. **双轨状态管理**：Zustand 承载业务数据（slice 模式），Jotai 承载 UI 瞬态（21 个 atom），各司其职。
7. **双保险自动保存**：防抖 + 定时器组合，配合后端事务更新全书字数。
8. **多层网络容错**：AI 对话重试白名单、SSE 断流保留已生成内容、Bridge 连接指数退避重试。
9. **权限最小化**：capabilities/default.json 仅向 5 个窗口授予核心权限，CSP 严格限定 connect-src。
10. **独立窗口系统**：通过 URL 参数路由到 5 种悬浮面板（always_on_top），Jotai 原子跨窗口同步开关状态。

---

## 8. 目录速查

```
MirageInk/
├── src/                      # 🔵 前端（React 19 + TS 6）
│   ├── pages/                #   LibraryPage / EditorPage / SettingsPage
│   ├── components/           #   10 个业务域组件目录 + ErrorBoundary
│   ├── stores/               #   Zustand 3 slices + Jotai 21 atoms + pluginStore
│   ├── lib/                  #   tauri-bridge.ts（IPC 唯一入口）/ utils / toast / image
│   ├── hooks/                #   useAppVersion / useConsoleInterceptor / useResizeHandle / useThemeFontInit
│   ├── plugins/              #   PluginManager 单例 + 6 扩展点 + 示例插件
│   ├── router/               #   React Router v7（懒加载）
│   ├── types/                #   全部领域类型 + DTO 对齐
│   └── styles/               #   TailwindCSS 4 + HSL 主题变量（4 套主题）
├── src-tauri/                # 🟠 Rust 后端（Tauri v2）
│   ├── src/
│   │   ├── lib.rs            #   Builder / 插件 / 启动编排 / 80+ 命令注册
│   │   ├── commands/         #   book/volume/chapter/snapshot/world_card/image/system_check + ai/io/window/agent
│   │   ├── service/          #   6 个业务服务（事务 + 审计）
│   │   ├── repository/       #   6 个数据仓库（纯 SQL）
│   │   ├── db/               #   r2d2 连接池 + Schema + FTS5
│   │   ├── python/           #   manager（子进程）/ client（HTTP）/ bridge（回调 Server）
│   │   ├── error.rs          #   AppError 统一错误
│   │   └── utils.rs          #   HTTP 客户端 / HTML 工具 / 校验
│   ├── capabilities/         #   权限声明
│   └── tauri.conf.json       #   App 配置 + 打包 + 插件
├── agent/                    # 🐍 Python Agent（FastAPI @ 9877）
│   ├── server/               #   routes + SSE
│   ├── skills/               #   LangGraph ReAct 引擎 + 4 Skill Prompts
│   ├── models/               #   双模型路由
│   ├── tools/                #   6 个 DB Bridge 工具
│   ├── memory/               #   store / retriever / summarizer
│   └── config.py / main.py / tracer.py
├── scripts/                  # 🔧 6 个工程化脚本
├── docs/                     # 📖 Wiki 文档（含本文件）
└── product/                  # 🏠 产品落地页
```
