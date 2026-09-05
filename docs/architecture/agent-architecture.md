# Agent 引擎架构（Rust 原生）

> **适用版本**：`1.7.0`　|　**最后核对**：2026-09-05
>
> Agent 自动化引擎已整体内嵌于 Rust（`src-tauri/src/commands/agent/`），**无外部进程、无需 Python 环境**。
> 历史：v1.0 曾以 Python FastAPI + LangGraph 子进程实现（端口 9877），v1.1 迁移为 Rust 原生引擎，`agent/`、`src-tauri/src/python/` 已删除。

---

## 1. 定位与架构

TimeWrite 的 AI 能力分两条路径：

| 路径 | 定位 | 实现 | 进程 |
|------|------|------|------|
| **AI 助手** | 单轮/多轮对话，RAG 增强 | Rust `commands/ai/` | Rust 主进程 |
| **Agent 自动化** | 自主规划、多步工具调用、长期记忆 | Rust `commands/agent/` | Rust 主进程（内嵌） |

Agent 引擎与主进程**同进程运行**：Skill Prompt 组装 → 云端模型 ReAct 推理 → 工具调用直接经 repository 层读写 SQLite，全程无 HTTP 回调、无端口、无子进程生命周期管理。**数据库写操作的唯一入口始终在 Rust**，单进程模型天然规避多进程并发写锁。

```
┌────────────────────────────────────────────────────────────┐
│  WebView 前端（React 19）                                    │
│  components/agent/：useAgent / AgentMemoryPanel /          │
│    AgentMessageBubble / types                               │
└───────────────────────────┬────────────────────────────────┘
                            │ Tauri IPC（invoke / event）
┌───────────────────────────┴────────────────────────────────┐
│  Rust Core（Tauri v2）—— Agent 引擎 commands/agent/         │
│  skills.rs  IPC 命令层（execute/cancel + 记忆 CRUD）         │
│  engine.rs  SSE 流式 ReAct 循环 + 任务取消                    │
│  prompts.rs 4 技能 Prompt + 动态场景提示                     │
│  tools.rs   6 个数据库工具（schema + 执行）                  │
│  memory.rs  memories 表存取 + 规则提取 + 检索                 │
│     │                                                        │
│     ├── repository/（chapter / world_card / book 仓库）      │
│     └── SQLite（time_write.db，含 memories 表）              │
└─────────────────────────────────────────────────────────────┘
```

**数据流方向**：

```
前端 useAgent.executeSkill()
  → invoke('execute_agent_skill', { skill, bookId, message, aiConfig, requestId, ... })
  → skills.rs → engine.rs（ReAct 循环）
       ├─ prompts.rs 组装 System Prompt（基础 + 场景提示 + 记忆段）
       ├─ reqwest POST {endpoint}/chat/completions（OpenAI 兼容 SSE，默认 DeepSeek）
       ├─ 模型返回 tool_calls → tools.rs execute_tool → repository → SQLite
       └─ 流式增量 → emit('agent-stream-chunk', { event, data, requestId })
  → 前端 listen() 按 requestId 过滤 → RAF 缓冲 → 更新消息 UI
  → 结束后异步 memory::extract_and_save 沉淀记忆
```

---

## 2. 模块职责（`src-tauri/src/commands/agent/`）

| 文件 | 职责 |
|------|------|
| `mod.rs` | 模块声明：engine / memory / prompts / skills / tools |
| `skills.rs` | **IPC 命令层**：`execute_agent_skill`（流式执行）、`cancel_agent_skill`、记忆管理命令；参数类型 `AiConfigParams`（camelCase）→ `engine::AiModelConfig` |
| `engine.rs` | **引擎核心**：`run_skill()` SSE 流式 ReAct 循环（工具调用 + 文本增量）、`CancelToken` 即时任务取消（`cancel_current_task()`） |
| `prompts.rs` | 4 个技能 System Prompt（`skill_base_prompt`）、动态场景提示（`get_dynamic_prompt`）、Token 估算 |
| `tools.rs` | 6 个数据库工具：按技能返回工具集（`tools_for_skill`）、构建 function-calling schema、`execute_tool` 分发执行 |
| `memory.rs` | `memories` 表 CRUD、规则式记忆提取（`extract_and_save`）、关键词检索（`retrieve_memories`，命中打点 `last_hit_at`）、容量/过期清理（`prune_memories` / `prune_all_memories`）、旧库迁移（`migrate_legacy_db`） |

### IPC 命令清单（skills.rs）

| 命令 | 说明 |
|------|------|
| `execute_agent_skill` | 执行技能（参数：skill / bookId / message / conversationHistory / aiConfig / requestId / conversationSummary） |
| `cancel_agent_skill` | 取消当前任务 |
| `list_agent_memories` | 记忆列表（bookId 必选，可按 skillType 过滤） |
| `update_agent_memory` | 更新记忆内容/关键词/类型 |
| `delete_agent_memory` | 删除单条记忆 |
| `clear_agent_memories` | 清空某书全部记忆 |

> v1.1 起原 `get_agent_status` / `start_agent` / `stop_agent`（启停外部 Python 进程）已随迁移移除；
> Agent 常驻 Rust 主进程，无启停状态机。

---

## 3. 引擎核心（engine.rs）

### 3.1 run_skill 参数

| 参数 | 说明 |
|------|------|
| `skill` | `writing` / `analysis` / `research` / `polish` |
| `book_id` / `message` | 目标作品与用户消息 |
| `conversation_history` | 最近对话（最多 10 条 / 2000 字符，见下） |
| `conversation_summary` | 已压缩的历史摘要（可选） |
| `ai_config` | 模型配置（provider/endpoint/model/apiKey/thinking 等）；缺省默认 DeepSeek（`https://api.deepseek.com` + `deepseek-chat`） |
| `request_id` | 前端生成的请求 ID（事件路由用） |

**上下文裁剪常量**：`MAX_HISTORY_ITEMS=10`、`MAX_HISTORY_CHARS=2000`、`MAX_TOOL_RESULT_CHARS=30000`、`MAX_ITERATIONS=15`。

### 3.2 ReAct 循环流程

```
run_skill()
  ├─ register_cancel_token()（全局取消令牌：标志 + Notify）
  ├─ 组装 System Prompt
  │    ├─ skill_base_prompt(skill)          # 技能核心指令
  │    ├─ get_dynamic_prompt(skill, msg)    # 关键词匹配场景提示（≤3 条）
  │    └─ memory_prompt(book, skill, msg)   # 注入相关记忆段（≤600 tokens）
  ├─ 清理历史消息（剥离 reasoning_content）
  ├─ react_loop()
  │    ├─ POST /chat/completions（tools = build_tools_schema(skill)）
  │    ├─ 解析 SSE data 行（文本增量 → emit chunk；tool_calls → 提取参数）
  │    ├─ 有工具调用 → tools::execute_tool() → 追加 tool 消息 → 继续循环（≤15 轮）
  │    └─ 无工具调用 → 文本流结束
  ├─ emit('agent-stream-chunk', { event: 'done', ... })
  └─ 异步 extract_and_save()（记忆沉淀，不阻塞响应）
```

**流式事件协议**（`agent-stream-chunk`，负载 `AgentStreamEvent { event, data, requestId }`）：

| `event` | 含义 |
|---------|------|
| `chunk` | 文本增量（data 为增量字符串） |
| `done` | 任务完成 |
| `error` | 执行失败（data 为错误信息） |
| `cancelled` | 用户取消 |

**超时与取消**：SSE 单行读取超时 60s、总超时 600s。取消采用 `CancelToken`（原子标志 + `tokio::Notify`）：`cancel_current_task()` 置位并 `notify_waiters()`，引擎在 SSE 流读取与 HTTP 发送两个阻塞点通过 `tokio::select!` 与取消通知竞争——**即时中断**，无需等待 60s 行超时或下一个 chunk；被放弃的流读取随即 drop、底层连接关闭，服务端感知后停止生成，任务以 `cancelled` 事件收尾（取消路径不再补发 `done`）。

---

## 4. 记忆系统（memory.rs）

记忆持久化于主数据库 `time_write.db` 的 `memories` 表（v1.1 起由 Python 期独立 `agent_memory.db` 迁入）：

```sql
CREATE TABLE memories (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id          TEXT NOT NULL,
    skill_type       TEXT NOT NULL,      -- writing / analysis / research / polish
    memory_type      TEXT NOT NULL,      -- preference / decision / lesson
    content          TEXT NOT NULL,
    keywords         TEXT NOT NULL DEFAULT '',
    relevance_score  REAL NOT NULL DEFAULT 1.0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_hit_at      TEXT                -- 最近一次检索命中注入时间（NULL = 从未命中）
);
-- 索引：idx_memories_book_skill (book_id, skill_type) / idx_memories_type (memory_type)
```

### 4.1 三种记忆类型

| 类型 | 标识 | 含义 | 检索权重 |
|------|------|------|:---:|
| 用户偏好 | `preference` | 风格、语气、格式偏好 | 1.2 |
| 历史决策 | `decision` | 曾做过什么选择、原因 | 1.0 |
| 经验教训 | `lesson` | 什么有效、什么无效 | 0.8 |

### 4.2 规则式提取（零 LLM 成本）

`extract_and_save` 基于**关键词规则**在对话结束后自动提取，不消耗额外模型调用：

- 用户侧消息含「喜欢 / 偏好 / 习惯 / 希望…」→ `preference`
- 用户侧消息含「决定 / 选择 / 采用 / 打算…」→ `decision`
- 助手侧消息含「建议 / 注意 / 教训 / 提醒…」→ `lesson`
- 每条记忆截取最多 3 句；`extract_keywords` 用去停用词后的高频词生成 `keywords`

### 4.3 检索策略

`retrieve_memories(conn, book_id, skill_type, user_message, max_tokens, top_k)`：

1. **候选集**：先取「本书 + 本技能」精确匹配（≤50 条）；不足时回退整本书（≤30 条）
2. **打分**：关键词交集越多分越高（`score *= 1 + 0.3 × overlap`），再乘类型权重
3. **裁剪**：按 Token 预算（默认 600，`DEFAULT_MAX_TOKENS`）截取，`top_k = 10`

`memory_prompt(...)` 将检索结果格式化为可注入 System Prompt 的记忆段；命中为空则省略该段。

### 4.4 旧库自动迁移

`lib.rs` setup 阶段检测旧 Python 期 `agent_memory.db`（开发模式 `<cwd>/data/`、打包模式 `<app_data_dir>/`），存在即调用 `migrate_legacy_db()` 一次性导入：

- **幂等**：目标 `memories` 表已有数据则跳过；旧库无 memories 表也跳过
- 迁移失败仅记日志，**不阻断应用启动**

### 4.5 容量上限与过期清理（2026-09-05，问题 29）

长期使用会积累大量低分/过期记忆拖慢检索，采用「容量上限 + 过期未命中」双清理策略（`prune_memories`）：

| 规则 | 阈值 | 淘汰依据 |
|------|------|----------|
| 分组上限 | 60 条 / `(book_id, skill_type)` | 相关度低 → 久未命中 → 后插入 优先淘汰 |
| 全书上限 | 240 条 / book | 组清理后仍超限的兜底（同上排序） |
| 过期未命中 | 180 天 | `last_hit_at`（无则 `updated_at`）早于阈值直接删除 |

- **命中打点**：`retrieve_memories` 选中注入的记忆即时更新 `last_hit_at`，作为过期判定依据
- **触发时机**：`extract_and_save` 每次沉淀新记忆后随路清理本组；`lib.rs` 启动时
  `prune_all_memories` 兜底清理存量（幂等，空库零开销）
- 清理失败仅记日志，不阻断记忆写入主流程

---

## 5. 技能与 Prompt（prompts.rs）

### 5.1 四个技能

| Skill | 标识 | 核心能力 |
|-------|------|---------|
| 写作辅助 | `writing` | 大纲生成、情节建议、角色对话模拟、冲突设计 |
| 内容分析 | `analysis` | 文风分析、连贯性检查、伏笔追踪、角色弧光、节奏评估 |
| 研究辅助 | `research` | 资料检索、世界观一致性校验、设定扩展、关系图谱 |
| 润色优化 | `polish` | 语法纠错、文笔润色、风格统一、冗余精简 |

`skill_base_prompt(skill)` 返回对应技能 Prompt；未知 skill 回退 `writing`。

### 5.2 动态场景提示

`get_dynamic_prompt(skill, user_message)` 采用 **核心 Prompt + 场景提示** 分离：

```
核心 Prompt（固定，前缀结构稳定，利于 KV Cache 命中）
   + 用户消息关键词匹配到的场景提示（最多 3 条，来自 dynamic_hints 表）
   = 最终 System Prompt
```

例如消息含「大纲」追加大纲生成指引，含「伏笔」追加伏笔分析指引。`estimate_prompt_tokens` 按 `中文/1.5 + 其他/3.5` 估算 Prompt Token。

---

## 6. 工具链（tools.rs）

### 6.1 工具与技能映射

6 个数据库工具，数据源全部经 **repository 层**（chapter_repo / world_card_repo / book_repo）直接查询 SQLite：

| 工具 | 用途 | Token 优化 |
|------|------|-----------|
| `read_chapter` | 读取章节完整内容 | — |
| `read_chapter_summary` | 仅章节摘要 | 摘要优先，无摘要时取前 500 字 |
| `read_chapter_chunk` | 大章节分页读取 | 2000 字/段 |
| `list_book_chapters` | 章节列表 | 仅标题 + 摘要 |
| `search_world_cards` | 世界观搜索 | 限 5 条，FTS5 优先、LIKE 降级 |
| `get_book_context` | 整书上下文 | 近 5 章摘要 + 世界观概览 |

各技能按需裁剪工具集（`tools_for_skill`），减少 Prompt 体积与误调用：

| Skill | 工具集 |
|-------|--------|
| `writing` | read_chapter_summary / read_chapter_chunk / list_book_chapters / search_world_cards / get_book_context |
| `analysis` | read_chapter / read_chapter_chunk / list_book_chapters / search_world_cards / get_book_context |
| `research` | read_chapter_summary / list_book_chapters / search_world_cards / get_book_context |
| `polish` | read_chapter / read_chapter_chunk / get_book_context |

> 未知 skill 默认取 writing 工具集。

### 6.2 执行与裁剪

- `build_tools_schema(skill)` 生成 OpenAI function calling 格式的 `tools` 数组随请求发送
- `execute_tool(conn, name, args)` 分发到各 `tool_*` 私有函数
- 返回内容统一裁剪（单工具结果上限 200,000 字符），循环内再按 `MAX_TOOL_RESULT_CHARS`（30,000）压缩后作为 tool 消息回填

---

## 7. 前端集成（components/agent/）

| 文件 | 职责 |
|------|------|
| `useAgent.ts` | Agent 模式核心 hook：`execute_agent_skill` / `cancel_agent_skill` 调用，`listen('agent-stream-chunk')`，按 `requestId` 过滤 + RAF 缓冲合并 chunk |
| `AgentMemoryPanel.tsx` | 记忆管理面板：list / update / delete / clear |
| `AgentMessageBubble.tsx` | 消息气泡（Markdown、流式光标、复制/删除），纯展示 |
| `types.ts` | `SkillType` / `AgentStreamEvent` / `MemoryInfo` / `SKILLS[]` 等类型与常量 |

要点：

- **状态恒为 running**：Agent 无外部进程可启停，`useAgent.status` 固定 `'running'`，Header 状态栏显示「已连接 · 模型服务就绪」
- `aiConfig` 取自设置页对话配置，Agent 场景强制 `reasoningEffort: 'max'`
- AI 侧面板（`AiSidePanel`）与工具箱在 Agent 模式下同样复用 `execute_agent_skill`

> **约定例外**：以上 Agent invoke 直接由组件发起（未封装进 `tauri-bridge.ts`），
> 与「唯一 IPC 入口」约定不一致，见 [架构总览](architecture/overview) 备注。

---

## 8. 与 v1.0 Python 实现的主要差异

| 维度 | v1.0（Python Agent） | v1.2（Rust 原生） |
|------|---------------------|-------------------|
| 运行形态 | 独立 FastAPI 子进程 @9877 | 内嵌 Rust 主进程 |
| 数据访问 | 经 9876 Bridge HTTP 回调 | 同进程 repository 层直查 |
| 运行时依赖 | Python + venv + uvicorn + LangChain | 无（纯 Rust + 云端模型 API） |
| 记忆存储 | `data/agent_memory.db`（独立 SQLite） | `memories` 表（并入主库，自动迁移） |
| 进程管理 | 解释器探测/看门狗/优雅关闭 | 无需（已删除） |
| 启动流程 | Agent 异步启动 + Bridge 就绪等待 | 仅旧记忆库幂等迁移 |

---

## 9. 相关文档

- [Agent 使用指南](user-guide/agent-panel) — 面向用户
- [AI 模块架构](architecture/AI-architecture) — AI 对话 / RAG（非 Agent）
- [架构总览](architecture/overview) — 系统级双进程模型
- [IPC 命令速查](development/ipc-api) — Agent 相关命令与事件
- [ADR-002（Bridge 只读架构，已废弃）](architecture/adr/ADR-002-agent-bridge-readonly) — v1.0 历史决策记录
