# AI 模块架构

> **适用版本**：`1.5.0`　|　**最后核对**：2026-09-03
>
> 涵盖 AI 流式对话（工具箱）、AI 侧面板对话（经 Agent 引擎）、RAG 向量检索（预留）、内容总结、连接测试。
> Agent 自动化引擎（Rust 原生）另见 [Agent 引擎架构](architecture/agent-architecture)。

---

## 目录

1. [架构总览](#1-架构总览)
2. [服务商配置](#2-服务商配置)
3. [Rust 后端模块](#3-rust-后端模块)
4. [流式对话](#4-流式对话-commandsaichatrs)
5. [RAG 检索与 Embedding](#5-rag-检索与-embedding-commandsaiembeddingrs)
6. [内容总结](#6-内容总结-commandsaisummarizers)
7. [连接测试](#7-连接测试-commandsaitestrs)
8. [前端组件](#8-前端组件)
9. [状态与类型](#9-状态与类型)
10. [AI 工具箱](#10-ai-工具箱)
11. [关键常量](#11-关键常量)
12. [设计评价与优化方向](#12-设计评价与优化方向)

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    前端 (React/TypeScript)                 │
│  AiSidePanel.tsx         AiToolboxPanel.tsx              │
│  (AI 对话面板·4 技能)      (三栏工具箱·预设 Prompt)          │
│       └───────────────┬───────────────┘                  │
│                 useAiChat.ts                             │
│        （流式事件监听 / 历史总结 / 错误恢复）                 │
│                       │                                  │
│  Zustand aiSlice + Jotai aiPanelOpenAtom                 │
│  tauri-bridge.ts（aiApi + 组件直调 Agent 命令）            │
├───────────────────────┼──────────────────────────────────┤
│                 Tauri IPC 边界                            │
├───────────────────────┼──────────────────────────────────┤
│  Rust 对话与总结层 commands/ai/ + commands/agent/         │
│  ┌────────────────┬────────────────┬──────────────┐      │
│  │ agent/skills.rs│   chat.rs      │ embedding.rs  │      │
│  │ engine.rs      │ 工具箱流式对话  │ RAG/索引(预留) │      │
│  │ AI 面板对话     │  OpenAI SSE    │               │      │
│  │ (ReAct+工具)    │                │ summarize.rs  │      │
│  │                │                │ 章节/对话总结  │      │
│  └──────┬─────────┴───────┬────────┴────────┬──────┘      │
│         ▼                 ▼                 ▼             │
│  emit('agent-       emit('ai-stream-   emit('chapter-/    │
│  stream-chunk')    chunk')             conversation-      │
│  (chunk/done/      (thinking/           summary-done')    │
│   error/cancelled)  answering/retrying)                   │
└───────────────────────────────────────────────────────────┘
```

**关键设计决策**：

1. 流式请求**完全在 Rust 端**通过 `reqwest` 处理，前端只通过 Tauri 事件接收增量文本，规避浏览器 CORS / 流式解析问题
2. 支持 Ollama 原生协议（NDJSON）与 OpenAI 兼容协议（SSE）两条路径（工具箱/总结直连场景）
3. **v1.2 起 AI 侧面板对话统一由 Agent 引擎驱动**：`useAiChat.handleSend()` → `execute_agent_skill`（默认 `writing` 技能），Prompt 构建与上下文检索由引擎内部完成；工具箱保留 `stream_ai_chat` 直连
4. **RAG/Embedding 为预留能力**：后端 `rag_search` / `trigger_embedding` / `check_embedding_status` 命令已实现并注册，但设置页标记「预留」，当前对话上下文由 Agent 引擎内置工具（章节读取/搜索）提供，`triggerEmbedding` 无前端 UI 接线
5. 对话配置（AiChatConfig）与 RAG/Embedding 配置（RagConfig）完全解耦，各自独立管理 API Key、端点、模型
6. 各服务商 API Key 独立存储（`bigmodelApiKey` / `deepseekApiKey`）
7. AI 配置经 localStorage 持久化，自动兼容旧版扁平格式迁移
8. 流式事件三阶段通知：`thinking` → `answering` → `done`

> **v1.0.0 变更**：原 `commands/ai.rs`（约 1265 行）已拆分为 `ai/{chat,embedding,summarize,test}.rs` 四个子模块。
> **v1.2.0 变更**：Agent 迁移为 Rust 原生后，AI 面板对话接入 Agent 引擎（见 [Agent 引擎架构](agent-architecture)）。

---

## 2. 服务商配置

### 2.1 对话服务商

| 服务商 | 标识 | 默认端点 | 默认模型 | 可选模型 |
|--------|------|---------|---------|---------|
| 智谱 BigModel | `bigmodel` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.1` | `glm-5.1` |
| DeepSeek | `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` | `deepseek-v4-flash`、`deepseek-v4-pro` |
| Ollama | `ollama` | `http://127.0.0.1:11434` | `qwen2.5:7b` | 任意本地模型 |
| 自定义 | `custom` | 用户填写 | 用户填写 | — |

### 2.2 RAG / Embedding 服务商

RAG 仅支持**智谱 BigModel**（DeepSeek 不提供 Embeddings API）：

| 服务商 | 默认端点 | Embedding 模型 |
|--------|---------|---------------|
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `embedding-3` |

### 2.3 能力对比

| 能力 | 智谱 BigModel | DeepSeek | Ollama |
|------|:---:|:---:|:---:|
| 流式对话 | ✅ | ✅ | ✅ |
| 深度思考 / 推理 | ✅ | ✅ | ❌ |
| Embedding 向量 | ✅ (`embedding-3`) | ❌ | ❌ |
| RAG 语义检索 | ✅ | ❌ | ❌ |

### 2.4 默认配置常量

定义于 `src/components/settings/constants.ts`：

```typescript
PROVIDER_DEFAULTS = {
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1' },
  deepseek: { endpoint: 'https://api.deepseek.com',             model: 'deepseek-v4-flash' },
  ollama:   { endpoint: 'http://127.0.0.1:11434',               model: 'qwen2.5:7b' },
  custom:   { endpoint: '',                                      model: '' },
}
RAG_PROVIDER_DEFAULTS = {
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', embeddingModel: 'embedding-3' },
}
```

---

## 3. Rust 后端模块

| 文件 | 命令 | 职责 |
|------|------|------|
| `ai/chat.rs` | `stream_ai_chat` | SSE/NDJSON 流式对话、重试、超时、buffer 刷新 |
| `ai/embedding.rs` | `rag_search`、`trigger_embedding`、`check_embedding_status`、`test_rag_connection` | 向量检索、批量索引、状态检查 |
| `ai/summarize.rs` | `summarize_chapter`、`summarize_conversation` | 章节总结（非流式）、对话压缩（滑动窗口） |
| `ai/test.rs` | `test_ai_connection`、`test_rag_connection` | 连通性测试 |

### 核心数据结构

```rust
/// RAG 检索结果
#[derive(Serialize)]
pub struct RagResult {
    pub snippet: String,
    #[serde(rename = "sourceId")]  pub source_id: String,
    #[serde(rename = "sourceTitle")] pub source_title: String,
    pub distance: f64,
}

/// 流式对话请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChatArgs {
    pub provider: String,        // "ollama" | "openai_compatible"
    pub endpoint: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: Option<u32>,
    pub api_key: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub thinking_enabled: bool,  // 推理模型思考模式
}

/// 流式事件负载（推送到前端的增量）
#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    pub content: String,          // 累积的正式输出
    pub thinking: String,         // 累积的思考过程
    pub phase: String,            // "thinking" | "answering" | "retrying" | "done"
    pub done: bool,
    pub error: Option<String>,
    pub usage: Option<UsageInfo>, // Token/字数用量（仅 done）
}

/// Embedding 索引状态
pub struct EmbeddingStatus {
    pub total_chapters: usize,
    pub total_world_cards: usize,
    pub indexed_chapters: usize,
    pub indexed_world_cards: usize,
    pub stale: bool,              // total > indexed 且 > 0 时为 true
}
```

---

## 4. 流式对话 `commands/ai/chat.rs`

### 4.1 完整链路

> v1.2 起 `useAiChat` 已改为经 **Agent 引擎**执行（`execute_agent_skill`），`chat.rs` 直连链路保留给
> AI 工具箱（`AiToolboxPanel` → `aiApi.streamChat`）等场景。两条链路如下：

**链路 A：AI 侧面板对话（当前默认，走 Agent 引擎）**

```
用户输入（AI 侧面板）→ useAiChat.handleSend()
  ↓
1. 历史压缩：过长时先 summarize_conversation 滑动窗口压缩（可选）
  ↓
2. 注册 listen('agent-stream-chunk')（按 requestId 过滤）
  ↓
3. invoke('execute_agent_skill', { skill:'writing', bookId, message, aiConfig, requestId, ... })
  ↓ [Rust commands/agent/]
4. engine.rs 组装 Prompt（基础 + 场景提示 + 记忆段）→ reqwest POST /chat/completions (stream: true)
5. 需要上下文时调用工具，经 repository 层直读 SQLite
  ↓
6. emit('agent-stream-chunk', { event: chunk/done/error/cancelled }) → 前端 RAF 缓冲合并渲染
  ↓
7. persistAiConversation() → localStorage（结束事件后）
```

**链路 B：工具箱 / 直连场景（走 stream_ai_chat）**

```
AiToolboxPanel → aiApi.streamChat() → invoke('stream_ai_chat')
  ↓ [Rust commands/ai/chat.rs]
reqwest POST {endpoint}/chat/completions (stream: true)
  → emit('ai-stream-chunk', StreamEvent) → 前端实时渲染
  → [DONE] → 更新消息（含 usage / 思考过程）
```

> 本章 4.2～4.6 的客户端配置、阶段管理、容错、协议对比与思考模式均针对链路 B（`chat.rs`）。

### 4.2 HTTP 客户端配置

```rust
Client::builder()
    .connect_timeout(30s)        // 连接超时
    .http1_only()                // 仅 HTTP/1.1（SSE 兼容）
    .no_gzip().no_brotli()       // 禁用自动解压
    .tcp_keepalive(120s)         // 防长思考期间断连
```

### 4.3 阶段管理

| 阶段 | `phase` | 说明 |
|------|---------|------|
| 总结中 | `summarizing` | 前置章节总结（原文 > 300 字） |
| 思考中 | `thinking` | 处理 `reasoning_content`，未收到 `content` |
| 输出中 | `answering` | 收到第一个 `content` 增量后切换 |
| 重试中 | `retrying` | 网络波动，自动重试 |
| 完成 | `done` | 收到 `[DONE]` 或流自然结束 |

### 4.4 容错机制

**自动重试**
- 最多重试 2 次，指数退避（1s → 2s）
- 可重试：timeout、connection reset、5xx、429、空内容
- 不可重试：401、403、404（认证/权限问题直接返回）

**双层超时**
- 10 分钟全局超时
- 60 秒单 chunk 读取超时（`tokio::time::timeout`），判定为半开连接

**断流保底**
- `flush_sse_buffer()` 从残留 buffer 提取最后的内容/思考/token 用量
- 已有内容时以 `done` 事件收尾（附带错误提示），**保留已生成内容**而非整体报错

### 4.5 两种协议对比

| 特性 | Ollama（NDJSON） | OpenAI 兼容（SSE） |
|------|------------------|---------------------|
| 端点 | `/api/chat` | `/chat/completions` |
| 增量提取 | `message.content` | `choices[0].delta.content` |
| 思考过程 | 不支持 | `choices[0].delta.reasoning_content` |
| 结束信号 | 流关闭 + 最终事件 | `[DONE]` 或流关闭 |
| Token 限制 | `num_predict`（默认 -1 不限制） | `max_tokens` |
| 认证 | 无需 | `Authorization: Bearer {key}` |

### 4.6 思考模式

`thinking_enabled = true` 时（DeepSeek R1 / 智谱推理模型）：

- 解析 SSE 流中的 `reasoning_content` 字段作为思考过程
- 通过 `phase: "thinking"` 推送，前端渲染为可折叠区域
- 正式回答通过 `phase: "answering"` 推送 `delta.content`
- DeepSeek 额外统计 KV Cache 命中（`prompt_cache_hit_tokens`）

---

## 5. RAG 检索与 Embedding `commands/ai/embedding.rs`

### 5.1 双模式检索

```
              ┌──────────────────┐
              │    用户查询        │
              └────────┬─────────┘
                       ↓
        ┌──────────────────────────┐
        │  embeddings 表有数据?      │
        └──────┬────────────┬──────┘
            YES│            │NO
               ↓            ↓
    ┌──────────────────┐  ┌──────────────────┐
    │  向量语义搜索      │  │ FTS5 / LIKE 降级  │
    │  余弦相似度        │  │  关键词匹配       │
    └────────┬─────────┘  └─────────┬────────┘
             └──────────┬───────────┘
                        ↓
              返回 Top N RagResult[]
```

- **检索范围**：`chapters` 表（排除软删除）+ `world_cards` 表，均按 `book_id` 隔离
- **向量搜索**：查询向量经 `/embeddings` API 获取，与已索引向量计算余弦相似度，降序取 Top N
- **降级策略**：查询词前 20 字符构造 `LIKE '%keyword%'`，先搜章节、不足时补搜世界观卡片，降级结果 `distance` 固定 0.5

```rust
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let (dot, na, nb) = /* ... */;
    dot / (na.sqrt() * nb.sqrt())
}
```

### 5.2 Embedding 生成流程

```
1. 收集源数据
   ├── 章节：SELECT id, content_html FROM chapters WHERE book_id=? AND deleted_at IS NULL
   └── 世界观卡片：SELECT id, content_html FROM world_cards WHERE book_id=?
2. 文本预处理
   ├── strip_html() → 去 HTML 标签
   ├── truncate_for_embedding() → 截断到 1800 字符
   └── 过滤空文本
3. 批量调用 Embedding API（每批 20 条）
4. 写入数据库
   ├── INSERT OR REPLACE INTO embeddings (source_type, source_id, embedding, model)
   └── UPDATE world_cards SET vectorized = 1
```

**关键参数**

| 参数 | 值 | 说明 |
|------|-----|------|
| `EMBEDDING_MAX_CHARS` | 1800 | 单条文本截断长度 |
| `BATCH_SIZE` | 20 | 每批 API 调用条数 |
| 存储格式 | `f32 → LE bytes BLOB` | 小端字节序 |

> 先收集全部数据（释放 statement 锁），再执行异步 API 调用。

### 5.3 Embeddings 表

```sql
CREATE TABLE IF NOT EXISTS embeddings (
    source_type TEXT NOT NULL,   -- 'chapter' | 'world_card'
    source_id TEXT NOT NULL,
    embedding BLOB NOT NULL,     -- f32[] → LE bytes
    model TEXT NOT NULL,
    PRIMARY KEY (source_type, source_id)
);
```

---

## 6. 内容总结 `commands/ai/summarize.rs`

### 6.1 章节总结 `summarize_chapter`

- **非流式请求**（`stream: false`），返回完整总结
- 默认 System Prompt：专业小说助手，300 字内总结主要情节/事件/人物，支持自定义
- 支持 DeepSeek 思考模式
- 返回 `ChapterSummary { summary, originalChars, summaryChars, thinking }`
- 调用场景：AI 侧面板对话（原文 > 300 字自动触发）、章节总结独立窗口
- 章节过短（< 50 字）自动跳过，内容截取前 8000 字符

### 6.2 对话压缩 `summarize_conversation`

滑动窗口 + 摘要压缩的双层 context 管理：

```
┌────────────────────────────────────────┐
│              System Prompt             │
│  — 角色指令 + 卷/章节上下文 + RAG 背景    │
│  — [历史对话摘要]（压缩的旧对话）         │
├────────────────────────────────────────┤
│         滑动窗口（最近 N 轮）            │
│  [user] ... [assistant] ...            │
│  [user] (当前提问)                      │
└────────────────────────────────────────┘
```

- `buildMessages()` 仅取最近 `windowSize * 2` 条消息
- 每次 `done` 事件后触发 `summarizeOverflowMessages()`，超出窗口时后台压缩（不阻塞 UI）
- 摘要结构 `{ summary, coveredUpToId, summaryChars, updatedAt }`，按 bookId 分组持久化，`coveredUpToId` 保证幂等
- `contextWindowSize` 配置项，默认 10（范围 1-50），旧配置自动迁移补为 10

---

## 7. 连接测试 `commands/ai/test.rs`

| 命令 | 请求 | 成功返回 | 超时 |
|------|------|---------|------|
| `test_ai_connection` | `GET {endpoint}/models`（带 Bearer Key） | 可用模型列表（最多 10 个） | 15s |
| `test_rag_connection` | `POST {endpoint}/embeddings`（测试文本） | 向量维度信息 | 15s |

错误区分：401 → "认证失败"；其他 → 原始错误详情。

---

## 8. 前端组件

| 组件 | 路径 | 职责 |
|------|------|------|
| `AiSidePanel` | `components/ai/AiSidePanel.tsx` | 对话面板：Header（连接状态指示器）+ MessageList + QuickHints + InputArea |
| `useAiChat` | `components/ai/useAiChat.ts`（425 行） | 核心 hook：发送（经 Agent 引擎 `execute_agent_skill`）、流式事件（`agent-stream-chunk`）、历史总结/压缩、错误恢复 |
| `MessageBubble` | `components/ai/MessageBubble.tsx` | 消息气泡：Markdown 渲染 + 思考过程折叠 + 操作按钮 |
| `RequestDetailModal` | `components/ai/RequestDetailModal.tsx` | 请求详情：参数 / System Prompt / 章节总结 / RAG 上下文 / 消息列表 |
| `AiToolboxPanel` | `components/ai/AiToolboxPanel.tsx` | AI 工具箱（三栏布局，独立窗口） |
| `ChapterSummaryHeader` | `components/editor/ChapterSummaryHeader.tsx` | 编辑器顶部内联总结条 |

### 连接状态指示器

```typescript
const statusConfig = {
  idle:      { icon: CircleIcon,      color: 'text-muted-foreground/50' },
  testing:   { icon: Loader2Icon,     color: 'text-blue-500 animate-spin' },
  connected: { icon: CircleCheckIcon, color: 'text-green-500' },
  error:     { icon: CircleAlertIcon, color: 'text-red-500' },
}
```

### 消息持久化策略

| 操作 | 是否写盘 |
|------|:---:|
| `addAiMessage` | ✅ 立即 |
| `updateAiMessage`（流式高频） | ❌ 仅内存 |
| `persistAiConversation`（流结束） | ✅ 一次写入 |
| 删除 / 清空 | ✅ 立即 |

---

## 9. 状态与类型

```typescript
interface AiChatConfig {
  provider: 'bigmodel' | 'deepseek' | 'ollama' | 'custom'
  endpoint: string
  model: string
  temperature: number          // 0–1，默认 0.7
  maxTokens: number            // 默认 131072
  bigmodelApiKey?: string
  deepseekApiKey?: string
  thinkingEnabled: boolean     // 默认 true
  contextWindowSize: number    // 默认 10，范围 1–50
}

interface RagConfig {
  // v1.2 起无 enabled 字段（预留能力，不影响当前对话）
  provider: 'bigmodel'         // 当前仅智谱提供 Embeddings API
  endpoint: string
  embeddingModel: string       // 默认 embedding-3
  bigmodelApiKey?: string
}

interface AiConfig { chat: AiChatConfig; rag: RagConfig }

interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  phase: 'thinking' | 'answering' | 'done' | 'summarizing' | 'retrying'
  isSummarizing?: boolean
  loading?: boolean
  usage?: { inputTokens; outputTokens; inputChars; outputChars } | null
  requestPayload?: ChatRequestPayload
}
```

**localStorage 键**

| 键 | 内容 |
|----|------|
| `time-write-ai-config` | `AiConfig` 对象 |
| `time-write-ai-conversations` | `Record<bookId, AiMessage[]>` |
| `time-write-ai-tool-categories` | `AiToolCategory[]` |

**兼容性迁移**：旧版扁平 `AiConfig` → `chat`/`rag` 分离；旧版 `apiKey` → 双服务商 Key；旧版 `aiToolPrompts` → `aiToolCategories`。

---

## 10. AI 工具箱

三栏布局：左侧工具列表（192px）→ 中间输入区（288px）→ 右侧输出面板（弹性）。

| 分类 | 工具数 | 包含工具 |
|------|:---:|------|
| 常用工具 | 7 | 章节总结、小说大纲生成、章节深度润色、小说扩写、续写、润色、改写 |
| 剧情设计 | 6 | 主线剧情设定、支线分解、剧情反转、核心冲突生成器、章节细纲、系统设定生成器 |
| 描写辅助 | 6 | 打斗描写、细节描写、感官描写、外貌描写、情感描写、环境/场景描写 |
| 世界设定 | 5 | 世界架构设定、人物设定、势力组织架构、境界/功法等级、物品设定 |
| 取名神器 | 5 | 人物名字定制、小说书名、古风姓名、门派势力名称、地点场景取名 |

- 每个工具的 System Prompt 可独立编辑，留空使用默认提示词
- 章节总结工具在工具箱中自动过滤（有独立窗口）
- 支持 `initialToolId` 参数从外部指定默认选中工具
- 所有工具与分类持久化到 localStorage

---

## 11. 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `EMBEDDING_MAX_CHARS` | 1800 | 单条文本截断长度 |
| `BATCH_SIZE` | 20 | Embedding 批量生成批大小 |
| `MAX_RETRIES` | 2 | 流式对话最大重试次数 |
| `SSE_READ_TIMEOUT_SECS` | 60 | SSE 读取超时（秒） |
| `GLOBAL_TIMEOUT` | 600 | 全局超时（秒） |
| `CHAPTER_SUMMARY_THRESHOLD` | 300 | 章节自动总结字数阈值 |
| `RAG_TOP_N` | 3 | RAG 检索返回片段数 |
| `DEFAULT_CONTEXT_WINDOW_SIZE` | 10 | 默认滑动窗口轮数 |
| `DEFAULT_MAX_TOKENS` | 131072 | 默认最大输出 Token |

---

## 12. 设计评价与优化方向

### 12.1 优点

| 方面 | 评价 |
|------|------|
| 架构分离 | Rust 处理 HTTP/SSE，前端仅处理 UI，规避 CORS 与流式解析问题 |
| 流中断保护 | 60s 超时 + buffer 刷新 + 保留部分内容，用户体验友好 |
| 自动重试 | 区分可重试/不可重试错误，指数退避，减少用户干预 |
| 双检索模式（预留） | 后端实现向量语义 → FTS5/LIKE 降级，但前端未接线，对话上下文由 Agent 引擎工具检索提供 |
| 章节智能总结 | 原文 > 300 字自动总结，节省 context token |
| 多维度配置 | 对话/RAG 解耦，服务商独立 API Key，工具箱可扩展 |
| 持久化可靠 | 高频更新不写 localStorage，流结束后一次性持久化 |
| 迁移兼容 | 自动检测旧版配置格式并迁移，用户无感知升级 |
| 请求透明 | RequestDetailModal 展示完整请求载荷，便于调试 |

### 12.2 优化方向

| 方向 | 现状 | 建议 |
|------|------|------|
| Provider 扩展性 | 服务商硬编码在配置常量中 | 插件化或配置驱动的 Provider 注册机制 |
| Embedding 服务商 | 仅智谱，写死 `bigmodel` | 支持 OpenAI embeddings、本地模型 |
| RAG 检索效率 | 全量内存计算余弦相似度 | 内容量大后引入向量索引（faiss-rust / sqlite-vec） |
| 流式断点续传 | 断连后仅保留已生成内容 | 长思考场景可考虑真正的断点续传 |
| API Key 轮换 | 每个服务商单 Key | 支持多 Key 负载均衡 / 故障转移 |
| 对话导出 | 不支持 | 导出为 Markdown / JSON |
| 章节总结缓存 | 每次对话都重新总结 | summary 有效期内复用缓存 |
| 系统默认工具 | 预设 29 个工具不可删除/重置 | 增加「恢复默认」功能 |
| 请求参数可配置性 | Temperature 等为全局设置 | 每个工具可独立覆盖参数 |
| `useAiChat` 体积 | 425 行（v1.2 移除 Embedding 逻辑），仍职责较多 | 拆分为 `useChapterValidation` / `useChapterSummary` / `useStreamChat` / `useConversationCompression` |
| RAG 接线 | 后端命令已实现、前端标记预留 | 明确 RAG 定位（接入设置页或并入 Agent 工具），或移除冗余命令 |

### 12.3 安全注意

- API Key 存储于 localStorage **明文**，未加密
- 所有 API 通信在 Rust 侧进行，前端无法截获
- 连接测试不泄露 API Key（仅验证认证状态）
- `capabilities/default.json` 中 `http:allow-fetch` 放开任意 HTTP/HTTPS 端点（AI 请求必需，但也是 CSP 收紧的权衡点，见 [优化报告](meta/optimization-report) 问题 8）
