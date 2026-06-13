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

### ✅ 后端（Rust）

| MVVM      | 实现                 |
| --------- | -------------------- |
| Model     | Domain Struct        |
| ViewModel | Command Handler      |
| Binder    | Event Emission       |
| Service   | UseCase / Repository |

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

## 六、窗口间命令调用（RPC）

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

## 七、事务 / 乐观更新 / Rollback

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

## 八、多窗口权限 & 会话隔离

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

## 九、离线缓存 + 冲突解决

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

## 十、测试体系（前后端对等）

| 层            | 测试类型         |
| ------------- | ---------------- |
| Rust Domain   | Unit Test        |
| Rust UseCase  | Integration Test |
| Tauri Command | Integration Test |
| ViewModel     | Integration Test |
| Component     | Component Test   |
| View          | E2E (Playwright) |

✅ **每一层可独立测试**

✅ **不依赖 UI 跑业务测试**

------

## 十一、最终数据流（完整闭环）

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