# 技术栈

> **适用版本**：`1.0.0`　|　**最后核对**：2026-08-31

---

## 总览

| 层级 | 技术 | 版本 |
|------|------|------|
| **桌面框架** | Tauri | v2 |
| **前端框架** | React | 19 |
| **语言** | TypeScript | 6 |
| **构建工具** | Vite | 8 |
| **样式方案** | TailwindCSS | 4（CSS-first，无配置文件） |
| **富文本编辑器** | TipTap | 3.26 |
| **状态管理** | Zustand + Jotai | 5 / 2.20 |
| **路由** | React Router | v7 |
| **后端语言** | Rust | 2021 Edition |
| **数据库** | SQLite（rusqlite bundled） | WAL 模式 |
| **连接池** | r2d2 | — |
| **Agent 运行时** | Python | ≥ 3.10 |
| **Agent 框架** | FastAPI + LangGraph + LangChain | — |
| **包管理（前端）** | pnpm | ≥ 11 |
| **包管理（Python）** | uv / pip（`pyproject.toml` + `uv.lock`） | — |

---

## 前端依赖

### 核心框架

| 依赖 | 说明 |
|------|------|
| `react` / `react-dom` | UI 框架 |
| `react-router-dom` | SPA 路由（v7，懒加载页面） |
| `@tauri-apps/api` | Tauri 前端核心 API |

### 状态管理

| 依赖 | 说明 |
|------|------|
| `zustand` | 全局业务状态（slice 模式）+ 插件状态 |
| `jotai` | UI 原子状态（21 个 atom） |

### 富文本

| 依赖 | 说明 |
|------|------|
| `@tiptap/react` / `@tiptap/starter-kit` | 编辑器核心与基础扩展 |
| `@tiptap/extension-*` | 表格（4 件套）、图片、颜色、文本样式、下划线、任务列表、字符计数 |
| `@tiptap/extension-code-block-lowlight` | 代码块语法高亮 |
| `lowlight` | 语法高亮引擎（34 种语言） |
| `katex` | LaTeX 数学公式渲染 |

### UI 工具

| 依赖 | 说明 |
|------|------|
| `tailwind-merge` + `clsx` | 类名合并（`cn()` 工具函数） |
| `class-variance-authority` | 组件变体管理 |
| `lucide-react` | 图标库 |
| `react-markdown` + `remark-gfm` | AI 消息的 Markdown 渲染（含 GFM 表格/删除线） |
| `react-diff-viewer-continued` | 版本快照 diff 对比 |
| `@tanstack/react-virtual` | 虚拟化滚动（书库、大纲面板） |
| `@dnd-kit/core` + `@dnd-kit/utilities` | 大纲拖拽排序 |
| `react-image-crop` | 图片裁剪对话框 |

### 工具函数

| 依赖 | 说明 |
|------|------|
| `date-fns` | 日期处理 |

---

## Tauri 插件

| 插件 | 用途 |
|------|------|
| `tauri-plugin-http` | HTTP 请求（AI API 调用） |
| `tauri-plugin-dialog` | 原生文件对话框 |
| `tauri-plugin-fs` | 文件系统访问 |
| `tauri-plugin-shell` | Shell 命令执行 |
| `tauri-plugin-updater` | 应用更新 |
| `tauri-plugin-deep-link` | 深度链接（`com.ukcoder.timewrite://`） |

---

## Rust 依赖

| Crate | 用途 |
|-------|------|
| `tauri` | 应用框架 + 事件推送 |
| `rusqlite`（bundled） | SQLite 数据库 |
| `r2d2` + `r2d2_sqlite` | 连接池（max_size=10） |
| `serde` / `serde_json` | 序列化（统一 camelCase） |
| `reqwest` | HTTP 客户端（stream / rustls-tls / gzip / brotli） |
| `futures-util` | 异步流处理（`StreamExt`） |
| `tokio` | 异步运行时 |
| `uuid` | UUID 生成 |
| `chrono` | 时间处理 |
| `aes-gcm` | AES-256-GCM 备份加密 |
| `tiny_http` | Bridge Server（端口 9876，供 Python 回调） |
| `anyhow` | 错误处理 |

---

## Python 依赖（Agent 服务）

| 依赖 | 用途 |
|------|------|
| `fastapi` | Agent HTTP 服务框架（端口 9877） |
| `uvicorn` | ASGI 服务器（AgentManager 启动时会验证其可用性） |
| `langgraph` | ReAct Agent 执行引擎（`astream_events` v2 事件流） |
| `langchain-core` / `langchain-ollama` / `langchain-openai` | LLM 抽象与工具定义（`@tool` 装饰器） |
| `httpx` | 异步 HTTP 客户端（回调 Rust Bridge） |
| `pydantic` | 请求/响应模型校验 |
| `sqlite3`（标准库） | 记忆体持久化 |

依赖声明见 `agent/pyproject.toml`，锁定于 `agent/uv.lock`，由 `scripts/setup-agent.ts` 自动安装到 `agent/.venv`。

> **注意**：Agent 服务为可选功能。不使用 Agent 自动化时，应用无需 Python 环境即可运行全部其他功能。

---

## 工程化工具

| 工具 | 说明 |
|------|------|
| `scripts/setup-agent.ts` | 创建 `.venv`、安装依赖、下载本地模型 |
| `scripts/check.mjs` | 项目完整性自检 |
| `scripts/check-{npm,python,rust}-versions.ts` | 三端依赖版本校验 |
| `scripts/node-manager.ts` | Node 版本管理 |
| `scripts/clean.ts` | 构建产物清理 |

---

## 相关文档

- [项目结构](development/project-structure)
- [状态管理](development/state-management)
- [Agent 架构](architecture/agent-architecture)
