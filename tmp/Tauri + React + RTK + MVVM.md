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

## 五、多窗口 MVVM 状态同步方案

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

## 六、RTK Store 多窗口隔离方案

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

## 七、事件命名规范与防爆机制

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

## 八、窗口间命令调用（RPC）

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

## 九、事务 / 乐观更新 / Rollback

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

## 十、多窗口权限 & 会话隔离

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

## 十一、离线缓存 + 冲突解决

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

## 十二、测试体系（前后端对等）

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

## 十三、最终数据流（完整闭环）

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