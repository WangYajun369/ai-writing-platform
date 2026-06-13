# MirageInk 调试指南

> 本文档涵盖 MirageInk（TimeWrite/智写时光）全栈项目的调试方法，包括 **Rust (Tauri)**、**Python (Agent Server)**、**TypeScript (React 前端 + 脚本)** 三大技术栈。

---

## 目录

- [1. 项目架构概览](#1-项目架构概览)
- [2. 前置环境](#2-前置环境)
- [3. VS Code 调试配置](#3-vs-code-调试配置)
  - [3.1 Rust：LLDB 调试 Tauri 桌面应用](#31-rustlldb-调试-tauri-桌面应用)
  - [3.2 Python：调试 Agent Server](#32-python调试-agent-server)
  - [3.3 TypeScript：调试 React 前端](#33-typescript调试-react-前端)
  - [3.4 TypeScript：调试项目脚本](#34-typescript调试项目脚本)
- [4. 日志与埋点系统](#4-日志与埋点系统)
  - [4.1 Rust 日志](#41-rust-日志)
  - [4.2 Python 日志 (tracer)](#42-python-日志-tracer)
  - [4.3 前端日志](#43-前端日志)
- [5. 实战调试示例](#5-实战调试示例)
  - [5.1 调试 Rust Core 子进程管理](#51-调试-rust-core-子进程管理)
  - [5.2 调试 Agent 技能执行链路](#52-调试-agent-技能执行链路)
  - [5.3 调试 SSE 流式响应](#53-调试-sse-流式响应)
  - [5.4 调试 React 组件状态](#54-调试-react-组件状态)
  - [5.5 调试数据持久化 (SQLite)](#55-调试数据持久化-sqlite)
- [6. 环境变量速查](#6-环境变量速查)
- [7. 常见问题排查](#7-常见问题排查)

---

## 1. 项目架构概览

```
┌─────────────────────────────────────────────────┐
│                Tauri 桌面壳 (Rust)               │
│  src-tauri/  ← LLDB 调试                        │
│  ├── Core: 子进程管理、文件系统、回调           │
│  └── WebView ← 内嵌前端                         │
├─────────────────────────────────────────────────┤
│              React 前端 (TypeScript)             │
│  src/  ← Chrome DevTools 调试                   │
│  Vite 开发服务器 :1420                           │
├─────────────────────────────────────────────────┤
│        Agent Server (Python / FastAPI)           │
│  agent/  ← debugpy 调试                         │
│  uvicorn :9877                                   │
│  ├── /health                健康检查             │
│  ├── /skills/execute        技能执行 (SSE)      │
│  └── /memory/*              记忆体 CRUD         │
├─────────────────────────────────────────────────┤
│  scripts/  ← npx tsx 调试                       │
│  setup-agent.ts / clean.ts / check-*.ts         │
└─────────────────────────────────────────────────┘
```

**关键通信链路**：

```
Rust Core ──子进程──→ Python Agent (:9877) ──SSE──→ Rust Core (:9876 回调)
     │                                                    │
     │                                                    ▼
     └────────────── WebView ←── state ──── React 前端
```

---

## 2. 前置环境

| 技术栈 | 运行时 | 调试器 | VS Code 扩展 |
|--------|--------|--------|-------------|
| Rust | Cargo + rustc | LLDB | `CodeLLDB` (`vadimcn.vscode-lldb`) |
| Python | `agent/.venv/bin/python` (uv 管理) | debugpy | `Python Debugger` (`ms-python.debugpy`) |
| TypeScript | Node ≥22 + pnpm 11 | Node Inspector | 内置 (需 `js-debug-nightly` 或最新 VS Code) |
| React 前端 | Chrome / Edge | Chrome DevTools | 内置 (`ms-vscode.js-debug`) |

**确认扩展已安装**：

```bash
code --list-extensions | grep -E "lldb|debugpy"
```

---

## 3. VS Code 调试配置

所有配置定义在 `.vscode/launch.json`，共 7 个预设。

### 3.1 Rust：LLDB 调试 Tauri 桌面应用

**配置名**：`🦀 调试 Tauri (LLDB Launch)`

**工作原理**：
1. Cargo 编译 `src-tauri/` 项目
2. LLDB 启动编译产物 `target/debug/time-write`
3. 自动加载 Rust 标准库源码映射

```jsonc
{
  "type": "lldb",
  "request": "launch",
  "name": "🦀 调试 Tauri (LLDB Launch)",
  "cargo": {
    "args": [
      "build",
      "--manifest-path",
      "${workspaceFolder}/src-tauri/Cargo.toml",
      "--no-default-features"
    ]
  },
  "program": "${workspaceFolder}/src-tauri/target/debug/time-write",
  "args": [],
  "cwd": "${workspaceFolder}",
  "sourceMap": {
    "/rustc/<hash>": "${env:HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/src/rust"
  }
}
```

**使用步骤**：

1. 在 `src-tauri/src/` 下任意 `.rs` 文件中设置断点（点击行号左侧）
2. 按 `F5` 或从"运行和调试"面板选择 `🦀 调试 Tauri (LLDB Launch)`
3. 等待编译完成，应用自动启动
4. 断点命中时，可查看变量、调用栈、执行单步调试

**示例断点位置**：

```rust
// src-tauri/src/manager.rs — 子进程启动
pub fn start_agent(&self) -> Result<Child, anyhow::Error> {
    // ← 在此设置断点，观察 Python 解释器查找过程
    let python = which_python()?;
    let mut cmd = Command::new(&python);
    // ...
}
```

**注意**：
- 首次编译较慢，后续增量编译很快
- LLDB 在 macOS 上原生支持，无需额外配置
- Rust 标准库源码路径随工具链版本变化，`<hash>` 为通配符

---

### 3.2 Python：调试 Agent Server

提供两种启动方式，推荐第一种。

#### 配置 A：`🐍 调试 Agent (python -m agent.main)` （推荐）

直接以模块方式启动，等价于命令行 `python -m agent.main`。

```jsonc
{
  "type": "debugpy",
  "request": "launch",
  "name": "🐍 调试 Agent (python -m agent.main)",
  "module": "agent.main",
  "python": "${workspaceFolder}/agent/.venv/bin/python",
  "cwd": "${workspaceFolder}",
  "console": "integratedTerminal",
  "env": {
    "PYTHONPATH": "${workspaceFolder}"
  }
}
```

#### 配置 B：`🐍 调试 Agent (uvicorn 启动)`

通过 uvicorn 直接启动，带 `--reload` 热重载（修改代码自动重启，需 `watchfiles` 包）。

```jsonc
{
  "type": "debugpy",
  "request": "launch",
  "name": "🐍 调试 Agent (uvicorn 启动)",
  "module": "uvicorn",
  "python": "${workspaceFolder}/agent/.venv/bin/python",
  "args": [
    "agent.main:app",
    "--host", "127.0.0.1",
    "--port", "9877",
    "--reload"
  ],
  "cwd": "${workspaceFolder}",
  "console": "integratedTerminal",
  "env": {
    "PYTHONPATH": "${workspaceFolder}"
  }
}
```

**使用步骤**：

1. 在 `agent/` 下任意 `.py` 文件中设置断点
2. 选择对应配置，按 `F5` 启动
3. 服务启动后，用 curl 或前端触发请求即可命中断点

**示例断点位置**：

```python
# agent/server/routes.py — API 路由入口
@router.post("/skills/execute")
async def execute_skill(request: SkillRequest):
    # ← 在此设置断点，观察请求参数
    skill_type = request.skill_type
    ...

# agent/skills/engine.py — Agent 执行引擎
async def execute(self, skill_type: SkillType, ...):
    # ← 在此设置断点，追踪 LangGraph 执行流程
    ...
```

**通过 curl 触发调试**：

```bash
# 健康检查
curl http://127.0.0.1:9877/health

# 执行技能（需传入书籍 ID 模式）
curl -X POST http://127.0.0.1:9877/skills/execute \
  -H "Content-Type: application/json" \
  -d '{"skill_type":"writing","book_id":"test-001","user_input":"写一个武侠小说开篇大纲"}'
```

**环境变量控制**（在 `env` 字段中添加）：

```jsonc
"env": {
  "PYTHONPATH": "${workspaceFolder}",
  "AGENT_TRACE_LEVEL": "DEBUG",    // 全量日志
  "AGENT_PORT": "9878",            // 更换端口
  "CLOUD_API_KEY": "sk-xxx"       // 云端 API Key
}
```

---

### 3.3 TypeScript：调试 React 前端

**配置名**：`🟦 调试前端 (Chrome)`

```jsonc
{
  "type": "chrome",
  "request": "launch",
  "name": "🟦 调试前端 (Chrome)",
  "url": "http://localhost:1420",
  "webRoot": "${workspaceFolder}/src",
  "sourceMapPathOverrides": {
    "webpack:///./src/*": "${webRoot}/*"
  }
}
```

**使用步骤**：

1. **先启动 Vite 开发服务器**（在终端执行）：
   ```bash
   pnpm dev
   # Vite 启动在 http://localhost:1420
   ```

2. 在 `src/` 下任意 `.tsx`/`.ts` 文件中设置断点

3. 选择 `🟦 调试前端 (Chrome)`，按 `F5`

4. Chrome 自动打开 `http://localhost:1420`，操作页面即可命中断点

**示例断点位置**：

```tsx
// src/components/Editor.tsx — 编辑器组件
const handleSave = async () => {
  // ← 在此设置断点，观察保存时的数据状态
  const content = editor?.getHTML();
  await saveBook(bookId, content);
};

// src/stores/bookStore.ts — Zustand 状态管理
export const useBookStore = create<BookState>((set, get) => ({
  books: [],
  loadBooks: async () => {
    // ← 在此设置断点，追踪数据加载
    const data = await invoke('get_books');
    set({ books: data });
  },
}));
```

**注意**：
- 必须先启动 `pnpm dev`，再启动调试配置
- 跨域和 CORS 问题不会出现（Vite 代理已配置）
- Tauri 环境下，前端运行在 WebView 而非 Chrome，调试需用 Tauri DevTools

---

### 3.4 TypeScript：调试项目脚本

项目包含多个工具脚本，通过 `npx tsx` 运行。

#### 通用脚本调试：`🟦 调试 TS 脚本 (npx tsx)`

打开任意 `.ts` 脚本文件，设置断点后启动此配置，自动以 `${file}` 作为目标：

```jsonc
{
  "type": "node",
  "request": "launch",
  "name": "🟦 调试 TS 脚本 (npx tsx)",
  "runtimeExecutable": "npx",
  "runtimeArgs": ["tsx"],
  "args": ["${file}"],
  "cwd": "${workspaceFolder}",
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```

#### setup-agent 专用：`🟦 调试 setup-agent (完整安装)`

```jsonc
{
  "type": "node",
  "request": "launch",
  "name": "🟦 调试 setup-agent (完整安装)",
  "runtimeExecutable": "npx",
  "runtimeArgs": ["tsx"],
  "args": ["scripts/setup-agent.ts"],
  "cwd": "${workspaceFolder}",
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```

#### setup-agent 专用：`🟦 调试 setup-agent (仅检查)`

```jsonc
{
  "type": "node",
  "request": "launch",
  "name": "🟦 调试 setup-agent (仅检查)",
  "runtimeExecutable": "npx",
  "runtimeArgs": ["tsx"],
  "args": ["scripts/setup-agent.ts", "--check"],
  "cwd": "${workspaceFolder}",
  "console": "integratedTerminal",
  "skipFiles": ["<node_internals>/**"]
}
```

**全部可调试的脚本**：

| 脚本 | 命令 | 说明 |
|------|------|------|
| `scripts/setup-agent.ts` | `--check` / `--dev` / `--download-models` | Agent 环境安装 |
| `scripts/clean.ts` | `--all` | 清理构建产物 |
| `scripts/check-npm-versions.ts` | — | 检查 npm 依赖版本 |
| `scripts/check-python-versions.ts` | — | 检查 Python 依赖版本 |
| `scripts/check-rust-versions.ts` | — | 检查 Rust 依赖版本 |
| `scripts/node-manager.ts` | — | Node.js 运行时管理 |

---

## 4. 日志与埋点系统

### 4.1 Rust 日志

Rust Core 使用标准输出 (`println!` / `eprintln!`) 和 `tracing` 宏。Tauri 应用运行时日志输出到终端（通过 `Stdio::inherit()` 配置）。

### 4.2 Python 日志 (tracer)

Agent Server 内置了完整的埋点系统 (`agent/tracer.py`)，提供装饰器和工具函数。

**控制级别**：

```bash
# 全量调试日志（默认）
AGENT_TRACE_LEVEL=DEBUG python -m agent.main

# 仅关键信息
AGENT_TRACE_LEVEL=INFO python -m agent.main

# 仅异常
AGENT_TRACE_LEVEL=WARN python -m agent.main
```

在 VS Code launch.json 中设置：

```jsonc
"env": {
  "AGENT_TRACE_LEVEL": "DEBUG"
}
```

**三种使用方式**：

1. **装饰器** — 追踪函数调用、参数、返回值、耗时：
   ```python
   from agent.tracer import trace

   @trace
   async def execute_skill(skill_type, book_id, user_input):
       # 自动记录：▶ execute_skill(skill_type=writing, book_id=xxx, ...)
       #            ◀ execute_skill → {...} [123.4ms]
       return result
   ```

2. **基类继承** — 自动追踪所有 public 方法：
   ```python
   from agent.tracer import Traced

   class MyService(Traced):
       def do_work(self, data):     # 自动追踪
           return process(data)

       def _internal(self):         # 以 _ 开头，不追踪
           pass
   ```

3. **请求级上下文追踪** — 整个请求链路带唯一 ID：
   ```python
   from agent.tracer import start_request, end_request, trace_event

   rid = start_request(skill="writing", book_id="abc123")
   # 日志: ╔══ REQUEST START [a1b2c3d4] skill=writing book=abc123 ══╗

   trace_event("调用模型", f"model={model_name}")
   # 日志: [a1b2c3d4] ● 调用模型 — model=deepseek-chat

   end_request()
   # 日志: ╚══ REQUEST END [a1b2c3d4] total=1523ms ══╝
   ```

**日志输出示例**：

```
20:05:01 [TRACE] ╔══ REQUEST START [f7e3a1b2] skill=analysis book=novel-042 ══╗
20:05:01 [TRACE] ▶ engine.execute(skill_type=analysis, book_id=novel-042, user_input=分析第3章伏笔...)
20:05:01 [TRACE] [f7e3a1b2] ● 选择模型 — tier=cloud, model=deepseek-chat
20:05:02 [TRACE] ▶ router.get_model(tier=cloud, thinking=True, effort=max)
20:05:02 [TRACE] ◀ router.get_model → ChatDeepSeek(model=deepseek-chat) [12.3ms]
20:05:02 [TRACE] [f7e3a1b2] ● Agent 开始推理 — max_iterations=15
20:05:05 [TRACE] [f7e3a1b2] ● 工具调用 — tool=read_chapter, args=chapter_id=3
20:05:05 [TRACE] ▶ db_tools.read_chapter(chapter_id=3)
20:05:05 [TRACE] ◀ db_tools.read_chapter → Chapter(id=3, title=暗流涌动...) [8.1ms]
20:05:15 [TRACE] ◀ engine.execute → analysis_result [10234.5ms]
20:05:15 [TRACE] ╚══ REQUEST END [f7e3a1b2] total=14001ms ══╝
```

**日志过滤技巧**：

```bash
# 只看请求边界
python -m agent.main 2>&1 | grep "REQUEST"

# 只看函数调用
python -m agent.main 2>&1 | grep "▶\|◀"

# 只看特定 request_id 的链路
python -m agent.main 2>&1 | grep "f7e3a1b2"

# 排除 trace 日志只看业务输出
python -m agent.main 2>&1 | grep -v "TRACE"
```

### 4.3 前端日志

React 前端使用 `console.log` / `console.error`。
在 Chrome DevTools 的 Console 面板查看，支持日志过滤和级别筛选。

---

## 5. 实战调试示例

### 5.1 调试 Rust Core 子进程管理

**场景**：Agent Server 启动失败，需要排查 Python 解释器查找和 uvicorn 可用性。

**步骤**：

1. 打开 `src-tauri/src/manager.rs`
2. 在 `start_agent` 方法的 `which_python()` 调用处设置断点：
   ```rust
   pub fn start_agent(&self) -> Result<Child, anyhow::Error> {
       let python = which_python()?;  // ← 断点
       let mut cmd = Command::new(&python);
       cmd.args(["-m", "agent.main"]);
       // 检查 cmd 的输出配置
       cmd.stdout(Stdio::inherit());
       cmd.stderr(Stdio::inherit());
       let child = cmd.spawn()?;      // ← 断点
       Ok(child)
   }
   ```
3. 按 `F5` 启动 LLDB 调试
4. 第一个断点：检查 `python` 变量值（应为 `agent/.venv/bin/python`）
5. 按 `F10` 单步执行，到 `cmd.spawn()` 前检查完整命令
6. `F5` 继续，观察子进程是否正常启动

### 5.2 调试 Agent 技能执行链路

**场景**：用户点击"写作辅助"后超时，需要追踪完整链路。

**步骤**：

1. 启动 Python 调试（推荐 `🐍 调试 Agent (python -m agent.main)`）
2. 设置断点：
   - `agent/server/routes.py` 的 `execute_skill` 函数（入口）
   - `agent/skills/engine.py` 的 `execute` 方法（执行体）
   - `agent/models/router.py` 的 `get_model_for_skill`（模型选择）
3. 用 curl 触发请求：
   ```bash
   curl -X POST http://127.0.0.1:9877/skills/execute \
     -H "Content-Type: application/json" \
     -d '{"skill_type":"writing","book_id":"test-001","user_input":"写大纲"}'
   ```
4. 按 `F10` 逐过程，`F11` 逐语句追踪：
   - 观察 `SkillRequest` 参数解析
   - 追踪 `TASK_COMPLEXITY_MAP` 匹配 → 选择云端模型
   - 进入 LangGraph ReAct Agent 构建
   - 观察工具调用和 LLM 返回

5. 在 `VARIABLES` 面板可展开查看：
   - `request.skill_type` → `"writing"`
   - `config.cloud_model_name` → `"deepseek-chat"`
   - Agent 状态图节点

### 5.3 调试 SSE 流式响应

**场景**：前端收到的 SSE 流不完整或格式错误。

**步骤**：

1. 断点设在 `agent/server/sse.py`：
   ```python
   async def sse_generator(agent, skill_type, book_id, user_input):
       # ← 断点：观察生成器启动
       async for event in agent.stream(...):
           # ← 断点：观察每个 SSE 事件
           yield f"data: {json.dumps(event)}\n\n"
       yield "data: [DONE]\n\n"  # ← 断点：确认结束标记
   ```

2. 在 `Watch` 面板添加监视表达式：
   - `event["type"]` → 事件类型
   - `len(json.dumps(event))` → 单事件大小

3. 前端断点辅助检查（见 5.4）

### 5.4 调试 React 组件状态

**场景**：编辑器保存后 UI 未更新，需要检查状态流转。

**步骤**：

1. 终端执行 `pnpm dev` 启动 Vite
2. 在 VS Code 设置断点，然后启动 `🟦 调试前端 (Chrome)`
3. 在 Chrome 中进行操作触发断点
4. 使用 Chrome DevTools：
   - **Sources** 面板：查看断点、调用栈
   - **Console** 面板：执行 `$0` 查看选中元素
   - **React DevTools**（需安装扩展）：查看组件树和 Props/State

5. 常用断点位置示例：

   ```tsx
   // src/stores/bookStore.ts
   const useBookStore = create<BookState>((set, get) => ({
     saveBook: async (id, content) => {
       debugger;  // ← 硬断点，代码中直接打断
       await invoke('save_book', { id, content });
       set(state => ({
         books: state.books.map(b =>
           b.id === id ? { ...b, content, updatedAt: Date.now() } : b
         )
       }));
     },
   }));
   ```

### 5.5 调试数据持久化 (SQLite)

**场景**：数据库读写异常，需要检查 SQL 执行和返回。

**Rust 端（SQLite → Tauri Command）**：

```rust
// src-tauri/src/db.rs
#[tauri::command]
async fn get_book(book_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    let db = state.db.lock().unwrap();  // ← 断点
    let book = db.query_row(
        "SELECT * FROM books WHERE id = ?1",  // ← 检查 SQL
        [&book_id],
        |row| Ok(Book { /* ... */ })
    ).map_err(|e| e.to_string())?;  // ← 检查错误
    Ok(book)
}
```

**Python 端（Agent 记忆体 SQLite）**：

```python
# agent/memory/store.py
def get_memories(self, book_id: str, skill_type: str | None = None):
    # ← 断点：检查查询参数
    conn = sqlite3.connect(self.db_path)
    cursor = conn.execute(
        "SELECT * FROM memories WHERE book_id = ? AND skill_type = ?",
        (book_id, skill_type)
    )
    rows = cursor.fetchall()  # ← 断点：检查返回行数
    return [self._row_to_memory(r) for r in rows]
```

---

## 6. 环境变量速查

| 变量 | 默认值 | 说明 | 影响范围 |
|------|--------|------|----------|
| `AGENT_HOST` | `127.0.0.1` | Agent 绑定地址 | Python |
| `AGENT_PORT` | `9877` | Agent 端口 | Python / Rust |
| `AGENT_TRACE_LEVEL` | `DEBUG` | 日志级别：DEBUG/INFO/WARN | Python |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama 地址 | Python |
| `LOCAL_MODEL_NAME` | `qwen2.5:7b` | 本地模型名 | Python |
| `CLOUD_API_BASE` | `https://api.deepseek.com` | 云端 API 端点 | Python |
| `CLOUD_API_KEY` | — | 云端 API Key | Python |
| `CLOUD_MODEL_NAME` | `deepseek-chat` | 云端模型名 | Python |
| `CLOUD_THINKING_ENABLED` | `true` | DeepSeek 思考模式 | Python |
| `CLOUD_REASONING_EFFORT` | `max` | 推理深度：high/max | Python |
| `MEMORY_DB_PATH` | `data/agent_memory.db` | 记忆体数据库路径 | Python |
| `RUST_CALLBACK_URL` | `http://127.0.0.1:9876` | Rust 回调地址 | Python |
| `TAURI_DEV_HOST` | — | 外部设备访问 Vite | TypeScript |
| `TAURI_ENV_DEBUG` | — | Tauri 调试模式 | TypeScript |

---

## 7. 常见问题排查

### Q1：Python Agent 启动后立即退出

**排查**：
```bash
# 直接在终端启动，查看完整错误
cd /path/to/MirageInk
agent/.venv/bin/python -m agent.main
```

常见原因：
- 缺少依赖 → `cd agent && uv sync`
- Python 版本不对 → 检查 `agent/.python-version`（需 ≥3.14）
- 端口被占用 → `lsof -i :9877` 查看占用进程

### Q2：LLDB 断点不命中

**排查**：
- 确认使用 debug 构建（`--no-default-features` 不带 `--release`）
- 检查 `sourceMap` 路径是否正确（不同 Rust 版本 `<hash>` 不同）
- 尝试在 `main.rs` 入口处设断点验证

### Q3：前端调试时 Source Map 不生效

**排查**：
- 确认 Vite 开发服务器在运行（`pnpm dev`）
- 检查 `webRoot` 指向 `${workspaceFolder}/src`
- 在 Chrome DevTools Sources 面板查看文件是否加载

### Q4：Python 断点灰色（未绑定）

**排查**：
- 确认 debugpy 扩展已安装
- 确认 `python` 路径指向正确的解释器
- 检查 `PYTHONPATH` 环境变量，确保 `from agent.xxx` 导入能解析

### Q5：多进程/线程调试

**场景**：Agent 使用 `asyncio`，调试时可能跳入异步库内部。

**解决**：在 `skipFiles` 中排除标准库和第三方包：
```jsonc
"justMyCode": true   // 仅调试用户代码
```

### Q6：Agent 和 Tauri 同时调试

需要分别启动两个调试会话：
1. 先启动 `🐍 调试 Agent (python -m agent.main)` — Agent 就绪
2. 再启动 `🦀 调试 Tauri (LLDB Launch)` — Rust Core 连接 Agent

VS Code 支持多会话并行调试，在"调用堆栈"面板可切换。

---

## 附录：推荐 VS Code 设置

在 `.vscode/settings.json` 中添加：

```jsonc
{
  // 调试通用
  "debug.toolBarLocation": "docked",      // 调试工具栏停靠
  "debug.console.fontSize": 13,
  "debug.inlineValues": "on",             // 行内显示变量值

  // Rust
  "rust-analyzer.debug.engine": "lldb",
  "rust-analyzer.cargo.buildScripts.enable": true,

  // Python
  "python.defaultInterpreterPath": "${workspaceFolder}/agent/.venv/bin/python",
  "[python]": {
    "editor.defaultFormatter": "charliermarsh.ruff"
  },

  // TypeScript
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true
}
```
