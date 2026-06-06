# MirageInk AI 模块全面技术文档

> 生成日期：2026-06-06  
> 项目：幻境水墨 MirageInk — 跨平台小说创作工具  
> 涵盖 AI 对话、RAG 检索、流式响应、连接测试等功能

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
│  (流式对话UI + RAG)      (AI服务商/模型/温度/Key配置)       │
│       │                       │                          │
│       └───────┬───────────────┘                          │
│               │                                          │
│  appStore.ts (AiConfig 持久化到 localStorage)              │
│  uiAtoms.ts  (aiPanelOpenAtom)                           │
│  types/index.ts (AiConfig, RagResult)                    │
│  tauri-bridge.ts (aiApi: 4个IPC方法)                      │
│               │                                          │
├───────────────┼──────────────────────────────────────────┤
│            Tauri IPC 边界                                 │
├───────────────┼──────────────────────────────────────────┤
│               │                                          │
│  lib.rs ── 注册4个AI命令 ──► commands/ai.rs               │
│                                    │                     │
│                    ┌───────────────┼───────────────┐     │
│                    │               │               │     │
│            test_ai_connection  rag_search   stream_ai_chat│
│            (连接测试)          (RAG检索)    (流式对话)     │
│                    │               │               │     │
│            ┌───────┴───────┐      SQLite      ┌────┴────┐│
│            │ Ollama│OpenAI │   (LIKE降级)     │Ollama   ││
│            │ /api/tags     │                   │NDJSON   ││
│            │ /models       │                   │/api/chat││
│            └───────────────┘                   │OpenAI   ││
│                                                 │SSE      ││
│                                                 │/chat/   ││
│                                                 │completions│
│                                                 └─────────┘│
│                                                             │
│  事件推送: ai-stream-chunk → 前端 listen<StreamEvent>       │
└──────────────────────────────────────────────────────────┘
```

**关键设计决策：**

1. 流式请求完全在 Rust 端通过 `reqwest` 处理，前端只通过 Tauri 事件接收增量文本，避免了浏览器 CORS/流式解析问题
2. 支持 Ollama 原生协议和 OpenAI 兼容协议两种路径，可接入几乎所有 LLM 服务
3. RAG 目前是 SQL LIKE 降级实现，Phase 4 计划接入 `sqlite-vec` 向量检索
4. AI 配置通过 localStorage 持久化，支持 4 种服务商预设
5. 插件系统预留了 `ai-prompt` 扩展点，可扩展 AI 提示词模板

---

## 2. Rust 后端——AI 核心引擎

**文件：** `src-tauri/src/commands/ai.rs`（478 行）

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
    pub max_tokens: Option<u32>, // 最大输出 token（仅 openai_compatible）
    pub api_key: Option<String>, // API Key（仅 openai_compatible）
    pub messages: Vec<ChatMessage>, // 消息列表
}

/// 向前端推送的流式事件负载
#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    pub content: String,        // 当前累积的完整响应文本
    pub done: bool,             // 是否完成
    pub error: Option<String>, // 错误信息（仅出错时非空）
}
```

### 2.2 IPC 命令一览

| 命令 | 参数 | 返回 | 功能 |
|------|------|------|------|
| `test_ai_connection` | provider, endpoint, api_key? | `ConnectionTestResult` | 测试 AI 服务连接 |
| `rag_search` | book_id, query, top_n | `Vec<RagResult>` | RAG 语义检索 |
| `trigger_embedding` | book_id | `()` | 触发 Embedding 生成（占位） |
| `stream_ai_chat` | args: StreamChatArgs | `String` | AI 流式对话 |

### 2.3 `test_ai_connection` — 连接测试

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

```rust
async fn test_ollama_connection(
    client: reqwest::Client,
    endpoint: &str,
) -> Result<ConnectionTestResult, String> {
    let url = format!("{}/api/tags", endpoint);
    let response = client.get(&url).send().await
        .map_err(|e| format!("无法连接到 Ollama 服务: {}\n请确保 Ollama 正在运行", e))?;
    // 解析并返回模型列表 ...
}
```

#### OpenAI 兼容连接测试

- **请求：** `GET {endpoint}/models`，附带 `Authorization: Bearer {api_key}`
- **401：** 返回 "认证失败"
- **成功：** 解析 `data[].id`，限制显示前 10 个

```rust
async fn test_openai_compatible_connection(
    client: reqwest::Client,
    endpoint: &str,
    api_key: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let url = format!("{}/models", endpoint);
    let mut req = client.get(&url);
    if let Some(ref key) = api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }
    // 处理 200/401/其他状态码 ...
}
```

### 2.4 `rag_search` — RAG 检索（Phase 4 占位）

当前使用 **SQL LIKE 降级**实现关键词搜索，从 `chapters` 表中匹配 `content_html`：

```rust
#[tauri::command]
pub async fn rag_search(
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
    top_n: usize,
) -> Result<Vec<RagResult>, String> {
    let conn = db.pool.get().map_err(|e| format!("获取连接失败: {}", e))?;
    let pattern = format!("%{}%", query.chars().take(20).collect::<String>());
    let mut stmt = conn.prepare(
        "SELECT id, title, content_html FROM chapters WHERE book_id=?1 AND content_html LIKE ?2 AND deleted_at IS NULL LIMIT ?3"
    ).map_err(|e| e.to_string())?;
    // 构造 RagResult，snippet 取 content_html 前 200 个非标签字符，distance 固定 0.5
}
```

> **未来计划：** 接入 `sqlite-vec` 实现真正的向量语义检索。

### 2.5 `trigger_embedding` — Embedding 触发（占位）

```rust
#[tauri::command]
pub async fn trigger_embedding(_db: State<'_, AppDb>, book_id: String) -> Result<(), String> {
    println!("触发 Embedding 生成：book_id={}", book_id);
    Ok(())
}
```

### 2.6 `stream_ai_chat` — AI 流式对话（核心功能）

**入口函数：** 根据 `provider` 分发到 Ollama 或 OpenAI 兼容协议

```rust
#[tauri::command]
pub async fn stream_ai_chat(
    app: AppHandle,
    args: StreamChatArgs,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))  // 长文生成需要较长时间
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

```rust
async fn stream_ollama(
    app: AppHandle,
    client: reqwest::Client,
    args: StreamChatArgs,
) -> Result<String, String> {
    let url = format!("{}/api/chat", args.endpoint.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "model": args.model,
        "messages": args.messages,
        "stream": true,
        "options": { "temperature": args.temperature },
    });

    // Ollama 默认 num_predict=128，必须显式设置才能支持长文输出
    if let Some(max_tokens) = args.max_tokens {
        body["options"]["num_predict"] = serde_json::json!(max_tokens);
    } else {
        body["options"]["num_predict"] = serde_json::json!(-1); // -1 不限制
    }

    let response = client.post(&url).json(&body).send().await?;

    let mut stream = response.bytes_stream();
    let mut accumulated = String::new();
    let mut buffer = String::new();

    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                if !accumulated.is_empty() { break; } // 非关键错误
                return Err(format!("读取响应流失败: {}", e));
            }
            None => break,
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // NDJSON 按行处理
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if line.is_empty() { continue; }
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(content) = data["message"]["content"].as_str() {
                    accumulated.push_str(content);
                    // 实时推送增量到前端
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(), done: false, error: None,
                    });
                }
            }
        }
    }

    // 处理缓冲区中残留的最后一行
    // ...

    // 发送结束事件
    let _ = app.emit("ai-stream-chunk", StreamEvent {
        content: accumulated.clone(), done: true, error: None,
    });

    Ok(accumulated)
}
```

#### OpenAI 兼容流式协议（SSE 格式）

- **端点：** `POST {endpoint}/chat/completions`
- **格式：** SSE（Server-Sent Events），`data: {...}`
- **结束信号：** `data: [DONE]` 或服务端关闭连接

```rust
async fn stream_openai_compatible(
    app: AppHandle,
    client: reqwest::Client,
    args: StreamChatArgs,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", args.endpoint.trim_end_matches('/'));

    let mut req = client.post(&url).header("Content-Type", "application/json");
    if let Some(ref key) = args.api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let mut body = serde_json::json!({
        "model": args.model,
        "messages": args.messages,
        "stream": true,
        "temperature": args.temperature,
    });
    if let Some(max_tokens) = args.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }

    let response = req.json(&body).send().await?;

    let mut stream = response.bytes_stream();
    let mut accumulated = String::new();
    let mut buffer = String::new();

    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                if !accumulated.is_empty() { break; }
                return Err(format!("读取响应流失败: {}", e));
            }
            None => break,
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // 处理完整的 SSE 行
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if line.is_empty() || !line.starts_with("data:") { continue; }

            let json_str = line[5..].trim();
            if json_str == "[DONE]" {
                let _ = app.emit("ai-stream-chunk", StreamEvent {
                    content: accumulated.clone(), done: true, error: None,
                });
                return Ok(accumulated);
            }

            if let Ok(data) = serde_json::from_str::<serde_json::Value>(json_str) {
                if let Some(delta) = data["choices"][0]["delta"]["content"].as_str() {
                    accumulated.push_str(delta);
                    let _ = app.emit("ai-stream-chunk", StreamEvent {
                        content: accumulated.clone(), done: false, error: None,
                    });
                }
            }
        }
    }

    // 处理 [DONE] 未出现但流已结束的情况
    // ...

    let _ = app.emit("ai-stream-chunk", StreamEvent {
        content: accumulated.clone(), done: true, error: None,
    });
    Ok(accumulated)
}
```

#### 两种协议对比

| 特性 | Ollama（NDJSON） | OpenAI 兼容（SSE） |
|------|------------------|---------------------|
| 端点 | `/api/chat` | `/chat/completions` |
| 增量提取 | `message.content` | `choices[0].delta.content` |
| 结束信号 | 流关闭 + 最终事件 | `[DONE]` 或流关闭 |
| Token 限制 | `num_predict`（默认 -1 不限制） | `max_tokens` |
| 认证 | 无需 | `Authorization: Bearer {key}` |
| 超时 | 120s 请求 / 30s 连接 | 同上 |

### 2.7 模块注册

**`lib.rs`（第 68–72 行）：**

```rust
// AI
commands::ai::rag_search,
commands::ai::trigger_embedding,
commands::ai::stream_ai_chat,
commands::ai::test_ai_connection,
```

**`commands/mod.rs`：**

```rust
pub mod ai;
```

---

## 3. 前端——AI 助手 UI

**文件：** `src/components/ai/AiSidePanel.tsx`（292 行）

### 3.1 组件概述

`AiSidePanel` 是 AI 对话侧面板，在编辑器右侧 384px 宽度显示。

### 3.2 消息管理

```typescript
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  loading?: boolean
}
```

- `messages` 状态管理对话历史
- 用户消息和助手消息分别左右对齐

### 3.3 系统提示词

```typescript
const systemMsg = `你是一位专业的小说创作助手。请根据用户的需求提供创作建议、续写、润色等服务。${context}`
```

### 3.4 流式对话核心流程

```typescript
async function handleSend() {
    // 1. 非 Ollama 提供者验证 API Key
    if (!isOllamaProvider && !aiConfig.apiKey) {
      alert('请先在设置中配置 API Key')
      return
    }

    // 2. 创建用户和助手消息
    const userMsg: Message = { ... }
    const assistantMsg: Message = { ... loading: true }
    setMessages((prev) => [...prev, userMsg, assistantMsg])

    // 3. RAG 检索上下文
    let context = ''
    if (currentChapter) {
      const results = await aiApi.ragSearch(
        currentChapter.bookId, userInput, 3
      ).catch(() => [])
      if (results.length > 0) {
        context = '\n\n相关背景：\n' + results.map((r) => r.snippet).join('\n---\n')
      }
    }

    // 4. 注册流式事件监听
    unlistenRef.current = await listen<StreamEvent>('ai-stream-chunk', (event) => {
      const { content, done, error } = event.payload
      if (error) {
        updateAssistant(assistantId, `⚠️ AI 响应失败：${error}`)
        setStreaming(false)
        return
      }
      updateAssistant(assistantId, content)
      if (done) setStreaming(false)
    })

    // 5. 组装消息，调用 Rust 侧流式命令
    const messages = buildMessages(context)
    const provider = isOllamaProvider ? 'ollama' : 'openai_compatible'
    const fullText = await aiApi.streamChat({
      provider, endpoint: aiConfig.endpoint, model: aiConfig.model,
      temperature: aiConfig.temperature, maxTokens: aiConfig.maxTokens,
      apiKey: aiConfig.apiKey, messages,
    })

    // 6. 兜底：用返回值更新，防止 done 事件因时序问题丢失
    updateAssistant(assistantId, fullText)
}
```

### 3.5 连接状态指示器

支持 4 种状态，分别显示不同图标和颜色：

```typescript
const statusConfig = {
  idle:     { icon: CircleIcon,     color: 'text-muted-foreground/50' },
  testing:  { icon: Loader2Icon,    color: 'text-blue-500 animate-spin' },
  connected:{ icon: CircleCheckIcon, color: 'text-green-500' },
  error:    { icon: CircleAlertIcon, color: 'text-red-500' },
}
```

### 3.6 服务商显示

```typescript
const providerLabel = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  bigmodel: '智谱',
  custom: '自定义',
}
```

### 3.7 快捷提示词

在消息为空时显示 4 个快捷提示按钮：

```typescript
['帮我续写下一段', '优化这段对话', '推演剧情走向', '分析人物性格']
```

### 3.8 消息气泡渲染

助手消息使用 `react-markdown` + `remarkGfm` 渲染，支持 GFM 语法（表格、删除线等）：

```tsx
function MessageBubble({ message }: { message: Message }) {
  return (
    <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div className={cn(
        'max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words',
        isUser ? 'bg-primary text-primary-foreground rounded-br-sm'
               : 'bg-muted text-foreground rounded-bl-sm markdown-body'
      )}>
        {message.loading ? (
          <span>思考中…</span>
        ) : isUser ? (
          message.content
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  )
}
```

### 3.9 生命周期管理

```typescript
// 组件卸载时清理事件监听，防止内存泄漏
useEffect(() => {
  return () => {
    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }
  }
}, [])

// 自动滚动到底部
useEffect(() => {
  bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
}, [messages])
```

---

## 4. 前端——设置页面

**文件：** `src/pages/SettingsPage.tsx`（第 121–270 行）

### 4.1 `AiConfigSection` 组件

#### 服务商选择

切换服务商时自动填充默认 endpoint 和 model：

```typescript
const defaults: Record<string, { endpoint; model; embeddingModel }> = {
  ollama:   { endpoint: 'http://127.0.0.1:11434',               model: 'qwen2.5:7b',  embeddingModel: 'bge-m3' },
  openai:   { endpoint: 'https://api.openai.com/v1',             model: 'gpt-4o',       embeddingModel: 'text-embedding-3-small' },
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4',  model: 'glm-4.6v',     embeddingModel: 'embedding-3' },
  custom:   { endpoint: '',                                      model: '',             embeddingModel: '' },
}
```

#### 配置项

| 配置项 | 控件 | 范围/说明 |
|--------|------|-----------|
| 服务商 | `<select>` | Ollama / OpenAI / 智谱 BigModel / 自定义 |
| API 地址 | `<input>` | 根据服务商自动填充默认值 |
| 对话模型 | `<input>` | 可自定义模型名称 |
| Embedding 模型 | `<input>` | 可自定义 Embedding 模型名称 |
| Temperature | `<input type="range">` | 0–1，步长 0.1 |
| 最大输出 Token | `<input type="number">` | 1–131072，步长 1024，默认 65536 |
| API Key | `<input type="password">` | 仅非 Ollama 时显示 |
| 测试连接 | `<button>` | 调用 `aiApi.testConnection()` |

#### 连接测试

```typescript
onTestConnection={async () => {
  setAiConnectionStatus('testing')
  try {
    const { aiApi } = await import('@/lib/tauri-bridge')
    const result = await aiApi.testConnection(
      aiConfig.provider, aiConfig.endpoint, aiConfig.apiKey,
    )
    setAiConnectionStatus(result.ok ? 'connected' : 'error', result.detail)
  } catch (err) {
    setAiConnectionStatus('error', String(err))
  }
}}
```

连接状态展示：

- `idle` — 无显示
- `testing` — 蓝色提示 + 旋转动画 "检测中…"
- `connected` — 绿色提示 + 对勾图标 + 模型列表
- `error` — 红色提示 + 警告图标 + 错误详情

---

## 5. 状态管理与类型定义

### 5.1 AI 类型定义

**文件：** `src/types/index.ts`（第 86–104 行）

```typescript
/** AI 配置 */
export interface AiConfig {
  provider: 'ollama' | 'openai' | 'bigmodel' | 'custom'
  endpoint: string
  model: string
  embeddingModel: string
  temperature: number
  maxTokens: number
  apiKey?: string
}

/** RAG 检索结果 */
export interface RagResult {
  snippet: string
  sourceType: 'chapter' | 'world_card'
  sourceId: string
  sourceTitle: string
  distance: number
}
```

### 5.2 App Store — AI 状态

**文件：** `src/stores/appStore.ts`

```typescript
// localStorage 键
const AI_CONFIG_KEY = 'mirage-ink-ai-config'

// 状态字段
interface AppState {
  aiConnectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  aiConnectionDetail: string
  aiConfig: AiConfig
  // ...
}

// 默认配置
aiConfig: {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen2.5:7b',
  embeddingModel: 'bge-m3',
  temperature: 0.7,
  maxTokens: 65536,
  ...savedAiConfig, // 从 localStorage 合并
},

// 更新 AI 配置并持久化
setAiConfig: (config) =>
  set((s) => {
    const merged = { ...s.aiConfig, ...config }
    saveAiConfig(merged)  // → localStorage.setItem(...)
    return { aiConfig: merged }
  }),

// 更新连接状态
setAiConnectionStatus: (aiConnectionStatus, aiConnectionDetail = '') =>
  set({ aiConnectionStatus, aiConnectionDetail }),
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

**文件：** `src/lib/tauri-bridge.ts`（第 150–199 行）

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
}

export interface StreamEvent {
  content: string
  done: boolean
  error?: string | null
}

export interface ConnectionTestResult {
  ok: boolean
  detail: string
}

export const aiApi = {
  /** RAG 语义检索 */
  async ragSearch(bookId: string, query: string, topN = 5) {
    return invoke<Array<{ snippet; sourceId; sourceTitle; distance }>>(
      'rag_search', { bookId, query, topN }
    )
  },

  /** 触发 Embedding 生成 */
  async triggerEmbedding(bookId: string): Promise<void> {
    return invoke<void>('trigger_embedding', { bookId })
  },

  /** 流式 AI 对话 */
  async streamChat(args: StreamChatArgs): Promise<string> {
    return invoke<string>('stream_ai_chat', { args })
  },

  /** 测试 AI 服务连接 */
  async testConnection(
    provider: string, endpoint: string, apiKey?: string
  ): Promise<ConnectionTestResult> {
    return invoke<ConnectionTestResult>('test_ai_connection',
      { provider, endpoint, apiKey }
    )
  },
}
```

---

## 8. 样式与渲染

**文件：** `src/styles/globals.css`（第 298–377 行）

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

- `reqwest` — HTTP 客户端，用于 API 请求
- `serde` / `serde_json` — JSON 序列化/反序列化
- `futures-util` — 异步流处理（`StreamExt`）
- `tauri` — 应用框架 + 事件推送

---

## 11. 数据模型关联

### WorldCard 向量化字段

**`src-tauri/src/models/mod.rs`（第 99 行）：**

```rust
pub struct WorldCard {
    pub vectorized: bool,  // 是否已生成向量 embedding
    // ...
}
```

**数据库表 `world_cards`（`db/mod.rs` 第 119 行）：**

```sql
vectorized INTEGER NOT NULL DEFAULT 0
```

此字段为 Phase 4 的语义向量检索做准备。

---

## 文件清单总览

| 文件 | 说明 |
|------|------|
| `src-tauri/src/commands/ai.rs` | **AI 核心后端**：连接测试、RAG、Embedding、流式对话 |
| `src-tauri/src/commands/mod.rs` | 声明 `pub mod ai` |
| `src-tauri/src/lib.rs` | 注册 4 个 AI IPC 命令 + HTTP 插件 |
| `src-tauri/src/models/mod.rs` | `WorldCard.vectorized` 字段 |
| `src-tauri/src/db/mod.rs` | `world_cards` 表 `vectorized` 列 |
| `src-tauri/capabilities/default.json` | HTTP 请求权限 |
| `src/components/ai/AiSidePanel.tsx` | **AI 助手侧面板**：流式对话 UI、RAG 集成、Markdown 渲染 |
| `src/pages/SettingsPage.tsx` | **AI 设置页面**：服务商/模型/Temperature/Key/连接测试 |
| `src/pages/EditorPage.tsx` | 编辑器页面集成 AI 面板 |
| `src/components/editor/EditorToolbar.tsx` | 工具栏 AI 面板开关按钮 |
| `src/stores/appStore.ts` | AI 配置状态 + localStorage 持久化 |
| `src/stores/uiAtoms.ts` | `aiPanelOpenAtom` 控制面板开关 |
| `src/types/index.ts` | `AiConfig` 和 `RagResult` 类型定义 |
| `src/lib/tauri-bridge.ts` | `aiApi` IPC 桥接层（4 个方法） |
| `src/styles/globals.css` | AI 消息 Markdown 渲染样式 |
| `src/plugins/types.ts` | `ai-prompt` 扩展点定义 |

---

## 数据流总结

```
用户输入消息
  │
  ├─► RAG 检索（rag_search）
  │     └─► SQL LIKE 搜索章节内容 → 拼接上下文
  │
  ├─► 构建 messages = [system + history + user]
  │
  ├─► 注册 Tauri 事件监听 'ai-stream-chunk'
  │
  └─► stream_ai_chat(args)
        │
        ├─► "ollama" → stream_ollama
        │     POST {endpoint}/api/chat
        │     NDJSON 逐行解析
        │     提取 message.content
        │     → emit('ai-stream-chunk', { content, done: false })
        │
        └─► "openai_compatible" → stream_openai_compatible
              POST {endpoint}/chat/completions
              SSE 逐行解析
              提取 choices[0].delta.content
              遇到 [DONE] → emit({ done: true })
              → emit('ai-stream-chunk', { content, done: false })

前端 listen<StreamEvent> → updateAssistant(id, content)
  → ReactMarkdown 渲染 Markdown 内容
```
