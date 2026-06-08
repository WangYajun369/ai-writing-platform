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
| `currentBook` | `Book \| null` | ❌ | 当前打开作品 |
| `currentChapter` | `Chapter \| null` | ❌ | 当前编辑章节 |
| `volumes` | `Volume[]` | ❌ | 卷列表 |
| `chapters` | `Chapter[]` | ❌ | 章节列表 |
| `aiConfig` | `AiConfig` | ✅ localStorage | AI 配置 |
| `aiConnectionStatus` | 枚举 | ❌ | 连接状态 |
| `theme` | 枚举 | ✅ localStorage | 主题 |
| `eyeCare` | 枚举 | ✅ localStorage | 护眼模式 |
| `fontFamily` | 枚举 | ✅ localStorage | 字体 |
| `fontSize` | number | ✅ localStorage | 字号 |
| `gridSize` | 枚举 | ✅ localStorage | 网格尺寸 |
| `editorWidth` | 枚举 | ✅ localStorage | 编辑器宽度 |

### Actions
- 书籍 CRUD：`loadBooks` / `createBook` / `updateBook` / `deleteBook`
- 章节管理：`loadChapters` / `createChapter` / `updateChapter`
- AI 配置：`setAiConfig` / `setAiConnectionStatus`
- 主题字体：`setTheme` / `setEyeCare` / `setFontFamily` / `setFontSize`

## Zustand PluginStore

| 字段 | 说明 |
|------|------|
| `plugins` | 已安装插件列表 |
| 操作 | 启用/禁用/卸载 |

通过 PluginManager 单例交互。

## Jotai UI Atoms（13 个）

| atom | 说明 |
|------|------|
| `editorFocusAtom` | 编辑器是否聚焦 |
| `sidebarOpenAtom` | 侧边栏展开状态 |
| `aiPanelOpenAtom` | AI 对话面板展开 |
| `historyPanelOpenAtom` | 版本历史面板展开 |
| `zenModeAtom` | 专注模式 |
| `isSavingAtom` | 正在保存状态 |
| `lastSavedAtom` | 最后保存时间 |
| `wordCountAtom` | 字数统计 |
| `searchOpenAtom` | 搜索面板 |
| `contentRefreshAtom` | 内容刷新计数器 |
| `diffViewModeAtom` | Diff 对比视图模式 |
| `hoverKeywordAtom` | 悬浮速览关键词 |
| `modalStackAtom` | 模态框栈 |

## 持久化策略

- **业务数据**（作品/章节/卷）：存在于 Rust 端 SQLite，前端通过 IPC 加载
- **用户偏好**（主题/字体/字号/AI 配置等）：通过 `localStorage` 持久化，启动时自动恢复
