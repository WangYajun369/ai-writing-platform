# TimeWrite AI 模块全面技术文档

> 生成日期：2026-06-09  
> 项目：智写时光 TimeWrite — 跨平台小说创作工具  
> 涵盖 AI 对话、RAG 向量检索、流式响应、Embedding 索引、连接测试等功能

---

## 目录

1. [架构总览](#1-架构总览)
2. [Rust 后端——AI 核心引擎](#2-rust-后端ai-核心引擎)
3. [前端——AI 助手 UI](#3-前端ai-助手-ui)
4. [前端——设置页面](#4-前端设置页面)
5. [状态管理与类型定义](#5-状态管理与类型定义)
6. [编辑器集成](#6-编辑器集成)
7. [API 桥接层](#7-api-桥接层)
8. [样式与渲染](#8-样式与渲染)
9. [插件扩展点](#9-插件扩展点)
10. [配置文件与权限](#10-配置文件与权限)
11. [数据模型关联](#11-数据模型关联)

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    前端 (React/TypeScript)                 │
├──────────────────────────────────────────────────────────┤
│  AiSidePanel.tsx        SettingsPage.tsx                  │
│  (流式对话UI + RAG)      (对话配置 + RAG独立配置)           │
│       │                       │                          │
│       └───────┬───────────────┘                          │
│               │                                          │
│  appStore.ts (AiChatConfig + RagConfig 分离持久化)         │
│  uiAtoms.ts  (aiPanelOpenAtom)                           │
│  types/index.ts (AiChatConfig, RagConfig, AiMessage)     │
│  tauri-bridge.ts (aiApi: 6个IPC方法)                      │
│               │                                          │
├───────────────┼──────────────────────────────────────────┤
│            Tauri IPC 边界                                 │
├───────────────┼──────────────────────────────────────────┤
│               │                                          │
│  lib.rs ── 注册6个AI命令 ──► commands/ai.rs               │
│                                    │                     │
│                    ┌───────────────┼───────────────┐     │
│                    │               │               │     │
│       test_ai_connection  rag_search   stream_ai_chat    │
│       test_rag_connection           trigger_embedding    │
│       (对话+ RAG独立连接测试)        check_embedding_status│
│                    │               │               │     │
│            ┌───────┴───────┐      SQLite      ┌────┴────┐│
│            │ Ollama│OpenAI │   (LIKE降级)     │Ollama   ││
│            │ DeepSeek│智谱 │                   │NDJSON   ││
│            └───────────────┘                   │OpenAI   ││
│                                                 │SSE      ││
│                                                 │/chat/   ││
│                                                 │completions│
│                                                 └─────────┘│
│                                                             │
│  事件推送: ai-stream-chunk → 前端 listen<StreamEvent>        │
│  三阶段: thinking → answering → done                        │
└──────────────────────────────────────────────────────────┘
```

**关键设计决策：**

1. 流式请求完全在 Rust 端通过 `reqwest` 处理，前端只通过 Tauri 事件接收增量文本，避免了浏览器 CORS/流式解析问题
2. 支持 Ollama 原生协议和 OpenAI 兼容协议两种路径，可接入智谱 BigModel、DeepSeek（含推理思考模式）、OpenAI、Ollama 及任何兼容 API
3. v0.4.0 起对话配置（AiChatConfig）与 RAG/Embedding 配置（RagConfig）完全解耦，各自独立管理 API Key、端点、模型
4. RAG 采用**向量检索优先 + SQL LIKE 降级**双策略：有 embedding 时使用余弦相似度向量搜索，否则降级为关键词搜索
5. 各服务商 API Key 独立存储：`bigmodelApiKey` 和 `deepseekApiKey`，支持不同服务商使用不同密钥
6. AI 配置通过 localStorage 持久化，自动兼容旧版扁平格式迁移
7. 插件系统预留了 `ai-prompt` 扩展点，可扩展 AI 提示词模板
8. 流式事件支持三阶段通知：`thinking`（推理思考）→ `answering`（正式回答）→ `done`（完成 + 用量统计）

---

## 2. Rust 后端——AI 核心引擎

**文件：** `src-tauri/src/commands/ai.rs`（~650 行）

### 2.1 数据结构

```rust
/// RAG 检索结果
#[derive(Serialize)]
pub struct RagResult {
    pub snippet: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceTitle")]
    pub source_title: String,
    pub distance: f64,
}

/// AI 连接测试结果
#[derive(Debug, Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,      // 是否连接成功
    pub detail: String, // 成功时返回可用模型列表，失败时返回错误信息
}

/// 单条消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 流式对话请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChatArgs {
    pub provider: String,        // "ollama" | "openai_compatible"
    pub endpoint: String,        // API 端点 URL
    pub model: String,           // 模型名
    pub temperature: f64,        // 温度参数
    pub max_tokens: Option<u32>, // 最大输出 token
    pub api_key: Option<String>, // API Key
    pub messages: Vec<ChatMessage>, // 消息列表
    pub thinking_enabled: bool,  // 是否启用思考模式（v0.4.0 新增）
}

/// 流式事件负载（推送到前端的实时增量）
#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    pub content: String,           // 当前累积的正式输出文本
    pub thinking: String,          // 当前累积的思考过程（智谱/DeepSeek 推理模型）
    pub phase: String,             // 当前阶段："thinking" | "answering" | "done"
    pub done: bool,                // 是否完成
    pub error: Option<String>,     // 错误信息（仅出错时非空）
    pub usage: Option<UsageInfo>,  // Token/字数用量统计（仅 done 事件）
}
```

### 2.2 IPC 命令一览

| 命令 | 参数 | 返回 | 功能 |
|------|------|------|------|
| `test_ai_connection` | provider, endpoint, api_key? | `ConnectionTestResult` | 测试 AI 对话服务连接 |
| `test_rag_connection` | provider, endpoint, api_key? | `ConnectionTestResult` | 测试 RAG/Embedding 服务连接（v0.4.0 新增） |
| `rag_search` | book_id, query, top_n, endpoint?, api_key?, embedding_model? | `Vec<RagResult>` | RAG 语义检索（向量优先） |
| `check_embedding_status` | book_id | `EmbeddingStatus` | 检查 Embedding 索引状态 |
| `trigger_embedding` | book_id, endpoint, api_key, embedding_model | `EmbeddingProgress` | 批量生成 Embedding 向量 |
| `stream_ai_chat` | args: StreamChatArgs | `String` | AI 流式对话 |

### 2.3 `test_ai_connection` — 对话连接测试

```rust
#[tauri::command]
pub async fn test_ai_connection(
    provider: String,
    endpoint: String,
    api_key: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(10))
        .http1_only()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let endpoint = endpoint.trim_end_matches('/');

    match provider.as_str() {
        "ollama" => test_ollama_connection(client, endpoint).await,
        _ => test_openai_compatible_connection(client, endpoint, api_key).await,
    }
}
```

#### Ollama 连接测试

- **请求：** `GET {endpoint}/api/tags`
- **成功：** 解析 `models[].name`，返回模型列表
- **超时：** 请求 15s，连接 10s

#### OpenAI 兼容连接测试（含智谱/DeepSeek/OpenAI）

- **请求：** `GET {endpoint}/models`，附带 `Authorization: Bearer {api_key}`
- **401：** 返回 "认证失败"
- **成功：** 解析 `data[].id`，限制显示前 10 个

### 2.4 `test_rag_connection` — RAG 连接测试（v0.4.0 新增）

与 `test_ai_connection` 实现类似，但通过独立的 endpoint 和 api_key 测试 Embedding 服务连通性。用于验证 RAG 配置是否正确。

### 2.5 `rag_search` — RAG 检索（向量优先 + LIKE 降级）

采用**向量检索优先**的双策略实现：

1. 当提供 endpoint + api_key + embedding_model 时，检查 embeddings 表是否有该作品的向量数据
2. **有向量数据**：调用 Embedding API 将 query 转为向量，通过**余弦相似度**计算与已有 embeddings 的相似度，返回 top_n 结果
3. **无向量数据**：降级为 SQL `LIKE` 关键词搜索，从 `chapters` 表匹配 `content_html`

```rust
#[tauri::command]
pub async fn rag_search(
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
    top_n: usize,
    endpoint: Option<String>,
    api_key: Option<String>,
    embedding_model: Option<String>,
) -> Result<Vec<RagResult>, String> {
    // 向量检索路径...
    // LIKE 降级路径...
}
```

> **技术细节**：向量检索使用点积 + 归一化实现余弦相似度；LIKE 降级时取 query 前 20 个字符构造搜索模式。

### 2.6 `check_embedding_status` — Embedding 状态检查

```rust
#[tauri::command]
pub fn check_embedding_status(
    db: State<'_, AppDb>,
    book_id: String,
) -> Result<EmbeddingStatus, String> {
    // 返回：
    // - total_chapters: 有内容的章节数
    // - total_world_cards: 有内容的世界观卡片数  
    // - indexed_chapters: 已生成 embedding 的章节数
    // - indexed_world_cards: 已生成 embedding 的卡片数
}
```

前端据此判断是否需要触发 Embedding 生成。

### 2.7 `trigger_embedding` — 批量 Embedding 生成

```rust
#[tauri::command]
pub async fn trigger_embedding(
    db: State<'_, AppDb>,
    book_id: String,
    endpoint: String,
    api_key: String,
    embedding_model: String,
) -> Result<EmbeddingProgress, String> {
    // 1. 收集数据：从 chapters 和 world_cards 表收集待嵌入的文本
    // 2. 按每批 20 条分组，调用 Embedding API
    // 3. 将生成的向量写入 embeddings 表（source_type + source_id 唯一约束）
    // 4. 返回进度（total / indexed 计数）
}
```

> 关键细节：先收集所有数据（释放 statement 锁），再执行异步 API 调用（每批 20 条，避免请求过大）。

### 2.8 `stream_ai_chat` — AI 流式对话（核心功能）

**入口函数：** 根据 `provider` 分发到 Ollama 或 OpenAI 兼容协议（智谱/DeepSeek/OpenAI 均走此路径）

```rust
#[tauri::command]
pub async fn stream_ai_chat(
    app: AppHandle,
    args: StreamChatArgs,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))  // 长文生成
        .connect_timeout(std::time::Duration::from_secs(30))
        .http1_only()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    match args.provider.as_str() {
        "ollama" => stream_ollama(app, client, args).await,
        _ => stream_openai_compatible(app, client, args).await,
    }
}
```

#### Ollama 流式协议（NDJSON 格式）

- **端点：** `POST {endpoint}/api/chat`
- **格式：** NDJSON（每行一个 JSON 对象）
- **关键参数：** `num_predict` 默认设 `-1`（不限制），避免 Ollama 默认 128 token 限制

#### OpenAI 兼容流式协议（SSE 格式）

- **端点：** `POST {endpoint}/chat/completions`
- **格式：** SSE（Server-Sent Events），`data: {...}`
- **结束信号：** `data: [DONE]` 或服务端关闭连接
- **支持智谱/DeepSeek/OpenAI** 及任何 OpenAI 兼容 API

#### 思考模式（v0.4.0 新增）

当 `thinking_enabled` 为 `true` 时（DeepSeek R1 等推理模型）：
- 解析 SSE 流中的 `reasoning_content` 字段作为思考过程
- 通过 `phase: "thinking"` 推送思考内容
- 正式回答通过 `phase: "answering"` 推送 `delta.content`

#### 两种协议对比

| 特性 | Ollama（NDJSON） | OpenAI 兼容（SSE） |
|------|------------------|---------------------|
| 端点 | `/api/chat` | `/chat/completions` |
| 增量提取 | `message.content` | `choices[0].delta.content` |
| 思考过程 | 不支持 | `choices[0].delta.reasoning_content`（智谱/DeepSeek） |
| 结束信号 | 流关闭 + 最终事件 | `[DONE]` 或流关闭 |
| Token 限制 | `num_predict`（默认 -1 不限制） | `max_tokens` |
| 认证 | 无需 | `Authorization: Bearer {key}` |
| 三阶段推送 | content 增量 | thinking → answering → done |

### 2.9 模块注册

**`lib.rs`（第 68–73 行）：**

```rust
// AI
commands::ai::rag_search,
commands::ai::trigger_embedding,
commands::ai::check_embedding_status,
commands::ai::stream_ai_chat,
commands::ai::test_ai_connection,
commands::ai::test_rag_connection,
```

**`commands/mod.rs`：**

```rust
pub mod ai;
```

---

## 3. 前端——AI 助手 UI

**文件：** `src/components/ai/AiSidePanel.tsx`

### 3.1 组件概述

`AiSidePanel` 是 AI 对话侧面板，在编辑器右侧 384px 宽度显示。

### 3.2 消息管理

使用 `AiMessage` 类型（详见 5.1 节），包含 `role`、`content`、`thinking`、`phase`、`usage` 等字段。消息通过 `useAppStore` 按 `bookId` 分组管理。

### 3.3 系统提示词

```typescript
// 带 RAG 上下文注入的系统提示词
const systemMsg = context
  ? `你是一位专业的小说创作助手。以下是与当前章节相关的内容：

${context}

请根据这些背景信息和用户的需求提供创作建议、续写、润色等服务。`
  : '你是一位专业的小说创作助手。请根据用户的需求提供创作建议、续写、润色等服务。'
```

### 3.4 流式对话核心流程

```typescript
async function handleSend() {
    // 1. 非 Ollama 提供者验证 API Key（按服务商独立获取）
    // 2. 创建用户和助手消息（助手消息标记 loading）
    // 3. RAG 检索上下文（带 endpoint/api_key/embedding_model 参数）
    // 4. 注册 'ai-stream-chunk' 事件监听，处理三阶段：
    //    - phase="thinking": 显示推理模型的思考过程（可折叠）
    //    - phase="answering": 流式输出正式回答
    //    - phase="done": 输出完成，附带 usage 用量统计
    // 5. 组装 messages，调用 Rust 侧 stream_ai_chat
    // 6. 兜底：用返回值更新，防止 done 事件因时序问题丢失
    // 7. 对话按 bookId 持久化到 localStorage
}
```

### 3.5 思考过程展示

对于支持推理的模型（智谱 GLM、DeepSeek R1），AI 在正式回答前会先输出思考过程：

- `phase="thinking"` 时，思考内容渲染为可折叠区域
- `phase="answering"` 时，正式回答流式输出（Markdown 渲染）
- 用户可点击展开/折叠查看推理过程

### 3.6 Token 用量统计

当 `phase="done"` 时，`usage` 字段包含：
- `inputTokens` / `outputTokens`：模型报告的 Token 数
- `inputChars` / `outputChars`：本地统计的字符数

用于帮助用户了解 API 使用成本。

### 3.7 连接状态指示器

支持 4 种状态，分别显示不同图标和颜色：

```typescript
const statusConfig = {
  idle:     { icon: CircleIcon,     color: 'text-muted-foreground/50' },
  testing:  { icon: Loader2Icon,    color: 'text-blue-500 animate-spin' },
  connected:{ icon: CircleCheckIcon, color: 'text-green-500' },
  error:    { icon: CircleAlertIcon, color: 'text-red-500' },
}
```

### 3.8 服务商显示

```typescript
const providerLabel = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  bigmodel: '智谱',
  deepseek: 'DeepSeek',
  custom: '自定义',
}
```

### 3.9 Embedding 索引管理

面板集成了 Embedding 索引生成功能：
- 调用 `checkEmbeddingStatus()` 查看当前索引状态（已索引/总计）
- 一键触发 `triggerEmbedding()` 批量生成向量索引
- 自动轮询直到全部完成

### 3.10 快捷提示词

在消息为空时显示 4 个快捷提示按钮：

```typescript
['帮我续写下一段', '优化这段对话', '推演剧情走向', '分析人物性格']
```

### 3.11 消息气泡渲染

助手消息使用 `react-markdown` + `remarkGfm` 渲染，支持 GFM 语法（表格、删除线等）。用户消息使用纯文本展示。

---

## 4. 前端——设置页面

**文件：** `src/pages/SettingsPage.tsx`

### 4.1 对话配置区（AiChatConfig）

#### 服务商选择

切换服务商时自动填充默认 endpoint 和 model：

```typescript
const defaults: Record<string, { endpoint; model }> = {
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4',  model: 'glm-5.1' },
  deepseek: { endpoint: 'https://api.deepseek.com/v1',           model: 'deepseek-chat' },
  ollama:   { endpoint: 'http://127.0.0.1:11434',               model: 'qwen2.5:7b' },
  custom:   { endpoint: '',                                      model: '' },
}
```

#### 配置项

| 配置项 | 控件 | 范围/说明 |
|--------|------|-----------|
| 服务商 | `<select>` | 智谱 BigModel / DeepSeek / Ollama / 自定义 |
| API 地址 | `<input>` | 根据服务商自动填充默认值 |
| 对话模型 | `<input>` | 可自定义模型名称 |
| Temperature | `<input type="range">` | 0–1，步长 0.1 |
| 最大输出 Token | `<input type="number">` | 1–131072，步长 1024，默认 131072 |
| 智谱 API Key | `<input type="password">` | 智谱服务专用 |
| DeepSeek API Key | `<input type="password">` | DeepSeek 服务专用 |
| 思考模式 | `<input type="checkbox">` | 仅 DeepSeek/智谱推理模型 |
| 测试连接 | `<button>` | 调用 `aiApi.testConnection()` |

### 4.2 RAG/Embedding 配置区（RagConfig）

v0.4.0 起独立于对话配置：

| 配置项 | 控件 | 说明 |
|--------|------|------|
| 启用 RAG | `<input type="checkbox">` | 开关 |
| 服务商 | `<select>` | 当前仅支持智谱 BigModel（Embeddings API） |
| API 地址 | `<input>` | 自动填充默认值 |
| Embedding 模型 | `<input>` | 如 `embedding-3` |
| API Key | `<input type="password">` | 独立于对话配置的 API Key |
| 测试连接 | `<button>` | 调用 `aiApi.testRagConnection()` |

### 4.3 连接状态展示

- `idle` — 无显示
- `testing` — 蓝色提示 + 旋转动画 "检测中…"
- `connected` — 绿色提示 + 对勾图标 + 模型列表
- `error` — 红色提示 + 警告图标 + 错误详情

---

## 5. 状态管理与类型定义

### 5.1 AI 类型定义（v0.4.0 重构）

**文件：** `src/types/index.ts`

```typescript
/** AI 对话配置（与 RAG 解耦） */
export interface AiChatConfig {
  provider: 'bigmodel' | 'deepseek'
  endpoint: string
  model: string
  temperature: number
  maxTokens: number
  bigmodelApiKey?: string    // 智谱 API Key
  deepseekApiKey?: string    // DeepSeek API Key
  thinkingEnabled: boolean   // DeepSeek/智谱推理思考模式
}

/** RAG / Embedding 检索配置 */
export interface RagConfig {
  enabled: boolean
  provider: 'bigmodel'       // 当前仅智谱提供 Embeddings API
  endpoint: string
  embeddingModel: string
  bigmodelApiKey?: string
}

/** AI 总配置（对话与 RAG 解耦） */
export interface AiConfig {
  chat: AiChatConfig
  rag: RagConfig
}

/** AI 对话消息 */
export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string           // 深度思考过程
  phase: 'thinking' | 'answering' | 'done'  // 当前生成阶段
  loading?: boolean
  usage?: {
    inputTokens: number
    outputTokens: number
    inputChars: number
    outputChars: number
  } | null
}
```

### 5.2 App Store — AI 状态

**文件：** `src/stores/appStore.ts`

```typescript
// localStorage 键
const AI_CONFIG_KEY = 'time-write-ai-config'
const AI_CONVERSATIONS_KEY = 'time-write-ai-conversations'

// 默认配置
aiConfig: {
  chat: {
    provider: 'bigmodel',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.1',
    temperature: 0.7,
    maxTokens: 131072,
    thinkingEnabled: true,
  },
  rag: {
    enabled: true,
    provider: 'bigmodel',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    embeddingModel: 'embedding-3',
  },
  ...savedAiConfig, // 从 localStorage 合并，自动兼容旧版
},

// AI 配置更新（智能合并 chat 和 rag 子配置）
setAiConfig: (config) =>
  set((s) => {
    const merged: AiConfig = {
      chat: config.chat ? { ...s.aiConfig.chat, ...config.chat } : s.aiConfig.chat,
      rag: config.rag ? { ...s.aiConfig.rag, ...config.rag } : s.aiConfig.rag,
    }
    saveAiConfig(merged)
    return { aiConfig: merged }
  }),

// 旧版配置自动迁移：检测旧版扁平格式，自动转换为 chat+rag 分离结构
```

### 5.3 UI Atoms

**文件：** `src/stores/uiAtoms.ts`

```typescript
/** AI 对话面板是否展开 */
export const aiPanelOpenAtom = atom<boolean>(false)
```

---

## 6. 编辑器集成

### 6.1 编辑器页面

**文件：** `src/pages/EditorPage.tsx`

AI 面板在编辑器右侧渲染，384px 宽度：

```tsx
import AiSidePanel from '@/components/ai/AiSidePanel'

// 在编辑器中
{aiPanelOpen && !zenMode && (
  <aside className="w-96 border-l bg-card flex-shrink-0 overflow-hidden">
    <AiSidePanel />
  </aside>
)}
```

专注模式下隐藏所有面板。

### 6.2 工具栏按钮

**文件：** `src/components/editor/EditorToolbar.tsx`

```tsx
import { BotIcon } from 'lucide-react'

<ToolbarBtn
  active={aiPanelOpen}
  onClick={() => setAiPanelOpen((v) => !v)}
  title="AI 助手"
  icon={<BotIcon className="w-4 h-4" />}
/>
```

激活时高亮为 `text-primary`。

---

## 7. API 桥接层

**文件：** `src/lib/tauri-bridge.ts`

```typescript
export interface ChatMessage {
  role: string
  content: string
}

export interface StreamChatArgs {
  provider: string
  endpoint: string
  model: string
  temperature: number
  maxTokens?: number
  apiKey?: string
  messages: ChatMessage[]
  thinkingEnabled: boolean     // v0.4.0 新增
}

export interface StreamEvent {
  content: string              // 正式输出文本
  thinking: string             // 思考过程（v0.4.0 新增）
  phase: string                // 阶段："thinking"|"answering"|"done"（v0.4.0 新增）
  done: boolean
  error?: string | null
  usage?: {
    inputTokens: number
    outputTokens: number
    inputChars: number
    outputChars: number
  } | null                     // v0.4.0 新增
}

export interface ConnectionTestResult {
  ok: boolean
  detail: string
}

export const aiApi = {
  /** RAG 语义检索 */
  async ragSearch(
    bookId: string, query: string, topN = 5,
    endpoint?: string, apiKey?: string, embeddingModel?: string,
  ) {
    return invoke<RagResult[]>('rag_search', {
      bookId, query, topN, endpoint, apiKey, embeddingModel,
    })
  },

  /** 触发 Embedding 生成 */
  async triggerEmbedding(
    bookId: string, endpoint: string, apiKey: string, embeddingModel: string,
  ): Promise<void> {
    return invoke<void>('trigger_embedding', {
      bookId, endpoint, apiKey, embeddingModel,
    })
  },

  /** 检查 Embedding 索引状态 */
  async checkEmbeddingStatus(bookId: string): Promise<EmbeddingStatus> {
    return invoke<EmbeddingStatus>('check_embedding_status', { bookId })
  },

  /** 流式 AI 对话 */
  async streamChat(args: StreamChatArgs): Promise<string> {
    return invoke<string>('stream_ai_chat', { args })
  },

  /** 测试 AI 服务连接 */
  async testConnection(
    provider: string, endpoint: string, apiKey?: string,
  ): Promise<ConnectionTestResult> {
    return invoke<ConnectionTestResult>('test_ai_connection',
      { provider, endpoint, apiKey },
    )
  },

  /** 测试 RAG 服务连接（v0.4.0 新增） */
  async testRagConnection(
    provider: string, endpoint: string, apiKey?: string,
  ): Promise<ConnectionTestResult> {
    return invoke<ConnectionTestResult>('test_rag_connection',
      { provider, endpoint, apiKey },
    )
  },
}
```

---

## 8. 样式与渲染

**文件：** `src/styles/globals.css`

### AI Markdown 消息样式

`.markdown-body` 提供完整的 Markdown 渲染样式：

```css
.markdown-body { line-height: 1.75; word-break: break-word; }
.markdown-body p { margin-bottom: 0.5em; }
.markdown-body h1-h6 { font-weight: 600; margin-top: 0.75em; margin-bottom: 0.25em; }
.markdown-body ul, .markdown-body ol { margin-bottom: 0.5em; padding-left: 1.25em; }
.markdown-body code { 
  @apply bg-muted-foreground/15 rounded px-1 py-0.5 text-xs;
  font-family: 'SF Mono', 'Fira Code', monospace; 
}
.markdown-body pre { @apply bg-muted-foreground/10 rounded-lg p-2.5 mb-2 overflow-x-auto; }
.markdown-body blockquote { @apply border-l-2 border-primary/30 pl-3 italic; }
.markdown-body table { @apply w-full mb-2 text-xs; border-collapse: collapse; }
.markdown-body th, .markdown-body td { border: 1px solid hsl(var(--border)); }
.markdown-body a { @apply text-primary underline underline-offset-2; }
.markdown-body strong { @apply font-semibold; }
.markdown-body del { @apply line-through opacity-60; }
```

---

## 9. 插件扩展点

**文件：** `src/plugins/types.ts`

AI 在插件系统中预留了 `ai-prompt` 扩展点：

```typescript
export type ExtensionPoint =
  | 'ai-prompt'         // AI 提示词模板
  | 'editor-toolbar'    // 编辑器工具栏按钮
  | 'editor-sidebar'    // 编辑器侧边栏面板
  | 'library-card'      // 书库卡片自定义操作
  | 'export-format'     // 导出格式扩展
  | 'command-palette'   // 命令面板条目
```

---

## 10. 配置文件与权限

### 10.1 HTTP 权限

**文件：** `src-tauri/capabilities/default.json`

允许 AI 请求访问任意 HTTP/HTTPS 端点：

```json
{
  "identifier": "http:allow-fetch",
  "allow": [
    { "url": "http://**" },
    { "url": "https://**" }
  ]
}
```

### 10.2 插件注册

**文件：** `src-tauri/src/lib.rs`

```rust
.plugin(tauri_plugin_http::init())
```

### 10.3 Rust 依赖

**`Cargo.toml` 相关依赖：**

- `reqwest` — HTTP 客户端（stream/json/rustls-tls/gzip/brotli/http2）
- `serde` / `serde_json` — JSON 序列化/反序列化
- `futures-util` — 异步流处理（`StreamExt`）
- `tauri` — 应用框架 + 事件推送

---

## 11. 数据模型关联

### WorldCard 向量化字段

**`src-tauri/src/models/mod.rs`：**

```rust
pub struct WorldCard {
    pub vectorized: bool,  // 是否已生成向量 embedding
    // ...
}
```

**数据库表 `world_cards`（`db/mod.rs`）：**

```sql
vectorized INTEGER NOT NULL DEFAULT 0
```

此字段用于标记已经过 Embedding 索引的卡片。

---

## 数据流总结

```
用户输入消息
  │
  ├─► RAG 检索（rag_search）
  │     ├─► 有 embedding → 调用 Embedding API 向量化 query
  │     │     └─► 余弦相似度搜索 embeddings 表 → 拼接上下文
  │     └─► 无 embedding → SQL LIKE 关键词语义搜索
  │
  ├─► 构建 messages = [system + history + user]
  │
  ├─► 注册 Tauri 事件监听 'ai-stream-chunk'
  │     ├─► phase="thinking" → 显示思考过程（可折叠）
  │     ├─► phase="answering" → 流式输出，Markdown 渲染
  │     └─► phase="done" → 输出 Token/字数用量统计
  │
  └─► stream_ai_chat(args: StreamChatArgs)
        │
        ├─► "ollama" → stream_ollama
        │     POST {endpoint}/api/chat
        │     NDJSON 逐行解析
        │     提取 message.content → emit('ai-stream-chunk', ...)
        │
        └─► "openai_compatible" → stream_openai_compatible
              POST {endpoint}/chat/completions
              SSE 逐行解析
              提取 choices[0].delta.content（正式回答）
              提取 choices[0].delta.reasoning_content（思考过程，智谱/DeepSeek）
              遇到 [DONE] → emit({ done: true, usage: {...} })
              → emit('ai-stream-chunk', ...)

前端 listen<StreamEvent> → updateAiMessage(bookId, id, patch)
  → 按 phase 渲染：thinking 折叠 / answering 流式 / done 用量统计
  → ReactMarkdown 渲染 Markdown 内容
```

---

## 文件清单总览

| 文件 | 说明 |
|------|------|
| `src-tauri/src/commands/ai.rs` | **AI 核心后端**：连接测试、RAG、Embedding、流式对话 |
| `src-tauri/src/commands/mod.rs` | 声明 `pub mod ai` |
| `src-tauri/src/lib.rs` | 注册 6 个 AI IPC 命令 + HTTP 插件 |
| `src-tauri/src/models/mod.rs` | `WorldCard.vectorized` 字段 |
| `src-tauri/src/db/mod.rs` | `world_cards` / `embeddings` 表结构 |
| `src-tauri/capabilities/default.json` | HTTP 请求权限 |
| `src/components/ai/AiSidePanel.tsx` | **AI 助手侧面板**：流式对话 UI、RAG 集成、Embedding 管理、Markdown 渲染 |
| `src/pages/SettingsPage.tsx` | **AI 设置页面**：对话配置 + RAG 独立配置 + 连接测试 |
| `src/pages/EditorPage.tsx` | 编辑器页面集成 AI 面板 |
| `src/components/editor/EditorToolbar.tsx` | 工具栏 AI 面板开关按钮 |
| `src/stores/appStore.ts` | AI 配置状态 + 对话记录 + localStorage 持久化 + 旧版迁移 |
| `src/stores/uiAtoms.ts` | `aiPanelOpenAtom` 控制面板开关 |
| `src/types/index.ts` | `AiChatConfig` / `RagConfig` / `AiMessage` / `RagResult` 类型定义 |
| `src/lib/tauri-bridge.ts` | `aiApi` IPC 桥接层（6 个方法） |
| `src/styles/globals.css` | AI 消息 Markdown 渲染样式 |
| `src/plugins/types.ts` | `ai-prompt` 扩展点定义 |
| `src-tauri/Cargo.toml` | reqwest/serde/futures-util 依赖声明 |
