# Tauri + React + RTK + MVVM

# 企业级多窗口桌面应用架构

------

## 一、总体定位

> **Tauri 负责系统能力 + 数据真理源**
>
> **Rust 负责业务规则 + 持久化**
>
> **React + RTK 负责 UI + ViewModel**
>
> **MVVM 是贯穿前后端的统一架构模式**

这是一个 **跨语言 MVVM**：

```
React (View + ViewModel)
   ↕  invoke / event
Rust (Application + Domain + Infrastructure)
```

------

## 二、核心架构原则（铁律）

| 原则                 | 说明           |
| -------------------- | -------------- |
| ✅ 单一真理源         | SQLite（Rust） |
| ✅ ViewModel 不共享   | 每窗口独立     |
| ✅ UI 状态本地化      | 不跨窗口       |
| ✅ 业务规则在 Rust    | 前端只编排     |
| ✅ 同步靠事件         | 不靠轮询       |
| ✅ 权限最终裁决在后端 | Rust           |

------

## 三、MVVM 分层总览

### ✅ 前端（React + TypeScript）

| MVVM      | 实现             |
| --------- | ---------------- |
| View      | `views/`         |
| ViewModel | RTK Slice + Hook |
| Binder    | Selector + Hook  |
| Model     | DTO（来自 Rust） |

### ✅ 后端（Rust）— Clean Architecture

> Rust 侧不强行套用 MVVM 术语，使用 **Clean Architecture** 更清晰：

| 层             | 实现                 | 职责                          |
| -------------- | -------------------- | ----------------------------- |
| Domain         | Domain Struct        | 核心实体、值对象、领域规则    |
| Application   | UseCase / Service    | 编排业务逻辑、调用 Repository |
| Controller     | Command Handler      | 解析 invoke 参数、调用 UseCase |
| Infrastructure | SQLite / FS / Event  | 持久化、文件系统、事件发射    |
| Binder         | Event Emission       | 变动通知 → 前端刷新            |

**Controller ≠ ViewModel**：Command Handler 本质是控制器，接收请求并路由到 UseCase，不持有 UI 状态。前端 RTK Slice 才是真正的 ViewModel。

------

## 四、目录结构（最终形态）

```
src/                       # React 前端
├── app/
├── core/
│   ├── services/          # Tauri invoke / events
│   └── utils/
├── modules/
│   └── {module}/
│       ├── domain/        # TS DTO
│       ├── view-models/   # RTK
│       ├── views/
│       ├── components/
│       └── api/           # RTK Query（Tauri backend）
│
src-tauri/
├── src/
│   ├── domain/            # Rust Model
│   ├── application/       # UseCase / Service
│   ├── infrastructure/    # SQLite / FS
│   ├── commands/          # Tauri Commands
│   ├── events/            # 全局事件
│   └── security/          # 权限 / 会话
├── tests/                 # Rust 集成测试
```

------

## 五、FastAPI + Python AI 模块扩展

### 为什么需要 Python 层

Rust 负责核心业务与持久化，但 AI/LLM 生态集中在 Python 侧（LangChain、OpenAI SDK、Ollama 等）。通过 **FastAPI 子进程** 将 Python 作为 Rust 的 "AI 微服务"，实现最佳技术选型：

| 语言   | 角色                    | 优势                   |
| ------ | ----------------------- | ---------------------- |
| Rust   | 业务规则 + 持久化       | 安全、高性能、Tauri 原生 |
| Python | AI 推理 + Agent 编排    | 生态丰富、快速迭代     |
| TS     | UI + ViewModel          | 现代前端框架           |

### ✅ 三语言通信架构

```
┌──────────────┐   Tauri Events (SSE)    ┌───────────────┐
│  React (TS)  │ ◄─────────────────────►│   Rust Core    │
│  View+VM     │   IPC Commands           │   (Tauri App)  │
└──────────────┘                          └───┬──────┬────┘
                                              │      │
                        HTTP POST /skills/*   │      │ HTTP POST /agent/*
                        (SSE Stream, :9877)   │      │ (JSON, Bridge :9876)
                                              ▼      ▲
                                       ┌──────────────┐
                                       │  Python Agent │
                                       │  (FastAPI)    │
                                       │  Port: 9877   │──► Bridge (:9876)
                                       └──────────────┘
```

### ✅ 目录结构扩展

```
agent/                        # Python AI 服务
├── main.py                   # FastAPI 入口（uvicorn 启动）
├── config.py                 # 模型配置（云端/本地）
├── pyproject.toml            # Python 依赖管理
├── requirements.txt
├── server/
│   └── routes.py             # API 端点（/health, /skills/*, /memory/*）
├── models/
│   ├── router.py             # 双层级模型路由（Ollama 本地 + DeepSeek 云端）
│   └── factory.py            # 模型实例缓存与创建
├── skills/
│   ├── engine.py             # LangGraph Agent 执行引擎（SSE 流式）
│   ├── prompts.py            # 动态 Prompt 系统（基础+场景按需组合）
│   └── types.py              # Skill 类型定义（WRITING/ANALYSIS/RESEARCH/POLISH）
├── tools/
│   └── db_tools.py           # 6 个 LangChain Tool（通过 Bridge 回调 Rust 取数据）
├── memory/
│   ├── store.py              # SQLite 记忆存储（偏好/决策/教训）
│   ├── retriever.py          # 关键词+权重检索，Token 限制注入 Prompt
│   └── summarizer.py         # 对话历史压缩（>6 轮触发，保留最近 4 轮）
└── tracer.py                 # 独立日志（DEBUG 级别）
```

### ✅ Rust 侧进程管理

Rust 通过 `python/manager.rs` 全生命周期管理 Python 子进程：

| 阶段       | 机制                                                    |
| ---------- | ------------------------------------------------------- |
| 查找解释器 | 三级降级：用户指定 → `.venv/bin/python` → 系统 PATH     |
| 启动       | `uvicorn agent.main:app --host 127.0.0.1 --port 9877`  |
| 就绪检测   | 轮询 `/health`（500ms 间隔，最长 30s）                    |
| 看门狗     | 每 10s 检查健康，崩溃自动重启（最多 3 次）               |
| 优雅关闭   | SIGTERM → 10s 等待 → SIGKILL → 端口清理                  |
| 状态推送   | `agent-status-changed` Tauri Event → 前端实时状态           |

### ✅ API 端点设计

| 方法     | 路径                       | 用途                          |
| -------- | -------------------------- | ----------------------------- |
| `GET`    | `/health`                  | 健康检查 + 版本/模型配置      |
| `POST`   | `/skills/execute`          | 执行 Agent Skill（SSE 流式）  |
| `POST`   | `/skills/cancel`           | 取消当前任务                  |
| `GET`    | `/memory/list`             | 列出记忆（按 book_id+skill）  |
| `PUT`    | `/memory/{id}`             | 更新记忆                      |
| `DELETE` | `/memory/{id}`             | 删除记忆                      |
| `DELETE` | `/memory/clear`            | 清空记忆                      |

### ✅ Rust ↔ Python 通信协议

**Rust → Python**（HTTP POST + SSE）：

```json
POST /skills/execute
{
  "skill_type": "WRITING",
  "book_id": "book-001",
  "messages": [{ "role": "user", "content": "帮我写一段..." }],
  "conversation_summary": "之前的讨论摘要（可选）"
}

// 响应: text/event-stream
data: {"type": "chunk", "content": "好的，让我来帮你..."}
data: {"type": "done"}
```

**Python → Rust**（Bridge 回调，端口 :9876）：

```json
POST /agent/read_chapter
{ "chapter_id": "ch-001" }
→ { "data": { "id": "...", "title": "...", "content": "..." } }

POST /agent/search_world_cards
{ "query": "魔法体系", "limit": 5 }
→ { "data": [{ "name": "...", "content": "..." }] }

POST /agent/book_context
{ "book_id": "book-001" }
→ { "data": { "chapters": [...], "world_cards": [...] } }
```

> Bridge 在 Rust 侧独立线程运行（`tiny_http`），使用 `r2d2` 连接池直连 SQLite，Python 无需直接访问数据库。

### ✅ AI 能力矩阵

**4 种 Skill 类型**：

| Skill      | 模型层级     | 功能                                          |
| ---------- | ------------ | --------------------------------------------- |
| WRITING    | 云端（DeepSeek） | 大纲生成、情节建议、角色对话、冲突设计       |
| ANALYSIS   | 云端（DeepSeek） | 文风分析、连贯性检查、伏笔追踪、节奏评估     |
| RESEARCH   | 云端（DeepSeek） | 背景资料检索、世界观校验、关系图谱           |
| POLISH     | 本地（Ollama）   | 语法纠错、文笔润色、风格统一、冗余精简       |

**双层级模型路由**（`models/router.py`）：

| 层级  | 默认模型           | 端点                       | 特性                  |
| ----- | ------------------ | -------------------------- | --------------------- |
| LOCAL  | `qwen2.5:7b`       | `http://127.0.0.1:11434`  | 免费、离线、低延迟    |
| CLOUD  | `deepseek-chat`    | `https://api.deepseek.com` | 思考模式、reasoning   |

**6 个 LangChain Tool**（通过 Bridge 获取 Rust 侧数据）：

| Tool                    | 用途                          |
| ----------------------- | ----------------------------- |
| `read_chapter`           | 读取完整章节                  |
| `read_chapter_summary`   | 仅返回摘要（省 Token）        |
| `read_chapter_chunk`     | 分页读取（2000字/段）          |
| `list_book_chapters`     | 列出所有章节标题+摘要         |
| `search_world_cards`     | FTS5 全文搜索世界观卡片       |
| `get_book_context`       | 获取全书上下文（最近5章+设定）|

不同 Skill 按需加载工具子集：WRITING 不含完整读取，ANALYSIS 加载全部，POLISH 不含搜索。

**Memory 系统**：

| 记忆类型     | 权重   | 来源                    |
| ------------ | ------ | ----------------------- |
| preference   | 1.2    | 用户偏好（喜欢/讨厌）   |
| decision     | 1.0    | 决策记录                 |
| lesson       | 0.8    | 经验教训（建议/注意）    |

- 基于规则提取，不消耗额外 LLM Token
- 关键词交集打分 + 类型加权，限制检索 Token（默认 600）
- 旧记忆 0.95 衰减系数，保持上下文新鲜度

### ✅ 前端的 SSE 事件消费

```typescript
// src/modules/agent/api/agent.ts
import { listen } from '@tauri-apps/api/event';

interface StreamChunk {
  request_id: string;
  type: 'chunk' | 'done' | 'error' | 'cancelled';
  content?: string;
  error?: string;
}

listen<StreamChunk>('agent-stream-chunk', (event) => {
  if (event.payload.request_id !== currentRequestId) return;
  switch (event.payload.type) {
    case 'chunk':  appendToStream(event.payload.content!); break;
    case 'done':   finalizeStream(); break;
    case 'error':  showError(event.payload.error!); break;
  }
});
```

### ✅ 扩展新 AI 模块的步骤

1. **新增 Skill 类型**：在 `skills/types.py` 添加枚举 + `skills/prompts.py` 编写 Prompt
2. **新增 Tool**：在 `tools/db_tools.py` 定义 LangChain Tool + Bridge 端点 + Rust 侧 SQL 查询
3. **切换模型**：修改 `config.py` 中模型配置（Ollama/任何 OpenAI 兼容 API）
4. **新增记忆类型**：在 `memory/store.py` 扩展类型枚举 + 提取规则
5. **新增 API 端点**：在 `server/routes.py` 定义路由 + Rust 侧对应 IPC Command

> Python 层是 **纯 AI 微服务**，不直接访问数据库，所有数据通过 Bridge 回调 Rust 获取，保证单一真理源原则不破坏。

------

## 六、多窗口 MVVM 状态同步方案

### ✅ 同步机制

| 场景         | 方案                    |
| ------------ | ----------------------- |
| 领域数据变更 | Tauri Global Event      |
| UI 状态      | 不共享                  |
| 窗口间调用   | RPC（`invoke + reply`） |
| 会话         | Secure Store            |
| 配置         | Store + Event           |

### ✅ 事件模型

```
Rust Commit
   ↓
emit("entity:updated")
   ↓
所有窗口 listen
   ↓
dispatch → RTK
   ↓
UI 自动刷新
```

✅ **无 Redux 共享**

✅ **无状态漂移**

✅ **可预测更新**

------

## 七、RTK Store 多窗口隔离方案

### 问题

RTK Store 默认是**全局单例**，但多 Tauri 窗口中每个窗口有独立的 React Root。必须明确隔离策略。

### ✅ 方案：每窗口独立 Store

```
Tauri 窗口架构
├── Window A（React Root → Store A）
├── Window B（React Root → Store B）
└── Window C（React Root → Store C）
```

| 层级          | 实现方式                                         |
| ------------- | ------------------------------------------------ |
| React Root    | `createRoot()` 每窗口独立调用                    |
| Redux Store   | `configureStore()` 每窗口各创建一个              |
| 窗口标识      | `window.__TAURI_INTERNALS__.metadata.label`      |
| Slice 初始化  | Store 创建时注入 `windowLabel`，写入初始 state   |

### ✅ 代码示例

```typescript
// stores/index.ts
import { getCurrentWindow } from '@tauri-apps/api/window';

export function createAppStore() {
  const windowLabel = getCurrentWindow().label;

  return configureStore({
    reducer: {
      articles: articlesReducer,
      // ...
    },
    preloadedState: {
      app: { windowLabel }, // 窗口标识注入 state
    },
  });
}

// 每个窗口入口各自调用
// main.window-a.tsx
const storeA = createAppStore();
createRoot(document.getElementById('root')!).render(
  <Provider store={storeA}><App /></Provider>
);
```

### ✅ 隔离效果

| 场景             | 行为                     |
| ---------------- | ------------------------ |
| 同模块多窗口     | 各自独立 Store，互不干扰 |
| Rust 数据变更     | Tauri Event → 各自 dispatch |
| 窗口关闭         | Store 随 React Root 销毁 |
| UI 状态（弹窗等） | 绝不跨窗口泄露           |

> ⚠️ **禁止**：不要使用 `createSharedStore()` 或 `combineReducers` 跨窗口共享 Store，那是多窗口 bug 的万恶之源。

------

## 八、事件命名规范与防爆机制

### 问题

随着模块增多，Tauri Global Event 容易失控：事件名混乱、重复触发、高频事件淹没 UI。

### ✅ 事件命名规范

```
{module}:{entity}:{action}[:{scope}]
```

| 片段   | 含义                   | 示例             |
| ------ | ---------------------- | ---------------- |
| module | 业务模块               | `article`        |
| entity | 实体名                 | `article`        |
| action | 动作                   | `created/updated/deleted` |
| scope  | 可选，限定影响范围     | `window-a`       |

**示例**：

| 事件名                          | 含义                        |
| ------------------------------- | --------------------------- |
| `article:article:created`       | 文章创建                    |
| `article:draft:auto-saved`      | 草稿自动保存                |
| `project:project:renamed`       | 项目重命名                  |
| `config:theme:changed:all`      | 主题变更，所有窗口生效      |
| `sync:offline:queue:flushed`    | 离线队列刷新完成            |

### ✅ 去重机制

```rust
// Rust 侧：基于内容哈希去重，避免同一变更多次 emit
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

static RECENT_EVENTS: Lazy<Mutex<HashSet<(String, u64)>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

const DEDUP_WINDOW: Duration = Duration::from_millis(300);

pub fn emit_deduped(app: &AppHandle, event: &str, payload: &str) {
    let hash = calculate_hash(payload);
    let key = (event.to_string(), hash);
    let mut recent = RECENT_EVENTS.lock().unwrap();

    if !recent.contains(&key) {
        recent.insert(key.clone());
        let _ = app.emit(event, payload);
        // 300ms 后自动清理
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(DEDUP_WINDOW);
            RECENT_EVENTS.lock().unwrap().remove(&key);
        });
    }
}
```

### ✅ 批量合并（Debounce）

高频操作（如打字、拖拽）必须节流，前端监听也应去抖动：

```typescript
// 前端 listen 侧：100ms 内的多次更新合并为一次 dispatch
import { debounce } from 'lodash';

const dispatchUpdate = debounce(
  (payload: ArticlePayload) => store.dispatch(articleUpdated(payload)),
  100,
  { leading: false, trailing: true }
);

listen<ArticlePayload>('article:article:updated', (event) => {
  dispatchUpdate(event.payload);
});
```

### ✅ 事件分级

| 级别     | 频率          | 传输方式       | 示例              |
| -------- | ------------- | -------------- | ----------------- |
| L1 低频  | < 1次/秒      | 即时 emit      | 创建、删除、改名  |
| L2 中频  | 1-10次/秒     | Debounce 100ms | 批量导入进度      |
| L3 高频  | > 10次/秒     | 仅 emit 窗口内 | 打字/拖拽/滚动    |

> L3 高频事件**绝不**通过 Global Event 广播，只在当前窗口本地处理。

------

## 九、窗口间命令调用（RPC）

### ✅ 能力

- 同步调用
- 超时控制
- 错误处理
- 权限校验

### ✅ 架构

```
Window A → invoke → Rust
                  ↓
          route to Window B
                  ↓
         emit_and_wait()
                  ↓
Window A ← reply ← Window B
```

✅ 适合 **模态窗口 / 审批 / 选择结果**

------

## 十、事务 / 乐观更新 / Rollback

### ✅ 分层责任

| 层        | 职责          |
| --------- | ------------- |
| Rust      | SQLite 事务   |
| ViewModel | 乐观更新      |
| RTK       | 状态快照      |
| Event     | Rollback 触发 |

### ✅ 流程

```
UI dispatch (optimistic)
   ↓
Rust BEGIN
   ↓
Commit / Fail
   ↓
Success → emit
Fail    → rollback event
```

✅ **用户体验优先**

✅ **数据一致性兜底**

------

## 十一、多窗口权限 & 会话隔离

### ✅ 设计

| 层级     | 实现                  |
| -------- | --------------------- |
| 用户会话 | Rust `SessionManager` |
| 权限模型 | RBAC / Policy         |
| 窗口隔离 | Label + Context       |
| 数据隔离 | Row-level security    |

### ✅ 执行顺序

```
Invoke
 ↓
Session 解析
 ↓
Permission Check
 ↓
Business Logic
```

✅ **前端只做 UI 适配**

✅ **Rust 是最终裁判**

------

## 十二、离线缓存 + 冲突解决

### ✅ 存储结构

| 层          | 作用     |
| ----------- | -------- |
| SQLite      | 主数据   |
| Local Cache | 离线可用 |
| Dirty Flag  | 待同步   |
| Timestamp   | 冲突判断 |

### ✅ 冲突策略

| 策略            | 场景     |
| --------------- | -------- |
| Last Write Wins | 简单业务 |
| 手动解决        | 关键数据 |
| 三路合并        | 高级场景 |

### ✅ 同步流程

```
Offline Write → Cache
   ↓
Online Detected
   ↓
Diff + Merge
   ↓
Commit / Conflict UI
```

------

## 十三、测试体系（前后端对等）

| 层            | 测试类型              | 工具                      |
| ------------- | --------------------- | ------------------------- |
| Rust Domain   | Unit Test             | `#[test]`                 |
| Rust UseCase  | Integration Test      | `#[test]` + 真实 SQLite   |
| Tauri Command | Integration Test      | `tauri::test`             |
| ViewModel     | Integration Test      | `vitest` + RTK mock       |
| Component     | Component Test        | `vitest` + React Testing  |
| View / E2E    | End-to-End            | `@tauri-apps/webdriver`   |

### ✅ E2E 测试说明

Tauri 是原生桌面应用，不能用浏览器的 Playwright。正确方案：

| 方案                     | 适用场景                     |
| ------------------------ | ---------------------------- |
| `@tauri-apps/webdriver`  | 官方 WebDriver，启动真实应用 |
| 自定义 Tauri Driver      | 直接调用 Command + 截图对比  |
| `rusty-tester`（社区）   | 轻量级 Rust 端 E2E           |

✅ **每一层可独立测试**

✅ **不依赖 UI 跑业务测试**

------

## 十四、最终数据流（完整闭环）

```
Window A 修改
 ↓ optimistic UI
 ↓ invoke()
Rust UseCase
 ↓ SQLite Transaction
 ↓ emit(event)
Window B / C 刷新
 ↓
失败 → rollback event
 ↓
UI 自动恢复
```

------

### ✅ 一句话总结

> **这是一套“像后端一样严肃的前端桌面架构”，
>
> 用 MVVM 把 React、Tauri、Rust、SQLite 串成一个可维护、可扩展、可测试的工业级系统。**