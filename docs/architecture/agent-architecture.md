# Python Agent 架构

> **适用版本**：`1.0.0`　|　**最后核对**：2026-08-31
>
> Agent 子系统是 v1.0.0 的核心新增特性。面向用户的使用说明见 [Agent 自动化](user-guide/agent-panel)。

---

## 1. 为什么需要独立进程

TimeWrite 的 AI 能力分两条路径：

| 路径 | 定位 | 实现 | 进程 |
|------|------|------|------|
| **AI 助手** | 单轮/多轮对话，RAG 增强 | Rust `commands/ai/` | Rust 主进程 |
| **Agent 自动化** | 自主规划、多步工具调用、长期记忆 | Python + LangGraph | **独立子进程** |

Agent 需要 LangGraph ReAct、LangChain 工具链等 Python 生态能力，无法在 Rust 中低成本实现，故独立为 Python FastAPI 服务。

**核心约束**：Python 进程**不直接访问 SQLite**。所有数据读取通过 Rust 侧的 Bridge HTTP 服务反向回调，保证数据库写操作的唯一入口始终在 Rust，避免多进程并发写 SQLite 的锁竞争与一致性风险。

---

## 2. 三进程架构

```
┌────────────────────────────────────────────────────────────┐
│  进程 1: WebView 前端（React 19）                            │
│  components/agent/：AgentPanel / useAgent / AgentMemoryPanel │
└───────────────────────────┬────────────────────────────────┘
                            │ Tauri IPC (invoke / event)
┌───────────────────────────┴────────────────────────────────┐
│  进程 2: Rust Core（Tauri v2）                               │
│  commands/agent/skills.rs  ← 9 个 Agent IPC 命令            │
│  python/manager.rs  AgentManager（子进程全生命周期）          │
│  python/client.rs   HTTP 客户端（SSE 消费、记忆 CRUD）        │
│  python/bridge.rs   数据桥接 Server（端口 9876）             │
└──────────┬─────────────────────────────────┬───────────────┘
           │ HTTP POST /skills/execute       │ HTTP 回调 /agent/*
           │ (9877)                          │ (9876)
┌──────────┴─────────────────────────────────┴───────────────┐
│  进程 3: Python Agent（FastAPI @ 127.0.0.1:9877）            │
│  server/routes.py → server/sse.py → skills/engine.py        │
│  models/router.py（Ollama 本地 / DeepSeek 云端双模型路由）     │
│  tools/db_tools.py（6 个工具，经 9876 Bridge 回调 Rust）      │
│  memory/（SQLite 三层记忆）                                  │
└─────────────────────────────────────────────────────────────┘
```

**数据流方向**：

```
前端 → IPC → Rust → HTTP 9877 → Python Agent → LangGraph 推理
                                      ↓ 需要数据时
                              HTTP 9876 → Rust Bridge → SQLite
                                      ↓
                              Python 流式输出 SSE
                                      ↓
Rust client.rs 解析 → emit('agent-stream-chunk') → 前端 RAF 缓冲渲染
```

---

## 3. Rust 侧：`src-tauri/src/python/`

### 3.1 模块职责

| 文件 | 职责 |
|------|------|
| `manager.rs` | `AgentManager`：Python 子进程全生命周期管理 |
| `client.rs` | Rust → Python 的 HTTP 客户端（SSE 消费、记忆 CRUD 转发） |
| `bridge.rs` | Python → Rust 的数据桥接 HTTP Server（tiny_http，端口 9876） |

### 3.2 AgentManager 关键能力

**解释器探测 `find_python()`**（按优先级，逐级验证）：

1. 用户指定路径
2. `agent/.venv`（**验证 uvicorn 可用性**）
3. `which python`（**验证 uvicorn 可用性**）
4. 降级为字面量 `"python"`

> 早期版本仅用 `which python` 查找，会在 venv 符号链接场景下误判。v1.0.0 增加了 uvicorn 可用性验证。

**入口定位 `find_agent_entry()`**：

- 开发模式 → 工作目录下的 `agent/`
- 生产模式 → macOS bundle Resources 目录 / flat resources 目录

**端口管理**：

- `wait_for_port_free`：轮询 + 自动 kill 僵尸进程
- `kill_process_on_port`：`lsof` / `netstat` 查 PID，`libc` SIGKILL 进程组 + 主进程双重保障

**优雅关闭**：`SIGTERM` → 等待 10s → `SIGKILL` → 验证端口释放

**看门狗**：`spawn_watchdog()` 每 10s 健康检查，状态机驱动（`Stopped` / `Starting` / `Running` / `Crashed`），崩溃自动重启**最多 3 次**

### 3.3 Bridge Server（端口 9876）

4 个路由，直接调用 `repository/` 层查询 SQLite 返回 JSON：

| 路由 | 用途 | 调用工具 |
|------|------|---------|
| `/agent/read_chapter` | 读取章节完整内容 | `read_chapter`、`read_chapter_summary`、`read_chapter_chunk` |
| `/agent/list_chapters` | 章节列表 | `list_book_chapters` |
| `/agent/search_world_cards` | 世界观搜索 | `search_world_cards` |
| `/agent/book_context` | 整书上下文 | `get_book_context` |

响应格式统一为 `{"data": {...}}` 或 `{"data": null, "error": "..."}`。

> ⚠️ **已知问题**：Bridge 当前无鉴权，任何本机进程均可读取作品数据。详见 [优化报告](meta/optimization-report) 问题 27。

---

## 4. Python 侧：`agent/`

### 4.1 模块地图

```
agent/
├── main.py              # FastAPI 入口：日志初始化、CORS、信号处理、优雅关闭
├── config.py            # AgentConfig 数据类 + SkillType 枚举 + 模型层级映射
├── tracer.py            # 统一埋点：@trace 装饰器、独立 logger
├── pyproject.toml / uv.lock / requirements.txt
├── server/
│   ├── routes.py        # /health、/skills/execute、/memory/* CRUD
│   └── sse.py           # SSE 流式响应生成器
├── skills/
│   ├── engine.py        # LangGraph ReAct Agent 构建与流式执行
│   └── prompts.py       # 4 个核心 Skill Prompt + 动态场景提示
├── models/
│   ├── router.py        # 双模型路由：Ollama 本地 / DeepSeek 云端
│   └── __init__.py      # 仅导出 get_model_for_skill / stream_model
├── tools/
│   └── db_tools.py      # 6 个 LangChain 工具
└── memory/
    ├── store.py         # SQLite 记忆持久化 + 规则式记忆提取
    ├── retriever.py     # 关键词匹配 + 类型加权 + 时间衰减检索
    └── summarizer.py    # 本地模型对话历史压缩
```

### 4.2 Skill 执行引擎 `skills/engine.py`

```
execute_skill_stream(skill, book_id, message, ...)
  ├─ _build_agent()
  │    ├─ get_model_for_skill()              # 按 Skill 选本地/云端模型
  │    ├─ get_dynamic_prompt()               # 核心 Prompt + 关键词匹配场景提示（最多 3 个）
  │    ├─ MemoryRetriever.get_memory_prompt() # 注入相关记忆（≤600 tokens）
  │    ├─ 拼接 System Prompt（KV Cache 友好：前缀结构稳定 + 时间戳 + 摘要段）
  │    └─ 选择性工具集（SKILL_TOOLS_MAP 按 Skill 定制）
  ├─ 历史消息清洗（剥离 reasoning_content，保留 tool_calls/ToolMessage 配对）
  ├─ 历史压缩（前端已传摘要则跳过；否则本地 Ollama 压缩）
  ├─ agent.astream_events()                  # LangGraph v2 事件流
  │    ├─ on_tool_start / on_tool_end        # 工具调用追踪
  │    └─ on_chat_model_stream               # 文本增量 yield（TTFT 监控）
  └─ 异步保存记忆（extract_and_save，不阻塞响应）
```

### 4.3 四个 Skill 与模型/工具映射

| Skill | 标识 | 核心能力 | 模型层级 | 工具集 |
|-------|------|---------|---------|--------|
| 写作辅助 | `writing` | 大纲生成、情节建议、角色对话模拟、冲突设计 | 云端 DeepSeek | summary / chunk / list / search / context |
| 内容分析 | `analysis` | 文风分析、连贯性检查、伏笔追踪、角色弧光、节奏评估 | 云端 DeepSeek | read / chunk / list / search / context |
| 研究辅助 | `research` | 资料检索、世界观一致性校验、设定扩展、关系图谱 | 云端 DeepSeek | summary / list / search / context |
| 润色优化 | `polish` | 语法纠错、文笔润色、风格统一、冗余精简 | **本地 Ollama** | read / chunk / context |

映射定义于 `config.py` 的 `TASK_COMPLEXITY_MAP`。

### 4.4 动态 Prompt 机制

`prompts.py` 采用 **核心 Prompt + 场景提示** 分离，按需组合以节省 Token：

```
核心 Prompt（固定，KV Cache 友好）
   + 用户消息关键词匹配到的场景提示（最多 3 条）
   = 最终 System Prompt
```

例如用户消息包含「大纲」时，`writing` 技能会追加「大纲生成指引」；包含「伏笔」时，`analysis` 技能会追加「伏笔分析指引」。

### 4.5 双模型路由 `models/router.py`

| 模型 | 配置 | 说明 |
|------|------|------|
| 本地 | `ChatOllama(qwen2.5:7b @ 127.0.0.1:11434)` | 懒加载单例，temperature 0.7，num_predict 4096 |
| 云端 | 按请求 `ai_config` 动态创建 | 缓存 key = `(endpoint, model, api_key_hash, thinking_enabled, reasoning_effort)` |

**DeepSeek 适配**：

- `model_kwargs` 注入 `thinking: {type: enabled}` + `reasoning_effort: max`（Agent 工具调用场景推荐）
- 兼容 camelCase（前端）/ snake_case（Python）双格式配置读取
- **API Key 安全**：sha256 哈希做缓存键、首尾去空白、缺失时给出对应服务商的获取指引

### 4.6 工具链 `tools/db_tools.py`

6 个工具全部通过 HTTP 回调 Rust Bridge：

| 工具 | 用途 | Token 优化 |
|------|------|-----------|
| `read_chapter` | 读取完整章节 | — |
| `read_chapter_summary` | 仅摘要 | 摘要优先，无摘要时取前 500 字 |
| `read_chapter_chunk` | 大章节分页读取 | 2000 字/段，返回分段位置与续读提示 |
| `list_book_chapters` | 章节列表 | 仅标题 + 摘要，不含正文 |
| `search_world_cards` | 世界观搜索 | 限 5 条，每条截断 300 字 |
| `get_book_context` | 整书上下文 | 近 5 章摘要 + 世界观概览（每条 200 字） |

**健壮性设计**：

- `ToolCache`：请求级 LRU 缓存（32 条，TTL 300s）
- Bridge 连接错误重试：3 次指数退避（0.5s → 1s → 2s），成功后重建 httpx 连接池
- Bridge 业务错误（404/500）**不重试**，直接报错并输出详细诊断

### 4.7 记忆体系统 `memory/`

三层记忆类型：

| 类型 | 标识 | 含义 | 检索权重 |
|------|------|------|:---:|
| 用户偏好 | `preference` | 风格、语气、格式偏好 | 1.2 |
| 历史决策 | `decision` | 曾做过什么选择、原因 | 1.0 |
| 经验教训 | `lesson` | 什么有效、什么无效 | 0.8 |

**store.py**：SQLite（`agent/data/agent_memory.db`）WAL 模式 + 单例 + 线程锁；`extract_and_save` 基于**规则**从对话中自动提取记忆（关键词触发，不消耗额外 LLM 调用）

**retriever.py**：检索策略 = 关键词交集打分 × 类型加权 × 时间衰减，受 Token 预算（600）约束

```python
score = relevance_score
if 关键词交集 > 0:
    score *= 1.0 + 0.3 * overlap
score *= TYPE_WEIGHT[memory_type]
```

**summarizer.py**：本地 Ollama 压缩对话（> 6 轮触发，保留最近 4 轮），结构化输出（关键决策 / 用户偏好 / 讨论要点 / 已确认设定）。本地模型不可用时自动降级跳过。

### 4.8 追踪系统 `tracer.py`

- 独立 logger `agent.tracer`（`propagate=False`），避免被 uvicorn 覆盖
- `@trace` 装饰器自动记录函数传参/返参/耗时
- `trace_event` 输出带 `[TRACE]` 前缀的结构化事件：`HTTP_REQUEST`、`SSE_PROGRESS`、`AGENT_TOOL_START`、`MEMORY_*`、`BRIDGE_RETRY`、`CACHE_HIT` 等
- `AGENT_TRACE_LEVEL` 环境变量控制级别（DEBUG/INFO/WARN），默认 DEBUG
- API Key 脱敏：仅输出长度与前 6 位

---

## 5. HTTP API

### 5.1 Agent 服务（端口 9877）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查，返回模型配置、记忆条数、压缩开关、最大迭代数 |
| POST | `/skills/execute` | 执行 Skill，返回 `text/event-stream` |
| POST | `/skills/cancel` | 取消任务（**当前为占位实现**） |
| GET | `/memory/list` | 列出记忆（`?book_id=&skill_type=`） |
| PUT | `/memory/{id}` | 更新记忆 |
| DELETE | `/memory/{id}` | 删除单条记忆 |
| DELETE | `/memory/clear` | 清空指定作品的全部记忆 |

> `/memory/clear` 必须定义在 `/memory/{memory_id}` **之前**，否则 FastAPI 会把 `clear` 当作 int 解析。

### 5.2 SSE 事件

| 事件 | 载荷 | 说明 |
|------|------|------|
| `chunk` | 文本增量 | 流式输出 |
| `done` | 完成标记 | 流结束 |
| `cancelled` | — | 任务被取消 |
| `error` | 错误信息 | 执行失败 |

Rust `client.rs` 解析后转发为 Tauri 事件 `agent-stream-chunk`，载荷 `{ event, data, requestId }`。前端按 `requestId` 过滤，使用 `requestAnimationFrame` 合并高频 chunk 后批量更新 UI。

---

## 6. 关键配置

`agent/config.py` 的 `AgentConfig`，全部支持环境变量覆盖：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `host` / `port` | `127.0.0.1` / `9877` | 服务监听 |
| `ollama_base_url` / `local_model_name` | `http://127.0.0.1:11434` / `qwen2.5:7b` | 本地模型 |
| `cloud_api_base` / `cloud_model_name` | `https://api.deepseek.com` / `deepseek-chat` | 云端模型（`ai_config` 请求级配置优先） |
| `cloud_thinking_enabled` / `cloud_reasoning_effort` | `true` / `max` | DeepSeek 思考模式 |
| `max_iterations` | 15 | Agent 最大推理步数 |
| `task_timeout_seconds` | 300 | 单任务超时 |
| `max_context_chars` | 80000 | 上下文最大字符数 |
| `rust_callback_url` | `http://127.0.0.1:9876` | Bridge 地址 |
| `memory_db_path` / `memory_max_tokens` | `data/agent_memory.db` / 600 | 记忆配置 |
| `history_compress_threshold` / `history_keep_recent` | 6 / 4 | 历史压缩阈值 |

---

## 7. 设计亮点

1. **Python 不直接访问 SQLite** —— 通过 9876 Bridge 回调，数据库写操作唯一入口在 Rust，杜绝多进程写锁竞争
2. **子进程全生命周期管理** —— 解释器探测规避 venv 符号链接陷阱、端口僵尸进程组清理、看门狗自动重启（3 次上限）、优雅关闭（SIGTERM → 10s → SIGKILL）
3. **双模型路由按任务复杂度分配** —— 润色走本地 Ollama 省成本，写作/分析/研究走云端 DeepSeek
4. **KV Cache 友好 Prompt** —— 前缀结构稳定，提升 DeepSeek 缓存命中率，降低成本与延迟
5. **按 Skill 定制工具集** —— 只加载必要工具，减少 Prompt 体积与误调用
6. **请求级工具缓存** —— LRU + TTL，避免同一数据被重复请求
7. **记忆提取零 LLM 成本** —— 基于规则自动提取，不额外调用模型
8. **前端 RAF 缓冲** —— 按帧合并高频 SSE chunk，避免大量重渲染

---

## 8. 相关文档

- [Agent 自动化使用指南](user-guide/agent-panel) — 面向用户
- [AI 模块架构](architecture/AI-architecture) — Rust 侧 AI 对话（非 Agent）
- [IPC 命令速查](development/ipc-api) — 9 个 Agent IPC 命令
- [优化报告](meta/optimization-report) — Agent 相关待优化项（问题 27-31）
