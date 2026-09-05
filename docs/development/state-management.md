# 状态管理

> **适用版本**：`1.7.0`　|　**最后核对**：2026-09-05

TimeWrite 采用**双层状态管理**架构：Zustand 承载业务数据，Jotai 承载 UI 瞬态。

---

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│                  Zustand（业务层）                     │
│  ┌──────────────┬──────────────┬──────────────────┐  │
│  │  booksStore  │   aiStore    │ preferencesStore │  │
│  │ 书籍/卷/章节  │ AI 对话/配置  │ 主题/字体/布局    │  │
│  └──────────────┴──────────────┴──────────────────┘  │
│   （三个独立 store，经 appStore.ts 再导出 —— v1.6.0）   │
│  ┌──────────────┐                                    │
│  │ pluginStore  │  插件启用状态                        │
│  └──────────────┘                                    │
│  ┌──────────────────────────┐                        │
│  │ vocabStore / ttsConfig   │  英语字典（v1.4.0）      │
│  │ 生词数据 / 语音合成配置   │  独立 store，窗口内使用  │
│  └──────────────────────────┘                        │
│  ┌──────────────────────────┐                        │
│  │ taskCardsStore           │  任务卡（v1.5.0）        │
│  │ 项目/任务/标签/子任务     │  独立 store，窗口内使用  │
│  └──────────────────────────┘                        │
├──────────────────────────────────────────────────────┤
│              Jotai（UI 层，stores/uiAtoms.ts 21 个）    │
│  编辑器类 4 · 面板类 4 · 独立窗口 5 · 其他 8            │
│  （另 lib/toast.ts 有 2 个 toast atom，全项目合计 23）   │
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

## Zustand：领域 Store（v1.6.0 起）

> v1.0.0 起为单一 `appStore` + slice 组合（slice 仍合并为同一实例）；**v1.6.0（Phase 3 问题 3）拆分为三个真正独立的领域 store**，各自持有完整状态与 action、订阅互不干扰。`stores/appStore.ts` 保留为「领域 store 出口」：再导出三个 store，并聚合跨域便捷选择器（`useCurrentBook` / `useCurrentChapter` / `useCurrentAiMessages`）与 `getEditorState` 等工具，旧 import 路径向后兼容。

| Store | 文件 | 职责 |
|-------|------|------|
| `booksStore` | `stores/booksStore.ts` | 书籍/卷/章节/世界观数据的加载、CRUD、回收站、选中态 |
| `aiStore` | `stores/aiStore.ts` | AI 对话消息、配置、RAG、总结、连接状态（800ms 防抖持久化） |
| `preferencesStore` | `stores/preferencesStore.ts` | 主题/护眼/字体/网格/编辑器宽度（localStorage 持久化） |
| `pluginStore` | `stores/pluginStore.ts` | 插件启用状态（独立 store） |
| `vocabStore` | `stores/vocabStore.ts` | 英语生词数据：`words` / `due` / `stats` 三查询 + `refreshAll` 全量刷新（v1.4.0，独立 store） |
| `ttsConfig` | `stores/ttsConfig.ts` | 豆包语音合成配置：API Key / 音色（localStorage 持久化，独立 store） |
| `taskCardsStore` | `stores/taskCardsStore.ts` | 任务卡窗口数据：`projects` / `tags` / 任务 / 子任务 / 附件 / 模板 + 视图状态与操作（v1.5.0，独立 store，**不持久化**，数据真源在 SQLite，经 `taskCardApi` 拉取） |

### 主要状态字段

| 字段 | 所属 Store | 持久化 | 说明 |
|------|-----------|:---:|------|
| `books` / `volumes` / `chapters` | booksStore | ❌ | 业务数据（真源在 SQLite） |
| `currentBookId` / `currentChapterId` | booksStore | ❌ | 当前选中 |
| `dbStatus` | booksStore | ❌ | 数据库连接状态 |
| `aiConfig` | aiStore | ✅ | `{ chat: AiChatConfig, rag: RagConfig }` |
| `aiConversations` | aiStore | ✅ | `Record<bookId, AiMessage[]>`（800ms 防抖持久化） |
| `aiConnectionStatus` | aiStore | ❌ | idle / testing / connected / error |
| `theme` / `eyeCareMode` | preferencesStore | ✅ | 主题与护眼模式 |
| `fontFamily` / `fontSize` | preferencesStore | ✅ | 字体（12–24px） |
| `gridSize` / `editorWidth` | preferencesStore | ✅ | 布局偏好 |
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

> 英语字典窗口开关**不在** Jotai 中 —— 作为插件状态存放于 `src/plugins/dictionary/windowState.ts`（模块级布尔 + 角标计数源），避免把插件状态耦合进主程序；主窗口入口与词典窗口通过 Tauri 事件（`vocab-due-updated` 等）双向同步。
>
> 任务卡（v1.5.0）同属插件窗口：开关状态在 `src/plugins/taskCards/windowState.ts`（模块级布尔 + 今日应办角标计数源），**业务数据不持久化**在窗口内 —— 数据一律经 `taskCardApi` 查询 SQLite，任何变更后由窗口内 store 向各窗口广播 `tasks-data-updated`，首页角标 / 日历状态点 / 日记当日任务随即刷新。

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

Agent 状态**不进入全局 store**，由 `components/agent/useAgent.ts` 以局部 Hook 管理。
v1.1 起 Agent 为 Rust 原生引擎（内嵌主进程），**无启停流程**，`status` 恒为 `running`：

| 状态/方法 | 说明 |
|----------|------|
| `status` | 恒为 `'running'`（引擎内嵌 Rust，无外部进程状态机） |
| `messages` | `AgentMessage[]`（role / content / skill / isStreaming / error） |
| `isStreaming` | 是否正在接收流式输出 |
| `error` | 错误信息 |
| `executeSkill(skill, bookId, message, history)` | 执行技能 → `invoke('execute_agent_skill')`（生成 requestId，注入 aiConfig） |
| `cancelSkill()` | 取消任务 → `invoke('cancel_agent_skill')` |
| `clearMessages()` | 清空对话 |

**流式渲染优化**：监听 Tauri 事件 `agent-stream-chunk`，按 `requestId` 过滤，用 `requestAnimationFrame` 合并高频 chunk 后批量更新 UI，避免大量重渲染。

> Agent 对话为会话内临时上下文；跨会话记忆沉淀于 Rust 主库 `memories` 表（见下），由 `AgentMemoryPanel` 管理。

---

## 持久化策略

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| 业务数据（书籍/卷/章/快照/世界观卡片） | SQLite（Rust 管理） | **真源在后端**，前端 Zustand 仅为缓存 |
| AI 对话记录 | `localStorage` | 按 `bookId` 分组；800ms 防抖合并写盘 + 卸载 flush（v1.6.0） |
| AI 配置 / 偏好设置 | `localStorage` | 应用启动时恢复，自动兼容旧版格式迁移 |
| 编辑器状态（章节/滚动/光标） | `localStorage` | 按 `bookId` 保存，打开作品时恢复 |
| Agent 记忆 | SQLite（`time_write.db` 的 `memories` 表） | Rust 引擎管理；旧独立库（`agent_memory.db`）启动时自动迁移 |
| 英语生词 / 复习记录 | SQLite（`vocab_words` / `vocab_reviews` 表） | Rust 管理（SM-2 排程）；前端 `vocabStore` 仅为缓存 |
| 任务卡 / 项目 / 标签 / 子任务 / 附件 | SQLite（`projects` / `tasks` / `tags` / `task_subtasks` / `attachments` 等 10 张表） | Rust 管理；前端 `taskCardsStore` **不持久化**，仅在任务卡窗口内存缓存 |
| 任务卡提醒偏好 / 元数据 | SQLite（`task_meta` 表） | Rust 管理（key-value + 铃铛已读等） |
| TTS 语音配置 | `localStorage` | `ttsConfig` store（豆包 API Key / 音色） |
| UI 瞬态（Jotai） | 仅内存 | **不持久化** |

### AI 对话写盘时机（v1.6.0 防抖 + 兜底 flush）

| 操作 | 是否写盘 |
|------|:---:|
| `addAiMessage` | ✅ 立即 |
| `updateAiMessage`（流式高频） | ⏱️ 800ms 防抖合并后写盘（v1.6.0，取代「仅内存 + 流结束一次性写」） |
| 窗口卸载 / 页面隐藏（`beforeunload` / `visibilitychange`） | ✅ 立即 flush 剩余未落盘数据 |
| 删除 / 清空 | ✅ 立即 |

> 针对流式场景的关键优化：每秒数十次的增量更新经 800ms 防抖合并后再序列化整个 conversations 对象，避免逐条写放大；窗口关闭 / 切后台时立即 flush，杜绝打字内容丢失（离线草稿保护，Phase 3 问题 4）。

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
