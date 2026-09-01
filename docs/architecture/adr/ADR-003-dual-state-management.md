# ADR-003：Zustand 管业务状态 + Jotai 管 UI 瞬态

> **状态**：已采纳
> **日期**：2026-06-03（v0.1.0）
> **影响范围**：前端

## 背景

编辑器场景的状态特征差异极大：

| 状态类型 | 例子 | 特征 |
|---------|------|------|
| 业务数据 | 书籍、章节、卷、AI 配置 | 跨页面共享、需持久化、变更频率低 |
| UI 瞬态 | 面板开关、保存中标记、光标位置、滚动位置 | 高频变更（流式期间每秒数十次）、多为单窗口内使用 |
| 独立窗口开关 | 世界观/历史/工具箱/调试窗口 | 需**跨窗口**共享，但不持久化 |

单一方案难以同时满足。

## 备选方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 单一 Redux Toolkit | 生态成熟、DevTools 强大 | 样板代码多、高频更新性能差、小状态也要走 action |
| B. 单一 Zustand | 简洁、性能好 | 高频 UI 状态写入 store 会触发大范围订阅者重渲染 |
| C. 单一 Jotai | 原子级订阅、细粒度重渲染 | 缺乏中间件生态、持久化需自行处理 |
| D. Zustand（业务）+ Jotai（UI） | 各取所长 | 两套心智模型，需要明确分工约定 |

## 决策

采用**方案 D 双轨制**，并确立分工原则：

- **跨页面共享且需持久化** → Zustand（slice 模式：`booksSlice` / `aiSlice` / `preferencesSlice` / `pluginStore`）
- **单窗口内高频变化的瞬态** → Jotai（21 个 atom，含 5 个独立窗口开关）
- **仅单个组件树使用** → 局部 Hook（如 `useAgent`）

## 理由

1. **细粒度订阅**：Jotai 的原子级订阅让「保存中」「字数」等高频状态变更只重渲染依赖它的最小组件，避免 Zustand 单 store 的广播式通知
2. **持久化简单**：Zustand 可直接在 action 中写 localStorage；UI 瞬态本就不需要持久化
3. **跨窗口共享**：Jotai atom 天然支持跨窗口同步独立窗口开关状态（`worldWindowOpenAtom` 等）
4. **迁移成本**：早期为单一 `appStore`，v1.0.0 重构为 slice 模式，逐步向独立 store 演进

## 后果

### 正面

- 流式 AI 输出的每秒数十次更新不会引发大范围重渲染
- 业务状态与 UI 状态职责清晰，易于定位问题

### 负面 / 代价

- 两套心智模型，新人需要理解分工约定
- slice 仍是代码组织层面的拆分，未实现真正的状态隔离：`useAppStore()` 的订阅粒度问题依然存在
- 类型定义（`appTypes.ts`）仍较庞大

### 需要 follow-up 的事项

- 将 slice 升级为真正独立的 store（`useBookStore` / `useAiStore` / `usePreferencesStore`），见 [优化报告](meta/optimization-report) 问题 3
- `useAiChat.ts`（483 行）职责过多，建议拆分为 `useChapterValidation` / `useChapterSummary` / `useStreamChat` / `useConversationCompression`（问题 6）
- 流式期间高频更新不写 localStorage（仅内存），流结束后一次性持久化 —— 此优化已实施，需保持
