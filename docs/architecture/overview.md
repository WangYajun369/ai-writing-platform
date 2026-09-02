# 架构总览

> **适用版本**：`1.2.0`　|　**最后核对**：2026-09-02
>
> TimeWrite（MirageInk / 智写时光）运行时为**双进程模型**：WebView 前端 + Rust Core。
> v1.1 起 Agent 已由 Python 外部子进程迁移为 **Rust 原生引擎**（见 [Agent 引擎架构](agent-architecture)），
> 不再存在独立的 Agent 进程与 9877/9876 桥接端口。

---

## 系统架构：双进程模型

TimeWrite 运行时包含 **2 个进程**。Rust 是**唯一的数据拥有者**（SQLite 独占），前端只通过 IPC 访问数据。

```
┌─────────────────────────────────────────────────────────────┐
│  进程 1：WebView 前端（React 19 + TypeScript + TailwindCSS 4） │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ pages/        components/       stores/                │  │
│  │ 书库/编辑器/设置  业务域组件        Zustand + Jotai      │  │
│  │        └──────────────┼──────────────┘                 │  │
│  │        lib/tauri-bridge.ts（唯一 IPC 入口，10+ 个 API）  │  │
│  └───────────────────────┼───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │ Tauri IPC（invoke / event）
┌──────────────────────────┼──────────────────────────────────┐
│  进程 2：Rust Core（Tauri v2）                                │
│  ┌───────────────────────┴───────────────────────────────┐  │
│  │ commands/    12 个模块（book/volume/chapter/snapshot/  │  │
│  │              world_card/ai/agent/io/image/window/...） │  │
│  │ service/     业务编排：事务边界 + SQL 审计日志           │  │
│  │ repository/  数据访问：纯 SQL，无业务逻辑               │  │
│  │ db/          r2d2 连接池 + SQLite WAL + FTS5           │  │
│  │ commands/agent/  Rust 原生 Agent 引擎                  │  │
│  │   （engine/prompts/tools/memory/skills）                │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

> **历史演进**：v1.0 曾为三进程架构（Rust + Python FastAPI Agent @9877 + tiny_http Bridge @9876），
> v1.1 已将 Agent 引擎整体内嵌 Rust，`agent/` 目录与 `src-tauri/src/python/` 一并移除。

### 端口分配

| 端口 | 服务 | 说明 |
|------|------|------|
| 11434 | Ollama（可选） | 本地模型（AI 对话本地服务商） |
| 1420 | Vite 开发服务器 | 仅开发模式 |

> 原 Agent 服务（9877）与 Bridge（9876）端口已随 Python Agent 移除，不再占用。

---

## Agent 引擎（v1.2 内嵌于 Rust）

Agent 自动化能力由 `src-tauri/src/commands/agent/` 提供，**无外部进程、无需 Python 环境**：

| 模块 | 职责 |
|------|------|
| `engine.rs` | SSE 流式 ReAct 工具循环（`run_skill` + 任务取消），调用云端模型 API |
| `prompts.rs` | 4 个技能（writing/analysis/research/polish）的 System Prompt + 动态场景提示 |
| `tools.rs` | 6 个数据库工具（读章节/摘要/分页/章节列表/世界观搜索/整书上下文） |
| `memory.rs` | `memories` 表存取：CRUD、关键词检索、规则式记忆提取、旧库迁移 |
| `skills.rs` | IPC 命令层：`execute_agent_skill` / `cancel_agent_skill` + 记忆管理命令 |

Agent 执行时直接调用**同一 Rust 进程内**的 repository 层查询 SQLite（不再经 HTTP 回调），
流式输出通过 Tauri 事件 `agent-stream-chunk` 推送前端。详见 [Agent 引擎架构](agent-architecture)。

---

## 核心设计原则

### 1. 关注点分离

| 层 | 职责 |
|----|------|
| 前端 | UI 渲染、用户交互、状态管理 |
| Rust 后端 | 数据持久化、业务逻辑、AI 集成（对话/RAG/Agent 引擎） |
| 桥接层 | 类型安全的 IPC 封装（`tauri-bridge.ts` 是唯一 `invoke` 入口；Agent 调用为例外，见下） |

> **约定例外**：`useAgent.ts` / `AgentMemoryPanel.tsx` 直接 `invoke('execute_agent_skill')` 等
> Agent 命令（未走 `tauri-bridge.ts` 封装），与「唯一入口」约定不一致，列为待重构项。

### 2. 单向数据流

```
用户操作 → React 组件 → Zustand Action → tauri-bridge.invoke()
  → Rust 命令 → service（事务）→ repository（SQL）→ SQLite
  → 返回结果 → 更新状态 → 重新渲染
```

### 3. 实时事件流

```
Rust 命令 → app.emit('ai-stream-chunk')      → 前端 listen() → 更新 AI 消息
Agent 引擎 → app.emit('agent-stream-chunk')   → 前端 listen() → 更新 Agent 消息（RAF 缓冲）
Rust 命令 → app.emit('debug-log')             → 调试窗口 listen() → 追加日志
窗口关闭  → app.emit('agent-status-changed')  → 前端 listen() → 显示退出遮罩（status=closing）
```

### 4. 数据主权

- **Rust 独占写权限**：所有数据库写操作必须经 Rust
- **前端零直连**：前端不接触 SQL，只通过 IPC
- **Agent 与数据同进程**：工具调用直接走 repository 层，无跨进程回调，天然规避写锁竞争

---

## 分层设计（Rust 侧）

```
commands/   IPC 命令层   —— 参数校验、调用 service、返回 DTO（无 SQL）
service/    业务编排层   —— 事务边界、业务规则、SQL 审计日志（emit_sql_log）
repository/ 数据访问层   —— 纯 SQL 操作，接受 &Connection，无业务逻辑
db/         连接与 Schema —— r2d2 连接池、幂等迁移、FTS5 触发器、索引
```

各层职责边界在对应 `mod.rs` 注释中有明确约定，例如 repository 层「不依赖 Tauri State / AppHandle，不包含任何业务逻辑」。

---

## 数据库设计

**9 张业务表 + 2 张 FTS5 虚拟表**

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `books` | title, author, cover_image, word_count, daily_target, outline, deleted_at | 书籍元信息，软删除 |
| `volumes` | book_id (FK), title, sort_order, deleted_at | 卷，软删除 |
| `chapters` | book_id (FK), volume_id (FK SET NULL), content_html, word_count, status, summary, outline, deleted_at | 章节，软删除 + AI 总结 |
| `snapshots` | chapter_id (FK), content_html, type ('auto'/'milestone'), label | 版本快照 |
| `world_cards` | book_id (FK), type（6 类）, content_html, tags, vectorized | 世界观卡片 |
| `embeddings` | source_type, source_id, embedding (BLOB), model | 向量索引，`UNIQUE(source_type, source_id)` |
| `memories` | book_id, skill_type, memory_type, content, keywords, relevance_score | Agent 记忆（v1.1 起并入主库） |
| `diaries` | diary_date (UNIQUE), content_html, word_count, keywords, created_at, updated_at | 日记（每天至多一篇） |
| `schedules` | schedule_date, content, done (0/1), created_at, updated_at | 个人日程（某天多条） |
| `chapters_fts` | FTS5（unicode61） | 章节全文搜索，由 3 个触发器自动同步 |
| `world_cards_fts` | FTS5（unicode61） | 世界观全文搜索，由 3 个触发器自动同步 |

**技术要点**

- r2d2 连接池（max_size=10，超时 10s，空闲 300s，最长存活 1800s）
- 每连接 `PRAGMA foreign_keys=ON; journal_mode=WAL`
- 幂等迁移：`safe_add_column()` 检测 duplicate column 后跳过；memories 表启动时自动建表 + 索引
- 软删除统一使用 `deleted_at` 时间戳，配合回收站机制
- FTS5 由 INSERT/UPDATE/DELETE 三触发器增量维护，**启动时无需重建索引**

---

## IPC 模块映射

前端 `tauri-bridge.ts` 暴露 13 个 API 对象，完整命令清单见 [IPC 命令速查](development/ipc-api)。

| API 模块 | Rust 源文件 | 功能 |
|---------|------------|------|
| `bookApi` | `commands/book.rs` | 书籍 CRUD + 封面 + 回收站 |
| `volumeApi` | `commands/volume.rs` | 卷管理 |
| `chapterApi` | `commands/chapter.rs` | 章节 CRUD + 自动保存 + 总结/大纲 |
| `snapshotApi` | `commands/snapshot.rs` | 版本快照 |
| `worldCardApi` | `commands/world_card.rs` | 世界观卡片 + FTS5 搜索 |
| `diaryApi` | `commands/diary.rs` | 日记按月/全部摘要、全文读写与删除 |
| `scheduleApi` | `commands/schedule.rs` | 个人日程按日/按月读写与删除 |
| `aiApi` | `commands/ai/` | 流式对话 + RAG + Embedding（预留）+ 总结 |
| `importExportApi` | `commands/io/` | 导入导出 + 加密备份 |
| `imageApi` | `commands/image.rs` | 图片压缩与裁剪 |
| `windowApi` | `commands/window/manager.rs` | 独立窗口开关 |
| `debugApi` | `commands/window/{debug,validate}.rs` | 调试控制台 + 数据库校验 |
| `systemApi` | `commands/system_check.rs` | 运行环境自检 |
| **Agent（组件直接 invoke）** | `commands/agent/skills.rs` | `execute_agent_skill` / `cancel_agent_skill` / 记忆 CRUD（4 个） |

> v1.1 起原 `get_agent_status` / `start_agent` / `stop_agent`（启停外部 Python 进程）已移除。

---

## Tauri 插件

| 插件 | 用途 |
|------|------|
| `tauri-plugin-http` | AI API 请求 |
| `tauri-plugin-dialog` | 原生文件选择对话框 |
| `tauri-plugin-fs` | 文件系统读写 |
| `tauri-plugin-shell` | Shell 命令执行 |
| `tauri-plugin-updater` | 应用自动更新 |
| `tauri-plugin-deep-link` | URL Scheme 唤起（`com.ukcoder.timewrite://`） |

---

## 主题系统

基于 HSL CSS 变量实现，定义于 `src/styles/theme.css`。

**两个独立维度**：

| 维度 | 取值 | 说明 |
|------|------|------|
| 基础主题 `theme` | `light` / `dark` / `system` | `system` 跟随操作系统 |
| 护眼模式 `eyeCareMode` | `off` / `warm` / `green` | 暖黄色 / 豆沙绿 |

CSS 类组合由两者叠加而成（`.eyecare-warm`、`.dark.eyecare-green` 等），共 **6 种视觉组合**。

| | 关闭护眼 | 暖黄 `warm` | 豆沙绿 `green` |
|---|:---:|:---:|:---:|
| 亮色 `light` | 标准亮色 | 暖黄亮色 | 豆沙绿亮色 |
| 暗色 `dark` | 标准暗色 | 暖黄暗色 | 豆沙绿暗色 |

跟随系统（`system`）时基础主题由操作系统决定，再叠加护眼模式。

---

## 独立窗口系统

通过 URL 参数路由到 5 种悬浮面板（`always_on_top`），窗口开关状态由 Jotai atom 跨窗口共享：

| 窗口 | URL 参数 | atom |
|------|---------|------|
| 世界观资料库 | `?worldwin=1` | `worldWindowOpenAtom` |
| 版本历史 | `?historywin=1` | `historyWindowOpenAtom` |
| 章节总结 | `?summarywin=1` | `summaryWindowOpenAtom` |
| AI 工具箱 | `?aitoolboxwin=1` | `aiToolboxWindowOpenAtom` |
| 调试控制台 | `?debugwin=1` | `debugWindowOpenAtom` |

`components/app/AppInit.tsx` 充当「窗口路由器」，根据 URL 参数决定渲染哪个面板。

---

## 相关文档

| 主题 | 文档 |
|------|------|
| Agent 引擎（Rust 原生） | [Agent 引擎架构](agent-architecture) |
| AI 对话 / RAG / 总结 | [AI 模块架构](AI-architecture) |
| 目录结构与分层细节 | [项目结构](development/project-structure) |
| 每个模块的实现细节 | [代码架构深度分析](code-architecture) |
| 全部 IPC 命令 | [IPC 命令速查](development/ipc-api) |
| 已知问题与改进项 | [优化报告](meta/optimization-report) |
