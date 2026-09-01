# 架构总览

> **适用版本**：`1.0.0`　|　**最后核对**：2026-08-31

---

## 系统架构：三进程模型

TimeWrite 运行时包含 **3 个独立进程**。Rust 是**唯一的数据拥有者**（SQLite 独占），前端只通过 IPC 访问数据，Python Agent 只通过 Bridge 回调读数据。

```
┌─────────────────────────────────────────────────────────────┐
│  进程 1：WebView 前端（React 19 + TypeScript + TailwindCSS 4） │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ pages/        components/       stores/                │  │
│  │ 书库/编辑器/设置  10 个业务域组件   Zustand + Jotai       │  │
│  │        └──────────────┼──────────────┘                 │  │
│  │        lib/tauri-bridge.ts（唯一 IPC 入口，11 个 API）   │  │
│  └───────────────────────┼───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │ Tauri IPC（invoke / event）
┌──────────────────────────┼──────────────────────────────────┐
│  进程 2：Rust Core（Tauri v2）                                │
│  ┌───────────────────────┴───────────────────────────────┐  │
│  │ commands/    11 个模块，82 个 IPC 命令                   │  │
│  │ service/     业务编排：事务边界 + SQL 审计日志            │  │
│  │ repository/  数据访问：纯 SQL，无业务逻辑                 │  │
│  │ db/          r2d2 连接池 + SQLite WAL + FTS5            │  │
│  │ python/      AgentManager + Client + Bridge Server      │  │
│  └──────┬────────────────────────────────┬────────────────┘  │
└─────────┼────────────────────────────────┼───────────────────┘
          │ HTTP SSE（9877）                │ HTTP 回调（9876）
┌─────────┴────────────────────────────────┴───────────────────┐
│  进程 3：Python Agent（FastAPI @ 127.0.0.1:9877）              │
│  server/routes.py → skills/engine.py（LangGraph ReAct）       │
│  models/router.py（Ollama 本地 / DeepSeek 云端双模型路由）      │
│  tools/db_tools.py（6 个工具，经 9876 Bridge 回调 Rust 读数据） │
│  memory/（SQLite 三层记忆）                                    │
└───────────────────────────────────────────────────────────────┘
```

### 端口分配

| 端口 | 服务 | 方向 |
|------|------|------|
| **9877** | Python Agent（FastAPI） | Rust → Python |
| **9876** | Rust Bridge（tiny_http） | Python → Rust（回调读库） |
| 11434 | Ollama（可选） | Python → 本地模型 |
| 1420 | Vite 开发服务器 | 仅开发模式 |

---

## 核心设计原则

### 1. 关注点分离

| 层 | 职责 |
|----|------|
| 前端 | UI 渲染、用户交互、状态管理 |
| Rust 后端 | 数据持久化、业务逻辑、AI 集成、子进程管理 |
| 桥接层 | 类型安全的 IPC 封装（`tauri-bridge.ts` 是唯一 `invoke` 入口） |
| Python Agent | AI 执行体，只读数据，不持有数据库 |

### 2. 单向数据流

```
用户操作 → React 组件 → Zustand Action → tauri-bridge.invoke()
  → Rust 命令 → service（事务）→ repository（SQL）→ SQLite
  → 返回结果 → 更新状态 → 重新渲染
```

### 3. 实时事件流

```
Rust 命令 → app.emit('ai-stream-chunk')    → 前端 listen() → 更新 AI 消息
Rust 命令 → app.emit('agent-stream-chunk') → 前端 listen() → 更新 Agent 消息
Rust 命令 → app.emit('debug-log')          → 调试窗口 listen() → 追加日志
```

### 4. 数据主权

- **Rust 独占写权限**：所有数据库写操作必须经 Rust
- **Python 只读**：Agent 只能通过 Bridge 读取，杜绝多进程写锁竞争
- **前端零直连**：前端不接触 SQL，只通过 IPC

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

**6 张业务表 + 2 张 FTS5 虚拟表**

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `books` | title, author, cover_image, word_count, daily_target, outline, deleted_at | 书籍元信息，软删除 |
| `volumes` | book_id (FK), title, sort_order, deleted_at | 卷，软删除 |
| `chapters` | book_id (FK), volume_id (FK SET NULL), content_html, word_count, status, summary, outline, deleted_at | 章节，软删除 + AI 总结 |
| `snapshots` | chapter_id (FK), content_html, type ('auto'/'milestone'), label | 版本快照 |
| `world_cards` | book_id (FK), type（6 类）, content_html, tags, vectorized | 世界观卡片 |
| `embeddings` | source_type, source_id, embedding (BLOB), model | 向量索引，`UNIQUE(source_type, source_id)` |
| `chapters_fts` | FTS5（unicode61） | 章节全文搜索，由 3 个触发器自动同步 |
| `world_cards_fts` | FTS5（unicode61） | 世界观全文搜索，由 3 个触发器自动同步 |

**技术要点**

- r2d2 连接池（max_size=10，超时 10s，空闲 300s，最长存活 1800s）
- 每连接 `PRAGMA foreign_keys=ON; journal_mode=WAL`
- 幂等迁移：`safe_add_column()` 检测 duplicate column 后跳过
- 软删除统一使用 `deleted_at` 时间戳，配合回收站机制
- FTS5 由 INSERT/UPDATE/DELETE 三触发器增量维护，**启动时无需重建索引**

---

## IPC 模块映射

共 **82 个命令**，11 个前端 API 对象。完整清单见 [IPC 命令速查](development/ipc-api)。

| API 模块 | Rust 源文件 | 命令数 | 功能 |
|---------|------------|:---:|------|
| `bookApi` | `commands/book.rs` | 11 | 书籍 CRUD + 封面 + 回收站 |
| `volumeApi` | `commands/volume.rs` | 8 | 卷管理 |
| `chapterApi` | `commands/chapter.rs` | 16 | 章节 CRUD + 自动保存 + 总结/大纲 |
| `snapshotApi` | `commands/snapshot.rs` | 5 | 版本快照 |
| `worldCardApi` | `commands/world_card.rs` | 5 | 世界观卡片 + FTS5 搜索 |
| `aiApi` | `commands/ai/` | 8 | 流式对话 + RAG + Embedding + 总结 |
| `importExportApi` | `commands/io/` | 5 | 导入导出 + 加密备份 |
| `imageApi` | `commands/image.rs` | 2 | 图片压缩与裁剪 |
| `windowApi` | `commands/window/manager.rs` | 6 | 4 类独立窗口开关 |
| `debugApi` | `commands/window/{debug,validate}.rs` | 6 | 调试控制台 + 数据库校验 |
| `agentApi` | `commands/agent/skills.rs` | 9 | Agent 服务管理 + 技能执行 + 记忆管理 |
| `systemApi` | `commands/system_check.rs` | 1 | 运行环境自检 |

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
| 目录结构与分层细节 | [项目结构](development/project-structure) |
| 每个模块的实现 | [代码架构深度分析](architecture/code-architecture) |
| AI 对话与 RAG | [AI 模块架构](architecture/AI-architecture) |
| Python Agent 子系统 | [Agent 架构](architecture/agent-architecture) |
| 全部 IPC 命令 | [IPC 命令速查](development/ipc-api) |
| 已知问题与改进项 | [优化报告](meta/optimization-report) |
