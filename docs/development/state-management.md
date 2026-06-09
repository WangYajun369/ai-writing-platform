# 状态管理

TimeWrite 采用**双层状态管理**架构：Zustand 管理业务数据，Jotai 管理 UI 原子状态。

## 架构概览

```
┌─────────────────────────────────────────┐
│              Zustand (业务层)              │
│  ┌─────────────┐  ┌───────────────────┐  │
│  │  appStore    │  │   pluginStore     │  │
│  │  书籍/章节    │  │   插件安装/启停    │  │
│  │  AI 配置     │  │                   │  │
│  │  主题/字体   │  │                   │  │
│  └─────────────┘  └───────────────────┘  │
├─────────────────────────────────────────┤
│              Jotai (UI 层)                │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐   │
│  │面板   │ │保存   │ │字数   │ │专注   │   │
│  │开关   │ │状态   │ │统计   │ │模式   │   │
│  └──────┘ └──────┘ └──────┘ └──────┘   │
│  共 13 个 atom                           │
└─────────────────────────────────────────┘
```

## Zustand AppStore

### 状态字段

| 字段 | 类型 | 持久化 | 说明 |
|------|------|--------|------|
| `books` | `Book[]` | ❌ | 作品列表 |
| `currentBookId` | `string \| null` | ❌ | 当前打开作品 ID |
| `currentChapterId` | `string \| null` | ❌ | 当前编辑章节 ID |
| `volumes` | `Volume[]` | ❌ | 卷列表 |
| `chapters` | `Chapter[]` | ❌ | 章节列表 |
| `dbStatus` | `'idle' \| 'connected' \| 'error'` | ❌ | 数据库连接状态 |
| `aiConfig` | `{ chat: AiChatConfig, rag: RagConfig }` | ✅ localStorage | AI 对话与 RAG 独立配置 |
| `aiConnectionStatus` | `'idle' \| 'testing' \| 'connected' \| 'error'` | ❌ | 对话连接状态 |
| `aiConversations` | `Record<string, AiMessage[]>` | ✅ localStorage | 按 bookId 分组的对话记录 |
| `theme` | `'light' \| 'dark' \| 'system'` | ✅ localStorage | 主题 |
| `eyeCareMode` | `'off' \| 'warm' \| 'green'` | ✅ localStorage | 护眼模式 |
| `fontFamily` | `'simhei' \| 'simsun' \| 'kaiti' \| 'yahei'` | ✅ localStorage | 字体 |
| `fontSize` | `number`（12-24） | ✅ localStorage | 字号 |
| `gridSize` | `'small' \| 'medium' \| 'large'` | ✅ localStorage | 网格尺寸 |
| `editorWidth` | `'mobile' \| 'standard' \| 'wide'` | ✅ localStorage | 编辑器宽度 |
| `appVersion` | `string` | ❌ | 应用版本号（运行时获取） |
| `isLoadingBooks` | `boolean` | ❌ | 书籍加载状态 |
| `isLoadingChapters` | `boolean` | ❌ | 章节加载状态 |

### Actions
- 书籍 CRUD：`setBooks` / `addBook` / `removeBook` / `updateBook`
- 章节管理：`setChapters` / `addChapter` / `removeChapter` / `updateChapter` / `reorderChapters` / `moveChapterToVolume`
- 卷管理：`setVolumes` / `reorderVolumes`
- AI 配置：`setAiConfig` / `setAiConnectionStatus`
- AI 对话：`addAiMessage` / `updateAiMessage` / `setAiMessages` / `clearAiConversation` / `persistAiConversation`
- 主题字体：`setTheme` / `setEyeCareMode` / `setFontFamily` / `setFontSize`
- 布局偏好：`setGridSize` / `setEditorWidth`
- 编辑器状态：`saveCurrentEditorState`（恢复上次编辑位置）

## Zustand PluginStore

| 字段 | 说明 |
|------|------|
| `plugins` | 已安装插件列表 |
| 操作 | 启用/禁用/卸载 |

通过 PluginManager 单例交互。

## Jotai UI Atoms（15 个）

| atom | 说明 |
|------|------|
| `editorFocusAtom` | 编辑器是否聚焦 |
| `editorInstanceAtom` | TipTap 编辑器实例引用 |
| `sidebarOpenAtom` | 侧边栏展开状态 |
| `aiPanelOpenAtom` | AI 对话面板展开 |
| `historyPanelOpenAtom` | 版本历史面板展开 |
| `zenModeAtom` | 专注模式 |
| `isSavingAtom` | 正在保存状态 |
| `lastSavedAtom` | 最后保存时间 |
| `wordCountAtom` | 字数统计 `{ chapter, total }` |
| `searchOpenAtom` | 搜索面板 |
| `contentRefreshAtom` | 内容刷新计数器（快照恢复等场景） |
| `editorScrollPositionAtom` | 编辑器滚动位置 |
| `editorCursorPositionAtom` | 编辑器光标/选区位置 |
| `diffViewModeAtom` | Diff 对比视图模式 |
| `hoverKeywordAtom` | 悬浮速览关键词 |
| `modalStackAtom` | 模态框栈（嵌套弹窗管理） |

## 持久化策略

- **业务数据**（作品/章节/卷/快照/世界观卡片）：存储在 Rust 端 SQLite（WAL 模式），前端通过 IPC 加载
- **用户偏好**（主题/字体/字号/网格/编辑器宽度/AI 配置等）：通过 `localStorage` 持久化，启动时自动恢复
- **AI 对话记录**：按 `bookId` 分组存储在 `localStorage`，流式更新时仅写内存（高频），仅在添加/清空/整体设置时写盘
- **编辑器状态**：按 `bookId` 保存上次编辑位置（章节ID、滚动位置、光标位置），打开作品时自动恢复
- **AI 配置迁移**：自动兼容旧版扁平格式，检测并迁移为 `chat` + `rag` 解耦结构
