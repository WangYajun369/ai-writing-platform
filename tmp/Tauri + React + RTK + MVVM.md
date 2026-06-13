# Tauri + React + RTK + MVVM

# 企业级多窗口桌面应用架构

---

## 一、定位与核心原则

### 总体定位

| 技术层        | 角色                   |
| ------------- | ---------------------- |
| Tauri         | 系统能力 + 数据真理源   |
| Rust          | 业务规则 + 持久化       |
| React + RTK   | UI + ViewModel         |
| Python        | AI 推理 + Agent 编排   |
| MVVM          | 贯穿前后端的统一架构模式 |

这是一个 **跨语言 MVVM**：

```
React (View + ViewModel)
   ↕  invoke / event
Rust (Domain + Application + Infrastructure)
   ⇄
Python (AI 微服务, FastAPI)
```

### 五大铁律

| 原则                 | 说明                             |
| -------------------- | -------------------------------- |
| 单一真理源           | SQLite（Rust 独占），前端不直接写 |
| ViewModel 不共享     | 每窗口独立 Store                 |
| UI 状态本地化        | 弹窗、滚动等不跨窗口             |
| 业务规则在 Rust      | 前端仅作编排与展示               |
| 同步靠事件           | Tauri Global Event，不轮询       |

> 权限最终裁决始终在 Rust 侧。

---

## 二、MVVM 分层总览

### 前端（React + TypeScript）

| MVVM 层   | 实现             | 说明                 |
| --------- | ---------------- | -------------------- |
| View      | `views/`         | React 组件           |
| ViewModel | RTK Slice + Hook | 状态管理 + 派生逻辑  |
| Binder    | Selector + Hook  | View ↔ ViewModel 绑定 |
| Model     | TS DTO           | 来自 Rust 的数据结构 |

### 后端（Rust）— Clean Architecture

> Rust 侧使用 Clean Architecture 分层，不强行套用 MVVM 术语。

| 层             | 实现                 | 职责                          |
| -------------- | -------------------- | ----------------------------- |
| Domain         | Domain Struct        | 核心实体、值对象、领域规则     |
| Application   | UseCase / Service    | 编排业务逻辑、调用 Repository |
| Controller     | Command Handler      | 解析 invoke 参数、调用 UseCase |
| Infrastructure | SQLite / FS / Event  | 持久化、文件系统、事件发射     |
| Binder         | Event Emission       | 数据变更 → 前端刷新            |

**关键区分**：Command Handler ≠ ViewModel。它只是请求路由器；RTK Slice 才是真正的 ViewModel。

---

## 三、目录结构

```
src/                       # React 前端
├── app/
├── core/
│   ├── services/          # Tauri invoke / events
│   └── utils/
├── modules/
│   └── {module}/
│       ├── domain/        # TS DTO
│       ├── view-models/   # RTK Slice
│       ├── views/
│       ├── components/
│       └── api/           # RTK Query（Tauri backend）

src-tauri/
├── src/
│   ├── domain/            # Rust Model
│   ├── application/       # UseCase / Service
│   ├── infrastructure/    # SQLite / FS
│   ├── commands/          # Tauri IPC Commands
│   ├── events/            # 全局事件
│   └── security/          # 权限 / 会话
├── tests/                 # Rust 集成测试

agent/                     # Python AI 服务
├── main.py                # FastAPI 入口（uvicorn）
├── config.py
├── pyproject.toml
├── server/routes.py
├── models/
│   ├── router.py          # 双层级模型路由
│   └── factory.py
├── skills/
│   ├── engine.py          # LangGraph Agent（SSE 流式）
│   ├── prompts.py
│   └── types.py
├── tools/db_tools.py      # 6 个 LangChain Tool
├── memory/
│   ├── store.py
│   ├── retriever.py
│   └── summarizer.py
└── tracer.py
```

---

## 四、多窗口 Store 隔离

RTK Store 默认全局单例，Tauri 多窗口必须显式隔离。

### 方案：每窗口独立 Store

```
Window A（React Root → Store A）
Window B（React Root → Store B）
Window C（React Root → Store C）
```

| 层级        | 实现                                    |
| ----------- | --------------------------------------- |
| React Root  | `createRoot()` 每窗口独立               |
| Redux Store | `configureStore()` 每窗口各创建         |
| 窗口标识    | `window.__TAURI_INTERNALS__.metadata.label` |

### 实现

```typescript
// stores/index.ts
import { getCurrentWindow } from '@tauri-apps/api/window';

export function createAppStore() {
  const windowLabel = getCurrentWindow().label;
  return configureStore({
    reducer: {
      articles: articlesReducer,
    },
    preloadedState: {
      app: { windowLabel },
    },
  });
}

// main.window-a.tsx —— 每个窗口入口各自调用
const storeA = createAppStore();
createRoot(document.getElementById('root')!).render(
  <Provider store={storeA}><App /></Provider>
);
```

### 隔离效果

| 场景             | 行为                         |
| ---------------- | ---------------------------- |
| 同模块多窗口     | 独立 Store，互不干扰          |
| Rust 数据变更    | Tauri Event → 各自 dispatch  |
| 窗口关闭         | Store 随 React Root 销毁      |
| UI 状态（弹窗等） | 绝不跨窗口泄露                |

> 禁止 `createSharedStore()` 或 `combineReducers` 跨窗口共享 Store。

---

## 五、窗口间事件同步

### 同步机制

| 场景         | 方案                    |
| ------------ | ----------------------- |
| 领域数据变更 | Tauri Global Event      |
| UI 状态      | 不共享                  |
| 窗口间调用   | RPC（invoke + reply）   |
| 会话         | Secure Store            |
| 配置         | Store + Event           |

### 数据流

```
Rust Commit
   ↓  emit("entity:updated")
所有窗口 listen
   ↓  dispatch → RTK
UI 自动刷新
```

- 无 Redux 跨窗口共享
- 无状态漂移
- 可预测更新

### 事件命名规范

```
{module}:{entity}:{action}[:{scope}]
```

| 片段   | 含义       | 示例              |
| ------ | ---------- | ----------------- |
| module | 业务模块   | `article`         |
| entity | 实体名     | `article`         |
| action | 动作       | `created/updated` |
| scope  | 可选范围   | `window-a`        |

**示例**：

| 事件名                          | 含义                    |
| ------------------------------- | ----------------------- |
| `article:article:created`       | 文章创建                |
| `article:draft:auto-saved`      | 草稿自动保存            |
| `project:project:renamed`       | 项目重命名              |
| `config:theme:changed:all`      | 主题变更，全局生效      |

### 防爆机制

**去重**（Rust 侧，300ms 窗口内同内容不重复 emit）：

```rust
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
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(DEDUP_WINDOW);
            RECENT_EVENTS.lock().unwrap().remove(&key);
        });
    }
}
```

**前端防抖**（100ms 合并）：

```typescript
const dispatchUpdate = debounce(
  (payload: ArticlePayload) => store.dispatch(articleUpdated(payload)),
  100,
  { leading: false, trailing: true }
);
listen<ArticlePayload>('article:article:updated', (event) => {
  dispatchUpdate(event.payload);
});
```

### 事件分级

| 级别     | 频率          | 传输方式       | 示例              |
| -------- | ------------- | -------------- | ----------------- |
| L1 低频  | < 1次/秒      | 即时 emit      | 创建、删除        |
| L2 中频  | 1-10次/秒     | Debounce 100ms | 批量导入进度      |
| L3 高频  | > 10次/秒     | 仅窗口内处理   | 打字/拖拽/滚动    |

> L3 事件绝不通过 Global Event 广播。

---

## 六、窗口间 RPC（命令调用）

```
Window A → invoke → Rust → route → Window B
                                   ↓ emit_and_wait()
Window A ← reply ───────────────────┘
```

| 特性     | 机制                           |
| -------- | ------------------------------ |
| 同步调用 | `invoke + reply`               |
| 超时     | Rust 侧计时器 + 错误返回       |
| 权限     | Session 解析 → Permission → 路由 |

适用场景：**模态窗口 / 审批 / 选择结果**。

---

## 七、事务与乐观更新

### 流程

```
UI dispatch (optimistic)
   ↓  invoke()
Rust BEGIN TRANSACTION
   ├─ Commit → emit success event
   └─ Fail   → emit rollback event
UI 自动恢复快照
```

| 层        | 职责          |
| --------- | ------------- |
| Rust      | SQLite 事务   |
| ViewModel | 乐观更新      |
| RTK       | 状态快照      |
| Event     | Rollback 触发 |

原则：**UI 优先乐观响应，Rust 兜底一致性**。

---

## 八、权限与会话隔离

### 模型

| 层级     | 实现                  |
| -------- | --------------------- |
| 用户会话 | `SessionManager`      |
| 权限     | RBAC / Policy         |
| 窗口     | Label + Context       |
| 数据     | Row-level security    |

### 执行链

```
Invoke → Session 解析 → Permission Check → Business Logic
```

前端仅做 UI 适配（隐藏按钮、禁用操作），Rust 是最终裁判。

---

## 九、离线缓存与冲突解决

### 存储结构

| 层          | 作用     |
| ----------- | -------- |
| SQLite      | 主数据   |
| Local Cache | 离线可用 |
| Dirty Flag  | 待同步   |
| Timestamp   | 冲突判断 |

### 冲突策略

| 策略            | 场景     |
| --------------- | -------- |
| Last Write Wins | 简单业务 |
| 手动解决        | 关键数据 |
| 三路合并        | 高级场景 |

### 同步流程

```
Offline Write → Cache → Online Detected → Diff + Merge → Commit / Conflict UI
```

---

## 十、测试体系

| 层            | 类型              | 工具                      |
| ------------- | ----------------- | ------------------------- |
| Rust Domain   | 单元测试          | `#[test]`                 |
| Rust UseCase  | 集成测试          | `#[test]` + 真实 SQLite   |
| Tauri Command | 集成测试          | `tauri::test`             |
| ViewModel     | 集成测试          | `vitest` + RTK mock       |
| Component     | 组件测试          | `vitest` + React Testing  |
| E2E           | 端到端            | `@tauri-apps/webdriver`   |

> Tauri 是原生桌面应用，不能用浏览器 Playwright；使用官方 WebDriver 或社区 `rusty-tester`。

每一层可独立测试，不依赖 UI 跑业务逻辑。

---

## 十一、Python AI 扩展

### 为什么需要 Python

AI/LLM 生态集中在 Python 侧（LangChain、OpenAI SDK、Ollama），通过 **FastAPI 子进程**将其作为 Rust 的 AI 微服务：

| 语言   | 角色                |
| ------ | ------------------- |
| Rust   | 业务规则 + 持久化   |
| Python | AI 推理 + Agent     |
| TS     | UI + ViewModel      |

### 三语言通信架构

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

> Bridge 在 Rust 侧独立线程运行（`tiny_http`），`r2d2` 连接池直连 SQLite。Python 不直接访问数据库，保证单一真理源原则。

### Rust 侧进程管理

Rust 通过 `python/manager.rs` 全生命周期管理 Python 子进程：

| 阶段       | 机制                                                    |
| ---------- | ------------------------------------------------------- |
| 查找解释器 | 三级降级：用户指定 → `.venv/bin/python` → 系统 PATH     |
| 启动       | `uvicorn agent.main:app --host 127.0.0.1 --port 9877`   |
| 就绪检测   | 轮询 `/health`（500ms 间隔，最长 30s）                  |
| 看门狗     | 每 10s 检查健康，崩溃自动重启（最多 3 次）              |
| 优雅关闭   | SIGTERM → 10s 等待 → SIGKILL → 端口清理                 |
| 状态推送   | `agent-status-changed` Tauri Event → 前端实时状态       |

### API 端点

| 方法     | 路径               | 用途                          |
| -------- | ------------------ | ----------------------------- |
| `GET`    | `/health`          | 健康检查 + 版本/模型配置      |
| `POST`   | `/skills/execute`  | 执行 Skill（SSE 流式）        |
| `POST`   | `/skills/cancel`   | 取消当前任务                  |
| `GET`    | `/memory/list`     | 列出记忆（按 book_id+skill）  |
| `PUT`    | `/memory/{id}`     | 更新记忆                      |
| `DELETE` | `/memory/{id}`     | 删除记忆                      |
| `DELETE` | `/memory/clear`    | 清空记忆                      |

### 通信协议

**Rust → Python**（SSE 流式）：

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

**Python → Rust**（Bridge 回调，`:9876`）：

```json
POST /agent/read_chapter  { "chapter_id": "ch-001" }
POST /agent/search_world_cards { "query": "魔法体系", "limit": 5 }
POST /agent/book_context { "book_id": "book-001" }
```

### AI 能力矩阵

**4 种 Skill**：

| Skill    | 模型           | 功能                                  |
| -------- | -------------- | ------------------------------------- |
| WRITING  | 云端 DeepSeek  | 大纲生成、情节建议、角色对话、冲突设计 |
| ANALYSIS | 云端 DeepSeek  | 文风分析、连贯性检查、伏笔追踪、节奏评估 |
| RESEARCH | 云端 DeepSeek  | 背景资料检索、世界观校验、关系图谱     |
| POLISH   | 本地 Ollama    | 语法纠错、文笔润色、风格统一、冗余精简 |

**双层级模型路由**：

| 层级  | 默认模型        | 端点                       | 特性              |
| ----- | --------------- | -------------------------- | ----------------- |
| LOCAL | `qwen2.5:7b`    | `http://127.0.0.1:11434`   | 免费、离线、低延迟 |
| CLOUD | `deepseek-chat` | `https://api.deepseek.com` | 思考模式、reasoning |

**6 个 LangChain Tool**（按 Skill 按需加载子集）：

| Tool                    | 用途                        | WRITING | ANALYSIS | RESEARCH | POLISH |
| ----------------------- | --------------------------- | ------- | -------- | -------- | ------ |
| `read_chapter`           | 读取完整章节               | ✗       | ✓        | ✓        | ✓      |
| `read_chapter_summary`   | 仅返回摘要（省 Token）     | ✓       | ✓        | ✓        | ✓      |
| `read_chapter_chunk`     | 分页读取（2000字/段）      | ✓       | ✓        | ✗        | ✗      |
| `list_book_chapters`     | 章节标题+摘要              | ✓       | ✓        | ✓        | ✓      |
| `search_world_cards`     | FTS5 全文搜索世界观        | ✗       | ✓        | ✓        | ✗      |
| `get_book_context`       | 全书上下文（最近5章+设定） | ✓       | ✓        | ✓        | ✓      |

**Memory 系统**：

| 类型       | 权重 | 来源            |
| ---------- | ---- | --------------- |
| preference | 1.2  | 用户偏好        |
| decision   | 1.0  | 决策记录        |
| lesson     | 0.8  | 经验教训        |

- 基于规则提取，不额外消耗 LLM Token
- 关键词交集打分 + 类型加权，检索 Token 上限 600
- 旧记忆 0.95 衰减系数

**前端 SSE 消费**：

```typescript
// src/modules/agent/api/agent.ts
listen<StreamChunk>('agent-stream-chunk', (event) => {
  if (event.payload.request_id !== currentRequestId) return;
  switch (event.payload.type) {
    case 'chunk':  appendToStream(event.payload.content!); break;
    case 'done':   finalizeStream(); break;
    case 'error':  showError(event.payload.error!); break;
  }
});
```

### 扩展 Checklist

1. 新增 Skill → `skills/types.py` + `skills/prompts.py`
2. 新增 Tool  → `tools/db_tools.py` + Bridge 端点 + Rust SQL
3. 切换模型 → 修改 `config.py`
4. 新增记忆 → `memory/store.py` 扩展枚举 + 提取规则
5. 新增端点 → `server/routes.py` + Rust IPC Command

---

## 十二、完整数据流

```
Window A 修改
 ↓ optimistic UI → invoke()
Rust UseCase
 ↓ SQLite Transaction
 ├─ Commit → emit(event) → Window B/C 刷新
 └─ Fail   → emit(rollback) → UI 自动恢复
```

---

## 附录 A：快速参考

| 关键词               | 定位                       |
| -------------------- | -------------------------- |
| 真理源               | Rust SQLite，前端不直接写  |
| ViewModel            | RTK Slice，每窗口独立      |
| 窗口通信             | Tauri Global Event         |
| 窗口隔离             | 独立 Store + 独立 React Root |
| AI 数据获取          | Bridge 回调，不直连 DB     |
| 高频事件             | 仅窗口内，不广播           |
| 权限                 | Rust 最终裁决              |

## 附录 B：反模式速查

| 不要做                               | 应该做                         |
| ------------------------------------ | ------------------------------ |
| `createSharedStore()` 跨窗口共享     | 每窗口独立 `configureStore()`  |
| 前端直接操作 SQLite                  | 通过 invoke → Rust             |
| Python 直连 SQLite                   | 通过 Bridge 回调 Rust          |
| L3 高频事件走 Global Event           | 仅窗口内本地处理               |
| 多窗口共享 UI 状态（弹窗/滚动）      | UI 状态严格本地化              |
| 使用浏览器 Playwright 做 E2E         | 使用 `@tauri-apps/webdriver`   |

---

> **这是一套"像后端一样严肃的前端桌面架构"，用 MVVM 把 React、Tauri、Rust、SQLite 串成一个可维护、可扩展、可测试的工业级系统。**
