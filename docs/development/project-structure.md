# 项目结构

> **适用版本**：`1.0.0`　|　**最后核对**：2026-08-31
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
├── src-tauri/                # 🟠 Rust 后端（Tauri v2）
├── agent/                    # 🐍 Python Agent 服务（FastAPI，端口 9877）
├── scripts/                  # 🔧 构建/检查/环境脚本（6 个）
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

各层职责边界在对应 `mod.rs` 注释中明确约定。共注册 **82 个 IPC 命令**。

---

## 前端 `src/`

```
src/
├── main.tsx                  # ReactDOM.createRoot，包裹 ErrorBoundary
├── App.tsx                   # 根组件：JotaiProvider + 主题/字体初始化 + 窗口类型检测
├── vite-env.d.ts             # Vite 环境类型声明
├── pages/                    # 页面级组件
├── components/               # UI 组件（10 个业务域目录 + ErrorBoundary）
├── stores/                   # Zustand（3 slice + pluginStore）+ Jotai（21 atom）
├── lib/                      # 工具库（tauri-bridge.ts / utils / toast / image-utils）
├── hooks/                    # 自定义 Hooks
├── types/                    # TypeScript 类型定义
├── router/                   # React Router v7 配置
├── plugins/                  # 扩展点插件系统
└── styles/                   # CSS（TailwindCSS v4 + HSL 主题变量）
```

### 组件 `components/`（10 个业务域）

| 目录 | 核心文件 | 职责 |
|------|---------|------|
| `library/` | `BookCard`、`NewBookDialog`、`EditBookDialog`、`CoverPicker`、`TrashModal` | 书库网格/列表、封面裁剪、回收站 |
| `outline/` | `OutlinePanel`（842 行） | 卷-章两级目录树、拖拽排序（@dnd-kit）、虚拟滚动、回收站 |
| `editor/` | `RichTextEditor`、`EditorToolbar`、`SnapshotPanel`、`ImageCropperDialog`、`ImageViewerDialog` | TipTap 编辑、工具栏、版本快照、图片处理 |
| `ai/` | `AiSidePanel`、`AiToolboxPanel`、`MessageBubble`、`RequestDetailModal`、`useAiChat`（483 行）、`panel/*` | AI 对话、工具箱、请求详情、Embedding 状态 |
| `agent/` | `AgentPanel`、`AgentMessageBubble`、`AgentMemoryPanel`、`useAgent` | Agent Skill 面板、流式输出、记忆管理 |
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
| `uiAtoms.ts` | **21 个** Jotai atom（UI 瞬态 + 5 个独立窗口开关） |

详见 [状态管理](development/state-management)。

### 工具库 `lib/`

| 文件 | 说明 |
|------|------|
| `tauri-bridge.ts` | **全项目唯一允许调用 `invoke` 的模块**，11 个类型安全 API 对象 |
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

基于**扩展点（Extension Point）**的插件架构，6 个扩展点：`editor-toolbar` / `editor-sidebar` / `library-card` / `export-format` / `ai-prompt` / `command-palette`。详见 [插件系统](development/plugin-system)。

---

## Rust 后端 `src-tauri/`

```
src-tauri/
├── Cargo.toml
├── build.rs
├── tauri.conf.json           # 应用配置（版本 1.0.0、窗口 1280×800、dmg/nsis 打包）
├── entitlements.plist
├── capabilities/
│   └── default.json          # 安全权限声明（CSP / FS / Shell / HTTP）
├── gen/schemas/              # 自动生成的 JSON Schema
├── icons/                    # 应用图标（25 PNG + ICNS + ICO）
└── src/
    ├── main.rs               # 程序入口
    ├── lib.rs                # Tauri Builder：6 插件 + 数据库 + Agent + 82 命令注册
    ├── error.rs              # AppError 统一错误枚举（10 种变体）
    ├── logging.rs            # 日志模块
    ├── utils.rs              # HTTP 客户端工厂、HTML 工具、FTS5 转义、字段校验
    ├── commands/             # IPC 命令层（11 个模块，24 个 .rs 文件）
    ├── service/              # 业务编排层（6 个服务）
    ├── repository/           # 数据访问层（6 个仓库）
    ├── db/                   # r2d2 连接池 + Schema + FTS5 触发器
    ├── models/               # Serde 数据模型（统一 camelCase）
    └── python/               # Agent 子进程管理（manager / client / bridge）
```

### 命令层 `commands/`

| 模块 | 文件 | 命令数 |
|------|------|:---:|
| 书籍 | `book.rs` | 11 |
| 卷 | `volume.rs` | 8 |
| 章节 | `chapter.rs` | 16 |
| 快照 | `snapshot.rs` | 5 |
| 世界观 | `world_card.rs` | 5 |
| 图片 | `image.rs` | 2 |
| 系统检查 | `system_check.rs` | 1 |
| AI | `ai/{mod,chat,embedding,summarize,test}.rs` | 8 |
| 导入导出 | `io/{mod,export,import_txt,backup,crypto}.rs` | 5 |
| 窗口 | `window/{mod,manager,debug,validate}.rs` | 12 |
| Agent | `agent/{mod,skills}.rs` | 9 |

### 业务服务 `service/`

| 文件 | 职责 |
|------|------|
| `book_service.rs` | 创建默认卷、级联删除、字数统计聚合 |
| `chapter_service.rs` | 保存时事务更新全书总字数、内容摘要提取 |
| `volume_service.rs` | 排序、级联操作 |
| `snapshot_service.rs` | 快照创建与恢复 |
| `search_service.rs` | FTS5 全文搜索 + LIKE 降级、向量语义搜索、混合排序 |
| `world_card_service.rs` | 世界观 CRUD + 搜索 |

### 数据仓库 `repository/`

纯 SQL 访问层，不含业务逻辑：`book_repo.rs` / `chapter_repo.rs` / `volume_repo.rs` / `snapshot_repo.rs` / `world_card_repo.rs` / `embedding_repo.rs`。

### 数据库 `db/`

6 张业务表 + 2 张 FTS5 虚拟表：

| 表 | 关键字段 |
|----|---------|
| `books` | title, cover_image, word_count, daily_target, outline, deleted_at |
| `volumes` | book_id(FK), sort_order, deleted_at |
| `chapters` | book_id(FK), volume_id(FK SET NULL), content_html, word_count, status, summary, outline, deleted_at |
| `snapshots` | chapter_id(FK), content_html, type('auto'/'milestone'), label |
| `world_cards` | book_id(FK), type(6 类), content_html, tags, vectorized |
| `embeddings` | source_type, source_id, embedding(BLOB), model — UNIQUE(source_type, source_id) |
| `chapters_fts` / `world_cards_fts` | FTS5（unicode61），由 6 个 CREATE TRIGGER 自动同步 |

技术要点：

- r2d2 连接池（max_size=10，超时 10s，空闲 300s，最长存活 1800s）
- 每连接 `PRAGMA foreign_keys=ON; journal_mode=WAL`
- 幂等迁移：`safe_add_column` 检测 duplicate column 后跳过
- 软删除统一使用 `deleted_at` 时间戳

### Python 集成层 `python/`

```
python/manager.rs  AgentManager —— Python 子进程全生命周期管理
python/client.rs   HTTP 客户端  —— Rust → Python 调用（SSE 消费、记忆 CRUD）
python/bridge.rs   数据桥接    —— Python → Rust 数据回调 HTTP Server（端口 9876）
```

详见 [Agent 架构](architecture/agent-architecture)。

---

## Python Agent `agent/`

```
agent/
├── main.py              # FastAPI 入口：日志初始化、CORS、信号处理、优雅关闭
├── config.py            # AgentConfig + SkillType 枚举 + 任务复杂度→模型层级映射
├── tracer.py            # 统一埋点：@trace 装饰器、独立 logger（propagate=False）
├── pyproject.toml / uv.lock / requirements.txt
├── server/
│   ├── routes.py        # /health、/skills/execute、/memory/* CRUD
│   └── sse.py           # SSE 流式响应（chunk / done / cancelled / error）
├── skills/
│   ├── engine.py        # LangGraph ReAct Agent 构建与流式执行
│   └── prompts.py       # 4 个核心 Skill Prompt + 动态场景提示
├── models/
│   ├── router.py        # 双模型路由：Ollama 本地 / DeepSeek 云端
│   └── __init__.py      # 仅导出 get_model_for_skill / stream_model
├── tools/
│   └── db_tools.py      # 6 个 LangChain 工具（经 9876 Bridge 回调 Rust）
└── memory/
    ├── store.py         # SQLite 记忆持久化 + 规则式记忆提取
    ├── retriever.py     # 关键词匹配 + 类型加权 + 时间衰减检索
    └── summarizer.py    # 本地模型对话历史压缩（>6 轮触发，保留 4 轮）
```

---

## 脚本 `scripts/`

| 脚本 | 用途 |
|------|------|
| `setup-agent.ts` | Agent 环境准备：创建 `.venv`、安装依赖、下载模型（`pnpm agent:setup`） |
| `check.mjs` | 完整性自检（`pnpm check`） |
| `check-npm-versions.ts` / `check-python-versions.ts` / `check-rust-versions.ts` | 三端依赖版本校验 |
| `node-manager.ts` | Node 版本管理（`pnpm node`） |
| `clean.ts` | 构建产物清理（`--all` 全清） |

---

## 相关文档

- [IPC 命令速查](development/ipc-api) — 82 条命令完整清单
- [技术栈](development/tech-stack)
- [架构总览](architecture/overview)
- [代码架构深度分析](architecture/code-architecture)
