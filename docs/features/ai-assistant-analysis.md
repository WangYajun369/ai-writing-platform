# AI 助手系统深度分析

> 版本：`0.6.0` | 分析日期：2026-06-10

---

## 一、架构总览

AI 助手采用 **Rust 后端 + React/TypeScript 前端** 的分层架构，所有 HTTP 流式请求在 Rust 端通过 `reqwest` 处理，前端通过 Tauri 事件 `ai-stream-chunk` 接收增量数据。这避免了浏览器端的 CORS/流式解析问题。

```
┌─────────────────────────────────────────────────────────────┐
│                    前端 (React/TypeScript)                    │
│                                                             │
│  ┌─────────────────────┐  ┌──────────────────────────────┐ │
│  │   AiSidePanel.tsx    │  │    AiToolboxPanel.tsx        │ │
│  │   (AI 对话面板)      │  │    (AI 工具箱 三栏布局)      │ │
│  └─────────┬───────────┘  └──────────────┬───────────────┘ │
│            │                              │                  │
│  ┌─────────┴──────────────────────────────┴───────────────┐ │
│  │                   useAiChat.ts (hooks)                  │ │
│  │      流式事件监听 / RAG 管理 / Embedding 状态           │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────┴───────────────────────────────┐ │
│  │         Zustand appStore.ts (状态管理)                   │ │
│  │   aiConfig / aiConversations / aiToolCategories         │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
├────────────────────────────┼──────────────────────────────────┤
│                 Tauri IPC 边界                                │
│  ┌─────────────────────────┴───────────────────────────────┐ │
│  │             aiApi (tauri-bridge.ts) — 7 个 IPC 方法      │ │
│  │  testConnection / streamChat / ragSearch / summarize    │ │
│  │  triggerEmbedding / checkEmbeddingStatus / testRag      │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
├────────────────────────────┼──────────────────────────────────┤
│                    Rust 后端                                  │
│  ┌─────────────────────────┴───────────────────────────────┐ │
│  │          commands/ai.rs — AI 核心引擎 (~1265行)         │ │
│  │  · 流式 SSE 对话 (stream_ai_chat)                       │ │
│  │  · RAG 语义检索 (rag_search)                            │ │
│  │  · Embedding 生成 (trigger_embedding)                    │ │
│  │  · 章节总结 (summarize_chapter)                         │ │
│  │  · 连接测试 (test_ai_connection / test_rag_connection)  │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────┴───────────────────────────────┐ │
│  │              db/mod.rs — SQLite                          │ │
│  │  embeddings 表 (source_type, source_id, embedding BLOB) │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、AI 服务商配置

### 2.1 支持的对话服务商

| 服务商 | 标识 | 默认端点 | 默认模型 | 可选模型 |
|--------|------|---------|---------|---------|
| 智谱 BigModel | `bigmodel` | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.1` | `glm-5.1` |
| DeepSeek | `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` | `deepseek-v4-flash`, `deepseek-v4-pro` |

### 2.2 RAG / Embedding 服务商

RAG 仅支持**智谱 BigModel**（DeepSeek 不提供 Embeddings API）：

| 服务商 | 默认端点 | Embedding 模型 |
|--------|---------|---------------|
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `embedding-3` |

### 2.3 服务商默认配置常量

定义于 `src/components/settings/constants.ts`：

```typescript
PROVIDER_DEFAULTS = {
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1' },
  deepseek: { endpoint: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
}
RAG_PROVIDER_DEFAULTS = {
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', embeddingModel: 'embedding-3' },
}
```

### 2.4 关键特征对比

| 能力 | 智谱 BigModel | DeepSeek |
|------|:---:|:---:|
| 流式对话 | ✅ | ✅ |
| 深度思考/推理 | ✅ | ✅ |
| Embedding 向量 | ✅ (embedding-3) | ❌ |
| RAG 语义检索 | ✅ | ❌ |

---

## 三、核心功能详解

### 3.1 流式 AI 对话 (`stream_ai_chat`)

**文件**：`src-tauri/src/commands/ai.rs` (第 802-866 行)

这是 AI 助手的核心功能，实现完整的 SSE 流式对话能力。

#### 技术实现

```
用户输入 → useAiChat.handleSend() 
    ↓
1. 自动章节总结 (原文 > 300字时)
    ↓
2. RAG 语义检索 (rag.enabled 时)
    ↓
3. 注册 ai-stream-chunk 事件监听
    ↓
4. 调用 aiApi.streamChat() → invoke('stream_ai_chat')
    ↓ [Rust] 
5. reqwest HTTP POST → /chat/completions (stream: true)
    ↓ [SSE chunk 回调]
6. emit('ai-stream-chunk', StreamEvent) → 前端实时渲染
    ↓ [DONE]
7. persistAiConversation() → localStorage
```

#### Rust 端关键配置

```rust
// HTTP 客户端配置
Client::builder()
    .connect_timeout(30s)           // 连接超时
    .http1_only()                   // 仅 HTTP/1.1
    .no_gzip().no_brotli()          // 禁用自动解压 (SSE 兼容)
    .tcp_keepalive(120s)            // TCP keepalive (防止长思考期间断连)
```

#### 流式阶段管理

| 阶段 | `phase` 值 | 说明 |
|------|-----------|------|
| 思考中 | `thinking` | 正在处理 `reasoning_content`，未收到 `content` |
| 输出中 | `answering` | 收到第一个 `content` 增量后切换 |
| 重试中 | `retrying` | 网络波动，自动重试 |
| 完成 | `done` | 收到 `[DONE]` 或流自然结束 |

#### 自动重试机制

- **最多重试 2 次**，采用指数退避（1s → 2s）
- 可重试错误：timeout、connection reset、5xx、429、空内容
- 不可重试错误：401、403、404（认证/权限问题直接返回）

#### 流中断保护

- **60 秒读取超时**：无数据超过 60 秒判定为半开连接
- **Buffer 刷新**：流异常中断时，从残留 buffer 中提取最后的内容/思考/token 用量
- 保留已生成内容，向前端发送 `done` 事件并附带错误提示

---

### 3.2 RAG 语义检索 (`rag_search`)

**文件**：`src-tauri/src/commands/ai.rs` (第 294-340 行)

#### 双模式检索策略

```
                    ┌──────────────────┐
                    │  用户查询         │
                    └────────┬─────────┘
                             ↓
              ┌───────────────────────────┐
              │   embeddings 表有数据?     │
              └──────────┬────────────────┘
                    YES  │  NO
              ┌──────────┴──────────┐
              ↓                      ↓
    ┌──────────────────┐   ┌──────────────────┐
    │  向量语义搜索     │   │  SQL LIKE 降级    │
    │  (余弦相似度)    │   │  (关键词搜索)    │
    │  call_embedding() │   │  LIKE '%query%'  │
    │  cosine_similarity│   │                  │
    └──────────┬───────┘   └─────────┬────────┘
               ↓                      ↓
    ┌──────────────────────────────────────────┐
    │        返回 Top N RagResult[]             │
    │  { snippet, sourceType, sourceTitle,     │
    │    sourceId, distance }                   │
    └──────────────────────────────────────────┘
```

#### 检索范围

- **章节** (`chapters` 表，关联 `book_id`，排除软删除)
- **世界观卡片** (`world_cards` 表，关联 `book_id`)

#### 向量搜索细节

```rust
// 余弦相似度计算 (0.0 ~ 1.0)
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let (dot, na, nb) = ...;
    dot / (na.sqrt() * nb.sqrt())
}
```

- 查询向量通过 `/embeddings` API 获取
- 遍历所有已索引的章节/卡片向量，计算相似度
- 按相似度降序排列，截取 Top N
- 结果片段截取前 200 个可见字符

#### SQL LIKE 降级

- 查询词前 20 个字符构造 `LIKE '%keyword%'` 模式
- 先搜索章节，不足 Top N 时补充搜索世界观卡片
- 降级结果的 `distance` 固定为 0.5

---

### 3.3 Embedding 向量生成 (`trigger_embedding`)

**文件**：`src-tauri/src/commands/ai.rs` (第 589-731 行)

#### 生成流程

```
1. 收集源数据
   ├── 章节: SELECT id, content_html FROM chapters WHERE book_id=? AND deleted_at IS NULL
   └── 世界观卡片: SELECT id, content_html FROM world_cards WHERE book_id=?
         ↓
2. 文本预处理
   ├── strip_html() → 去除 HTML 标签
   ├── truncate_for_embedding() → 截断到 1800 字符
   └── 过滤空文本
         ↓
3. 批量调用 Embedding API
   ├── 每批最多 20 条 (BATCH_SIZE = 20)
   └── POST /embeddings { model, input: texts[] }
         ↓
4. 写入数据库
   └── INSERT OR REPLACE INTO embeddings (source_type, source_id, embedding, model)
   └── 世界观卡片额外: UPDATE world_cards SET vectorized = 1
```

#### 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `EMBEDDING_MAX_CHARS` | 1800 | 单条文本截断长度 (embedding-3 限制 3072 tokens) |
| `BATCH_SIZE` | 20 | 每批 API 调用条数 |
| 存储格式 | `f32 → LE bytes BLOB` | 向量序列化为小端字节序 |

#### 状态检查 (`check_embedding_status`)

对比数据库中的章节/卡片数量和已索引数量，判断是否为"过期"状态（`stale = true`），提示用户重新生成索引。

```rust
struct EmbeddingStatus {
    totalChapters: usize,
    totalWorldCards: usize,
    indexedChapters: usize,
    indexedWorldCards: usize,
    stale: bool,             // total > indexed 且 > 0 时为 true
}
```

---

### 3.4 章节内容总结 (`summarize_chapter`)

**文件**：`src-tauri/src/commands/ai.rs` (第 1173-1264 行)

#### 特点

- **非流式请求**（`stream: false`），返回完整总结
- 默认 System Prompt：专业小说助手，300 字内总结主要情节/事件/人物
- 支持**自定义 System Prompt**（用户可在设置中配置）
- 支持 DeepSeek 思考模式
- 返回 `ChapterSummary { summary, originalChars, summaryChars, thinking }`

#### 调用场景

1. **AI 侧面板对话**：当前章节原文 > 300 字时，自动先总结再发送给 AI
2. **章节总结面板**（独立窗口 `ChapterSummaryPanel`）：用户手动触发

#### 总结上下文注入

在 AI 侧面板对话流程中，章节总结用于：
```
原文 > 300字 → 先总结 → 将总结注入 system prompt →
"当前编辑章节「xxx」的总结（原文1200字）：\n[总结内容]"
```

好处：帮助 AI 在有限 context 窗口内更高效地理解章节内容。

---

### 3.5 连接测试

#### AI 对话连接测试 (`test_ai_connection`)

- 发送 `GET /models` 验证 API 可达性和认证
- 15 秒超时
- 成功时返回可用模型列表（最多 10 个）
- 区分错误类型：401 认证失败 vs 其他错误

#### RAG Embedding 连接测试 (`test_rag_connection`)

- 发送一条"测试连通性"文本调用 `/embeddings` API
- 成功时返回向量维度信息

---

### 3.6 AI 工具箱 (`AiToolboxPanel`)

**文件**：`src/components/ai/AiToolboxPanel.tsx`

#### 三栏布局

```
┌──────────┬────────────────────┬──────────────────────┐
│  左侧    │      中间          │      右侧            │
│ 工具列表  │    输入区域         │    生成内容展示       │
│          │                    │                      │
│ · 常用工具│  [工具名+描述]     │  [思考过程 可折叠]   │
│ · 剧情设计│  [输入框 填充]     │  [正式输出 Markdown] │
│ · 描写辅助│  [生成 按钮]       │  [用量统计]          │
│ · 世界设定│  [SystemPrompt编辑]│  [复制/清空/详情]   │
│ · 取名神器│                    │                      │
└──────────┴────────────────────┴──────────────────────┘
```

#### 预设分类与工具

| 分类 | 颜色 | 工具数量 | 包含工具 |
|------|------|:---:|------|
| 常用工具 | 蓝橙渐变 | 7 | 章节总结、小说大纲生成、章节深度润色、小说扩写、续写、润色、改写 |
| 剧情设计 | 粉白渐变 | 6 | 主线剧情设定、支线分解、剧情反转、核心冲突生成器、章节细纲、系统设定生成器 |
| 描写辅助 | 青蓝渐变 | 6 | 打斗描写、细节描写、感官描写、外貌描写、情感描写、环境/场景描写 |
| 世界设定 | 蓝绿渐变 | 5 | 世界架构设定、人物设定、势力组织架构、境界/功法等级、物品设定 |
| 取名神器 | 灰白渐变 | 5 | 人物名字定制、小说书名、古风姓名、门派势力名称、地点场景取名 |

#### 关键特性

- **自定义 System Prompt**：每个工具的 System Prompt 可独立编辑，留空使用默认提示词（`你是一位专业的小说创作助手。请根据用户需求，围绕「工具名」提供帮助。`）
- **流式生成展示**：支持思考过程折叠/展开，Markdown 渲染输出
- **请求详情查看**：可查看 System Prompt、用户输入、模型参数
- **章节总结工具**在工具箱中自动过滤（有独立窗口）
- 支持 `initialToolId` 参数，可从外部指定默认选中工具
- 所有工具和分类持久化到 localStorage

---

### 3.7 DeepSeek 思考模式

支持 DeepSeek R1 风格推理模型，在请求中注入 `thinking: { type: "enabled" }` 参数。

- 前端通过 `thinkingEnabled: boolean` 开关控制
- 仅 DeepSeek 服务商有此选项（UI 中仅在 `provider === 'deepseek'` 时显示）
- 思考过程通过 SSE `reasoning_content` 字段传递
- 前端在 `MessageBubble` 和 `AiToolboxPanel` 中以可折叠形式展示

---

## 四、配置系统详解

### 4.1 配置结构

```typescript
interface AiConfig {
  chat: {
    provider: 'bigmodel' | 'deepseek'
    endpoint: string
    model: string
    temperature: number          // 0-1, 默认 0.7
    maxTokens: number            // 默认 131072
    bigmodelApiKey?: string
    deepseekApiKey?: string
    thinkingEnabled: boolean      // 默认 true
  }
  rag: {
    enabled: boolean              // 默认 true
    provider: 'bigmodel'
    endpoint: string
    embeddingModel: string
    bigmodelApiKey?: string       // 可选，留空复用 chat 的 Key
  }
}
```

### 4.2 持久化与迁移

| 存储键 | 内容 | 位置 |
|--------|------|------|
| `time-write-ai-config` | AiConfig 对象 | localStorage |
| `time-write-ai-conversations` | `Record<bookId, AiMessage[]>` | localStorage |
| `time-write-ai-tool-categories` | `AiToolCategory[]` | localStorage |

#### 兼容性迁移

1. **旧版扁平 AiConfig → 新版 chat/rag 分离**：自动检测缺失 `chat`/`rag` 嵌套，将旧字段迁移
2. **旧版 apiKey → bigmodelApiKey/deepseekApiKey**：统一 API Key 自动复制到两个服务商
3. **旧版 aiToolPrompts → aiToolCategories**：单层工具列表迁移到"自定义"分类

### 4.3 AI 连接状态

```typescript
aiConnectionStatus: 'idle' | 'testing' | 'connected' | 'error'
aiConnectionDetail: string  // 连接详情/错误信息
```

在 `AiSidePanel` 头部以状态图标展示：
- 🟢 已连接（显示服务商名称）
- 🔴 连接失败（显示错误详情）
- ⚪ 未检测

---

## 五、消息生命周期与状态管理

### 5.1 消息类型 (`AiMessage`)

```typescript
interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string              // 推理模型的思考过程
  phase: 'thinking' | 'answering' | 'done' | 'summarizing' | 'retrying'
  isSummarizing?: boolean       // 是否正在章节总结
  loading?: boolean
  usage?: {                     // Token/字数用量
    inputTokens: number
    outputTokens: number
    inputChars: number
    outputChars: number
  } | null
  requestPayload?: ChatRequestPayload  // 原始请求载荷（详情查看）
}
```

### 5.2 发送消息的完整流程

```
handleSend(input)
  ↓
1. ADD user message (phase: 'done')
2. ADD assistant message (phase: 'summarizing', loading: true)
  ↓
3. 检查章节字数 > 300?
   ├─ YES → summarizeChapter() → 等待总结完成
   └─ NO  → 跳过
  ↓
4. UPDATE assistant → phase: 'thinking'
  ↓
5. rag.enabled?
   ├─ YES → ragSearch(bookId, query, topN=3)
   └─ NO  → 跳过
  ↓
6. 注册 listen('ai-stream-chunk') 事件监听
  ↓
7. 构建 buildMessages(system + history + user)
  ↓
8. streamChat() → invoke('stream_ai_chat')
  ↓
9. 事件回调循环:
   ├─ reasoning_content → thinking 累积 + phase: 'thinking'
   ├─ content delta → content 累积 + phase: 'answering'
   ├─ error → phase: 'done' + friendly error text
   ├─ usage → 记录用量
   └─ done → persistAiConversation()
```

### 5.3 持久化策略

- **添加消息** (`addAiMessage`)：立即写 localStorage
- **更新消息** (`updateAiMessage`)：仅更新内存，**不写 localStorage**（高频流式更新避免阻塞）
- **完成对话** (`persistAiConversation`)：流结束后一次性写入 localStorage
- **删除/清空**：立即写 localStorage

### 5.4 对话记录按作品维度管理

```
aiConversations: {
  "book-uuid-1": [message1, message2, ...],
  "book-uuid-2": [message3, message4, ...],
}
```

切换作品时通过 `useCurrentAiMessages()` 选择器自动过滤当前作品的对话。

---

## 六、用户界面组件全览

### 6.1 AiSidePanel (`src/components/ai/AiSidePanel.tsx`)

**职责**：AI 对话侧面板，编辑器右侧可拖拽区域

**组成部分**：
- **Header**：服务商状态指示器 + 清空聊天按钮
- **MessageList**：消息列表（空状态、消息气泡、自动滚动）
- **QuickHints**：快捷提示词（续写、润色、推演剧情、分析人物性格）
- **InputArea**：输入框（Shift+Enter 换行）+ Embedding 状态指示器
- **RequestDetailModal**：请求详情弹窗

### 6.2 AiToolboxPanel (`src/components/ai/AiToolboxPanel.tsx`)

**职责**：AI 工具箱，三栏布局

**组成部分**：
- **ToolListSidebar**（左侧 192px）：分类折叠/展开 + 工具选择
- **CenterInput**（中间 288px）：工具描述 + 输入区域 + 生成按钮 + System Prompt 编辑
- **OutputPanel**（右侧弹性）：思考过程 + Markdown 渲染 + 用量统计 + 复制/详情

### 6.3 MessageBubble (`src/components/ai/MessageBubble.tsx`)

**职责**：单个消息气泡渲染

**特性**：
- 用户消息：右对齐，蓝底白色，纯文本
- 助手消息：左对齐，灰底，Markdown 渲染 + 思考过程折叠
- 操作按钮：插入到编辑器、查看详情、删除（二次确认）
- 章节总结信息：可折叠展示 (原文字数 → 总结字数)
- Token / 字数用量统计
- 错误消息的"前往设置检查"按钮

### 6.4 RequestDetailModal (`src/components/ai/RequestDetailModal.tsx`)

**职责**：展示提交给 AI 的完整请求载荷

**展示内容**：
1. 请求参数（服务商、模型、Temperature、MaxTokens、思考模式）
2. System Prompt（完整内容）
3. 章节总结（总结内容 + 思考过程，含字数统计）
4. RAG 检索上下文（每条片段的来源、相关度百分比、内容）
5. 对话消息列表（用户/助手，可滚动查看）

### 6.5 ChapterSummaryHeader / ChapterSummaryPanel

**职责**：章节 AI 总结功能

- **ChapterSummaryHeader**：编辑器顶部的内联总结条
- **ChapterSummaryPanel**：独立窗口的总结面板
- 支持从 AI 工具箱中查找"章节总结"工具的 System Prompt
- 章节过短时（<50字）自动跳过
- 内容截取前 8000 字符

### 6.6 设置页面组件

| 组件 | 路径 | 职责 |
|------|------|------|
| `AiConfigSection` | `settings/AiConfigSection.tsx` | AI 对话 + RAG 配置总容器 |
| `ChatConfigSection` | `settings/ChatConfigSection.tsx` | 对话服务商/模型/Temperature/API Key/连接测试 |
| `RagConfigSection` | `settings/RagConfigSection.tsx` | RAG 开关/服务商/Embedding 模型/API Key/连接测试 |
| `AiToolboxSection` | `settings/AiToolboxSection.tsx` | AI 工具箱分类和工具管理 |

---

## 七、Tauri IPC 桥接层

**文件**：`src/lib/tauri-bridge.ts` (第 217-346 行)

### 7 个 AI 相关 IPC 方法

| 前端方法 | Rust 命令 | 参数 | 返回值 |
|---------|----------|------|--------|
| `aiApi.streamChat(args)` | `stream_ai_chat` | `StreamChatArgs` | `string` (完整内容) |
| `aiApi.ragSearch()` | `rag_search` | `bookId, query, topN, ...` | `RagResultItem[]` |
| `aiApi.checkEmbeddingStatus()` | `check_embedding_status` | `bookId` | `EmbeddingStatus` |
| `aiApi.triggerEmbedding()` | `trigger_embedding` | `bookId, endpoint, apiKey, model` | `EmbeddingProgress` |
| `aiApi.testConnection()` | `test_ai_connection` | `provider, endpoint, apiKey` | `ConnectionTestResult` |
| `aiApi.testRagConnection()` | `test_rag_connection` | `endpoint, apiKey, model` | `ConnectionTestResult` |
| `aiApi.summarizeChapter()` | `summarize_chapter` | `SummarizeArgs` | `ChapterSummary` |

### 事件通道

| 事件名 | 方向 | 载体 |
|--------|------|------|
| `ai-stream-chunk` | Rust → 前端 | `StreamEvent { content, thinking, phase, done, error, usage }` |
| `chapter-summary-done` | Rust → 前端 | `()` 空元组 |

---

## 八、Rust 后端核心引擎

**文件**：`src-tauri/src/commands/ai.rs`（约 1265 行）

### 8.1 工具函数

| 函数 | 功能 |
|------|------|
| `floats_to_bytes(v: &[f32]) → Vec<u8>` | f32 向量序列化为小端 BLOB |
| `bytes_to_floats(bytes: &[u8]) → Vec<f32>` | BLOB 反序列化为 f32 向量 |
| `cosine_similarity(a, b) → f64` | 余弦相似度（0.0 ~ 1.0） |
| `strip_html(html) → String` | 正则 `/<[^>]*>/` 去除 HTML 标签 |
| `snippet(text, max) → String` | 截取前 N 个可见字符 |
| `truncate_for_embedding(text) → String` | 截断到 1800 字符以适应 token 限制 |
| `is_retryable_error(error) → bool` | 判断流式请求错误是否可重试 |
| `flush_sse_buffer(...)` | SSE 流中断时刷新残留 buffer |

### 8.2 流式处理细节

```
stream_sse() 循环:
  loop {
    match timeout(60s, stream.next()) {
      Ok(Some(Ok(chunk))) => {
        buffer.append(chunk)
        逐行解析:
          "data: {json}" 或 "data: [DONE]"
            → 提取 reasoning_content (thinking 阶段)
            → 提取 choices[0].delta.content (answering 阶段)
            → 提取 usage (token 统计)
      }
      Ok(Some(Err(e))) => {
        flush_sse_buffer() → 保留已有内容 → return
      }
      Ok(None) => break  // 流正常结束
      Err(_elapsed) => {  // 60s 超时
        flush_sse_buffer() → 保留已有内容 + 超时错误 → return
      }
    }
  }
```

### 8.3 数据库嵌入表

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

## 九、数据流完整链路

### 9.1 对话场景

```
React: handleSend('帮我续写下一段')
  ↓
React: addAiMessage(bookId, userMsg)
React: addAiMessage(bookId, assistantMsg)
  ↓
React: needSummary? (原始字数 > 300)
  ├─ YES: summarizeChapter() → 等待 → chapterSummaryInfo
  └─ NO:  跳过
  ↓
React: rag.enabled?
  ├─ YES: ragSearch(bookId, query, 3) → ragResults
  └─ NO:  跳过
  ↓
React: buildMessages(system + history + user, chapterSummary, ragContext)
React: listen('ai-stream-chunk', handler)
  ↓
React: streamChat({
  provider: 'sse',
  endpoint, model, temperature, maxTokens, apiKey,
  thinkingEnabled, messages
})
  ↓ [Tauri IPC invoke]
Rust: stream_ai_chat(args)
  ↓
Rust: stream_sse() → POST /chat/completions
  ↓ [SSE loop]
Rust: emit('ai-stream-chunk', StreamEvent) [每个 chunk]
  ↓ [Tauri event]
React: handler → updateAiMessage(assistantId, content, thinking, phase)
  ↓ [流结束]
Rust: Ok(accumulated)
React: persistAiConversation(bookId) → localStorage
```

### 9.2 RAG 索引场景

```
React: handleGenerateEmbeddings()
  ↓
React: aiApi.triggerEmbedding(bookId, endpoint, apiKey, embeddingModel)
  ↓ [Tauri IPC]
Rust: trigger_embedding()
  ↓
  1. 收集 source items (chapters + world_cards)
  2. 文本预处理 (strip_html + 截断到 1800 字符)
  3. 批量 call_embedding_api() (每批 20 条)
  4. INSERT INTO embeddings (source_type, source_id, embedding, model)
  ↓
Rust: Ok(EmbeddingProgress)
  ↓
React: refreshEmbeddingStatus() → 更新 UI
```

---

## 十、关键设计决策与评价

### 10.1 优点

| 方面 | 评价 |
|------|------|
| **架构分离** | Rust 处理 HTTP/SSE，前端仅处理 UI，避免浏览器 CORS/流式解析问题 |
| **流中断保护** | 60s 超时 + buffer 刷新 + 保留部分内容，用户体验友好 |
| **自动重试** | 区分可重试/不可重试错误，指数退避，减少用户干预 |
| **双检索模式** | 向量语义搜索 → LIKE 关键词降级，保证 RAG 始终可用 |
| **章节智能总结** | 原文 > 300 字自动总结，节省 context token 同时保留关键信息 |
| **多维度配置** | 对话/RAG 解耦，服务商独立 API Key，工具箱可扩展 |
| **持久化可靠** | 高频更新不写 localStorage，流结束后一次性持久化 |
| **迁移兼容** | 自动检测旧版配置格式并迁移，用户无感知升级 |
| **请求透明** | RequestDetailModal 展示完整请求载荷，方便调试和信任 |
| **思考模式** | 支持推理模型的 reasoning_content 展示，提升 AI 可解释性 |

### 10.2 潜在优化方向

| 方向 | 现状 | 建议 |
|------|------|------|
| **Provider 扩展性** | 仅支持 2 个服务商，硬编码在配置中 | 考虑插件化或配置驱动的 Provider 注册机制 |
| **Embedding 服务商** | 仅智谱，写死 `bigmodel` | 可支持 OpenAI embeddings、本地模型等 |
| **RAG 检索效率** | 全量内存计算余弦相似度 | 内容量大后可考虑向量索引（如 faiss-rust） |
| **流式断点续传** | 断连后只能保留已生成内容 | 思考模式长耗时场景可考虑真正的断点续传 |
| **对话上下文管理** | 全量发送历史消息，无智能裁剪 | 可引入滑动窗口 / 摘要式 context 管理 |
| **API Key 轮换** | 每个服务商单 Key | 支持多 Key 负载均衡/故障转移 |
| **对话导出** | 不支持 | 添加对话导出功能（Markdown/JSON） |
| **章节总结缓存** | 每次对话都重新总结 | 可在 summary 有效期内复用缓存结果 |
| **系统默认工具** | 预设 29 个工具，不可删除/重置 | 增加"恢复默认"功能 |
| **请求参数可配置性** | Temperature 等全局设置 | 每个工具可独立覆盖参数 |

### 10.3 安全注意

- API Key 存储在 localStorage 明文，未加密
- 所有 API 通信在 Rust 侧进行，前端无法截获
- 连接测试不泄露 API Key（仅验证认证状态）

---

## 十一、相关文件索引

### 核心后端
| 文件 | 行数 | 作用 |
|------|:---:|------|
| `src-tauri/src/commands/ai.rs` | 1265 | AI 核心引擎：流式对话、RAG、Embedding、总结 |
| `src-tauri/src/lib.rs` | ~90 | 注册 7 个 AI IPC 命令 |
| `src-tauri/src/db/mod.rs` | ~ | embeddings 表定义 |

### 核心前端
| 文件 | 行数 | 作用 |
|------|:---:|------|
| `src/lib/tauri-bridge.ts` (第215-346行) | 131 | AI IPC 桥接类型和方法 |
| `src/stores/appStore.ts` | 689 | AI 状态管理 + 持久化 + 迁移 |
| `src/types/index.ts` (第99-221行) | 122 | AI 类型定义 |

### UI 组件
| 文件 | 行数 | 作用 |
|------|:---:|------|
| `src/components/ai/useAiChat.ts` | 389 | 对话 hooks：发送、RAG、Embedding |
| `src/components/ai/AiSidePanel.tsx` | 337 | AI 对话侧面板 |
| `src/components/ai/AiToolboxPanel.tsx` | 827 | AI 工具箱（三栏布局） |
| `src/components/ai/MessageBubble.tsx` | 291 | 消息气泡渲染 |
| `src/components/ai/RequestDetailModal.tsx` | 193 | 请求详情弹窗 |
| `src/components/editor/ChapterSummaryHeader.tsx` | ~200 | 章节总结面板 |

### 设置页面
| 文件 | 行数 | 作用 |
|------|:---:|------|
| `src/components/settings/AiConfigSection.tsx` | 47 | AI 配置总容器 |
| `src/components/settings/ChatConfigSection.tsx` | 162 | 对话配置 |
| `src/components/settings/RagConfigSection.tsx` | 129 | RAG 配置 |
| `src/components/settings/AiToolboxSection.tsx` | 467 | 工具箱管理 |
| `src/components/settings/constants.ts` | 27 | 服务商/模型常量 |

---

## 十二、附录

### A. 数据库表关联

```
books ──< volumes ──< chapters ──< snapshots
  │                    │
  │                    ├── embeddings (source_type='chapter')
  │                    │
  └── world_cards ─────┤
                       └── embeddings (source_type='world_card')
```

### B. 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `EMBEDDING_MAX_CHARS` | 1800 | 单条文本截断长度 |
| `BATCH_SIZE` | 20 | Embedding 批量生成批大小 |
| `MAX_RETRIES` | 2 | 流式对话最大重试次数 |
| `SSE_READ_TIMEOUT_SECS` | 60 | SSE 读取超时（秒） |
| `CHAPTER_SUMMARY_THRESHOLD` | 300 | 章节自动总结字数阈值 |
| `RAG_TOP_N` | 3 | RAG 检索返回片段数 |
| `DEFAULT_CONTEXT_WINDOW_SIZE` | 10 | 默认滑动窗口轮数 |

### C. 预设 AI 工具箱分类

```
常用工具: 章节总结、小说大纲生成、章节深度润色、小说扩写、续写、润色、改写
剧情设计: 主线剧情设定、支线剧情分解、剧情反转设定、核心冲突生成器、章节细纲生成、系统设定生成器
描写辅助: 打斗描写、细节描写、感官描写、外貌描写、情感描写、环境/场景描写
世界设定: 世界架构设定、人物设定、势力组织架构、境界/功法等级、物品设定
取名神器: 人物名字定制、小说书名、古风姓名、门派势力名称、地点场景取名
```

---

## 十三、v0.6.1 优化：滑动窗口 + 摘要式 Context

### 问题背景
原始实现中，`buildMessages()` 无差别地将所有历史消息作为 context 发送给 AI，导致：
- 随着对话增长，token 消耗线性增大
- 超长对话可能超出模型上下文窗口
- 历史消息中大量无关信息浪费 tokens

### 优化方案
引入 **滑动窗口 + 摘要压缩** 的双层 context 管理：

```
┌────────────────────────────────────────┐
│              System Prompt             │
│  — 角色指令 + 卷/章节上下文 + RAG 背景    │
│  — [历史对话摘要]（压缩的旧对话）   ← 新增   │
├────────────────────────────────────────┤
│         滑动窗口（最近 N 轮）            │
│  [user] ... [assistant] ...            │
│  [user] ... [assistant] ...            │
│  [user] (当前提问)                      │
└────────────────────────────────────────┘
```

### 核心变更

#### 1. 新增 Rust 命令 `summarize_conversation`

用于将历史对话消息压缩为精炼摘要（≤300字），支持增量总结（与已有摘要合并）：

```rust
// src-tauri/src/commands/ai.rs — 新增 ~120 行
pub async fn summarize_conversation(
    app: AppHandle,
    args: SummarizeConversationArgs,  // messages + previous_summary
) -> Result<ConversationSummary, String>
```

#### 2. 配置项 `contextWindowSize`

`AiChatConfig` 新增字段，默认值 10（保留最近 10 轮 = 20 条消息）：
```typescript
// src/types/index.ts
interface AiChatConfig {
  // ...
  contextWindowSize: number  // 默认 10，范围 1-50
}
```

#### 3. 前端 store 新增摘要状态

```typescript
// src/stores/appStore.ts
aiSummaries: Record<string, ConversationSummary>  // 按 bookId 分组，持久化到 localStorage

interface ConversationSummary {
  summary: string       // 压缩后的摘要文本
  coveredUpToId: string // 摘要覆盖的最新消息 ID
  summaryChars: number
  updatedAt: string
}
```

#### 4. `useAiChat` 核心逻辑重写

**`buildMessages()` 变更**：
- 从所有历史消息 → 仅取最近 `windowSize * 2` 条
- 将 `currentSummary.summary` 注入 system prompt（标记为 `[历史对话摘要]`）

**`summarizeOverflowMessages()` 新增**：
- 每次 AI 回答完成后（`done` 事件）触发
- 检查是否超出窗口边界
- 超出时调用 `summarize_conversation` 后台压缩（不阻塞 UI）
- 使用 `summarizingRef` 防止并发
- 幂等：`coveredUpToId` 避免重复总结

### 配置 UI
`ChatConfigSection` 新增滑动条（1-50 轮），含提示文案说明窗口机制。

### 兼容性
- 旧配置自动迁移：检测 `contextWindowSize === undefined` 时补为 `10`
- 清空对话时同步清除摘要
- 切换作品时摘要独立、互不干扰

> 文档最后更新：v0.6.1 滑动窗口 + 摘要式 context 优化。
