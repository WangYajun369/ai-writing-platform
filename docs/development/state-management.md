# 状态管理

> **适用版本**：`1.0.0`　|　**最后核对**：2026-08-31

TimeWrite 采用**双层状态管理**架构：Zustand 承载业务数据，Jotai 承载 UI 瞬态。

---

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│                  Zustand（业务层）                     │
│  ┌──────────────┬──────────────┬──────────────────┐  │
│  │ booksSlice   │   aiSlice    │ preferencesSlice │  │
│  │ 书籍/卷/章节  │ AI 对话/配置  │ 主题/字体/布局    │  │
│  └──────────────┴──────────────┴──────────────────┘  │
│  ┌──────────────┐                                    │
│  │ pluginStore  │  插件启用状态                        │
│  └──────────────┘                                    │
├──────────────────────────────────────────────────────┤
│                   Jotai（UI 层，21 个 atom）           │
│  编辑器类 4 · 面板类 4 · 独立窗口 5 · 其他 8            │
├──────────────────────────────────────────────────────┤
│              useAgent（组件局部 Hook）                  │
│  Agent 消息流、服务状态、流式缓冲 —— 不进全局 store      │
└──────────────────────────────────────────────────────┘
```

**分工原则**：

- 跨页面共享且需要持久化的数据 → **Zustand**
- 单窗口内高频变化的 UI 瞬态 → **Jotai**
- 仅单个组件树使用、无需跨组件共享 → **局部 Hook**（如 `useAgent`）

---

## Zustand：Slice 模式

> v1.0.0 起，原单一 `appStore` 重构为 slice 模式。当前是**代码组织层面的拆分**，各 slice 仍合并为同一个 store 实例；拆分为完全独立的 store 属于待优化项（见 [优化报告](meta/optimization-report) 问题 3）。

| Slice | 文件 | 职责 |
|-------|------|------|
| `booksSlice` | `stores/booksSlice.ts` | 书籍/卷/章节/世界观数据的加载、CRUD、回收站、选中态 |
| `aiSlice` | `stores/aiSlice.ts` | AI 对话消息、配置、RAG、总结、连接状态 |
| `preferencesSlice` | `stores/preferencesSlice.ts` | 主题/护眼/字体/网格/编辑器宽度（localStorage 持久化） |
| `pluginStore` | `stores/pluginStore.ts` | 插件启用状态（独立 store） |

### 主要状态字段

| 字段 | 所属 Slice | 持久化 | 说明 |
|------|-----------|:---:|------|
| `books` / `volumes` / `chapters` | books | ❌ | 业务数据（真源在 SQLite） |
| `currentBookId` / `currentChapterId` | books | ❌ | 当前选中 |
| `dbStatus` | books | ❌ | 数据库连接状态 |
| `aiConfig` | ai | ✅ | `{ chat: AiChatConfig, rag: RagConfig }` |
| `aiConversations` | ai | ✅ | `Record<bookId, AiMessage[]>` |
| `aiConnectionStatus` | ai | ❌ | idle / testing / connected / error |
| `theme` / `eyeCareMode` | preferences | ✅ | 主题与护眼模式 |
| `fontFamily` / `fontSize` | preferences | ✅ | 字体（12–24px） |
| `gridSize` / `editorWidth` | preferences | ✅ | 布局偏好 |
| `plugins` | pluginStore | ❌ | 已安装插件列表 |

### 主要 Actions

- **书籍/章节**：`setBooks` / `addBook` / `removeBook` / `updateBook` / `setChapters` / `addChapter` / `removeChapter` / `updateChapter` / `reorderChapters` / `moveChapterToVolume`
- **卷**：`setVolumes` / `reorderVolumes`
- **AI**：`setAiConfig` / `setAiConnectionStatus` / `addAiMessage` / `updateAiMessage` / `setAiMessages` / `clearAiConversation` / `persistAiConversation`
- **偏好**：`setTheme` / `setEyeCareMode` / `setFontFamily` / `setFontSize` / `setGridSize` / `setEditorWidth`
- **编辑器**：`saveCurrentEditorState`（章节 ID + 滚动位置 + 光标位置）

---

## Jotai：21 个 Atom

定义于 `src/stores/uiAtoms.ts`。

### 编辑器类（4）

| atom | 类型 | 说明 |
|------|------|------|
| `editorInstanceAtom` | `Editor \| null` | TipTap 编辑器实例引用（跨组件联动） |
| `editorFocusAtom` | `boolean` | 编辑器是否聚焦 |
| `editorScrollPositionAtom` | `number` | 滚动位置（切换章节后恢复） |
| `editorCursorPositionAtom` | `{ from, to } \| null` | 光标/选区位置 |

### 面板类（4）

| atom | 类型 | 说明 |
|------|------|------|
| `sidebarOpenAtom` | `boolean` | 左侧大纲侧边栏（默认 `true`） |
| `aiPanelOpenAtom` | `boolean` | 右侧 AI 对话面板 |
| `historyPanelOpenAtom` | `boolean` | 版本历史面板 |
| `zenModeAtom` | `boolean` | 专注模式 |

### 独立窗口开关（5）

跨页面/跨窗口共享，用于主窗口按钮高亮与状态同步：

| atom | 对应窗口 |
|------|---------|
| `worldWindowOpenAtom` | 世界观资料库 |
| `historyWindowOpenAtom` | 版本历史 |
| `summaryWindowOpenAtom` | 章节总结 |
| `aiToolboxWindowOpenAtom` | AI 工具箱 |
| `debugWindowOpenAtom` | 调试控制台 |

### 其他（8）

| atom | 类型 | 说明 |
|------|------|------|
| `isSavingAtom` | `boolean` | 正在保存 |
| `lastSavedAtom` | `Date \| null` | 最后保存时间 |
| `wordCountAtom` | `{ chapter, total }` | 字数统计 |
| `searchOpenAtom` | `boolean` | 搜索面板 |
| `contentRefreshAtom` | `number` | 内容刷新计数器（快照恢复等场景） |
| `diffViewModeAtom` | `DiffViewMode` | Diff 对比视图模式（默认 `side-by-side`） |
| `hoverKeywordAtom` | `string \| null` | 悬浮速览关键词 |
| `modalStackAtom` | `string[]` | 模态框栈（嵌套弹窗管理） |

---

## useAgent：Agent 局部状态

Agent 面板的状态**不进入全局 store**，由 `components/agent/useAgent.ts` 以局部 Hook 管理：

| 状态/方法 | 说明 |
|----------|------|
| `status` | `stopped` / `starting` / `running` / `crashed` |
| `messages` | `AgentMessage[]`（role / content / skill / isStreaming / error） |
| `isStreaming` | 是否正在接收流式输出 |
| `error` | 错误信息 |
| `startAgent()` / `stopAgent()` | 启停 Python 子进程 |
| `executeSkill(skill, bookId, message, history)` | 执行技能（生成 requestId，注入 aiConfig） |
| `cancelSkill()` | 取消任务 |
| `clearMessages()` | 清空对话 |

**流式渲染优化**：监听 Tauri 事件 `agent-stream-chunk`，按 `requestId` 过滤，用 `requestAnimationFrame` 合并高频 chunk 后批量更新 UI，避免大量重渲染。

> Agent 数据不持久化的原因：对话历史与记忆均由 Python 侧 `memory/` 模块持久化到 SQLite，前端重启后可从记忆恢复上下文。

---

## 持久化策略

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| 业务数据（书籍/卷/章/快照/世界观卡片） | SQLite（Rust 管理） | **真源在后端**，前端 Zustand 仅为缓存 |
| AI 对话记录 | `localStorage` | 按 `bookId` 分组；流式更新仅写内存，流结束后一次性写盘 |
| AI 配置 / 偏好设置 | `localStorage` | 应用启动时恢复，自动兼容旧版格式迁移 |
| 编辑器状态（章节/滚动/光标） | `localStorage` | 按 `bookId` 保存，打开作品时恢复 |
| Agent 记忆 | SQLite（`agent/data/agent_memory.db`） | Python 侧管理，跨会话持久 |
| UI 瞬态（Jotai） | 仅内存 | **不持久化** |

### AI 对话写盘时机

| 操作 | 是否写盘 |
|------|:---:|
| `addAiMessage` | ✅ 立即 |
| `updateAiMessage`（流式高频） | ❌ 仅内存 |
| `persistAiConversation`（流结束） | ✅ 一次写入 |
| 删除 / 清空 | ✅ 立即 |

> 这是针对流式场景的关键优化：每秒数十次的增量更新若每次都序列化整个 conversations 对象，会造成严重的写放大。

### 配置迁移

| 迁移项 | 说明 |
|--------|------|
| 旧版扁平 `AiConfig` → `chat` / `rag` 分离 | 自动检测缺失嵌套并转换 |
| 旧版 `apiKey` → `bigmodelApiKey` / `deepseekApiKey` | 统一 Key 自动复制到两个服务商 |
| 旧版 `aiToolPrompts` → `aiToolCategories` | 单层工具列表迁移到「自定义」分类 |
| `contextWindowSize` 缺失 | 补默认值 `10` |

---

## 相关文档

- [项目结构](development/project-structure)
- [AI 模块架构](architecture/AI-architecture) — AI 类型定义与配置结构
- [Agent 架构](architecture/agent-architecture) — Agent 数据流
