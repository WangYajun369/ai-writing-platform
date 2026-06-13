# 03 — 多窗口 Store 隔离与状态管理

## 3.1 问题背景

RTK Store 在浏览器环境中默认是全局单例。Tauri 多窗口场景下，每个窗口拥有独立的 WebView 实例和 JavaScript 上下文，天然无法共享 Store。这是**特性而非限制**——多窗口共享 Store 会带来状态漂移、竞态条件、内存泄漏等严重问题。

## 3.2 隔离架构

```
Tauri 进程
├── WebView #1 (Window A)
│   ├── React Root A
│   ├── RTK Store A
│   └── windowLabel = "editor-1"
│
├── WebView #2 (Window B)
│   ├── React Root B
│   ├── RTK Store B
│   └── windowLabel = "outline"
│
└── Rust Application
    ├── SQLite (唯一真理源)
    ├── Event Bus (跨窗口同步)
    └── SessionManager (窗口 → 会话映射)
```

## 3.3 Store 创建规范

### 3.3.1 Store 工厂函数

```typescript
// stores/createStore.ts
import { configureStore } from '@reduxjs/toolkit';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { articlesReducer } from '../modules/articles/view-models/articlesSlice';
import { projectReducer } from '../modules/projects/view-models/projectSlice';
import { appReducer } from './appSlice';

export function createAppStore() {
  const windowLabel = getCurrentWindow().label;

  return configureStore({
    reducer: {
      app: appReducer,
      articles: articlesReducer,
      projects: projectReducer,
    },
    preloadedState: {
      app: {
        windowLabel,
        windowType: inferWindowType(windowLabel),
        isOnline: true,
      },
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          // Tauri IPC 载荷可能包含非可序列化数据
          ignoredActions: ['persist/REHYDRATE'],
        },
      }),
  });
}

function inferWindowType(label: string): AppState['windowType'] {
  if (label.startsWith('editor')) return 'editor';
  if (label.startsWith('outline')) return 'outline';
  if (label.startsWith('preview')) return 'preview';
  return 'main';
}
```

### 3.3.2 窗口入口文件

每个窗口需要独立的入口文件：

```typescript
// main.editor.tsx  — 编辑器窗口入口
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { createAppStore } from './stores/createStore';
import { EditorApp } from './EditorApp';

const store = createAppStore();
const root = createRoot(document.getElementById('root')!);

root.render(
  <Provider store={store}>
    <EditorApp />
  </Provider>
);
```

```typescript
// main.outline.tsx  — 大纲窗口入口
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { createAppStore } from './stores/createStore';
import { OutlineApp } from './OutlineApp';

const store = createAppStore();
createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <OutlineApp />
  </Provider>
);
```

### 3.3.3 Tauri 配置文件

```json
// src-tauri/tauri.conf.json (windows 部分)
{
  "windows": [
    {
      "label": "main",
      "title": "MirageInk",
      "url": "index.html",
      "width": 1200,
      "height": 800
    },
    {
      "label": "editor-1",
      "title": "编辑器",
      "url": "src/editor.html",
      "width": 900,
      "height": 700,
      "visible": false
    },
    {
      "label": "outline",
      "title": "大纲",
      "url": "src/outline.html",
      "width": 400,
      "height": 600,
      "visible": false
    }
  ]
}
```

## 3.4 Store 生命周期

```
创建窗口
  │
  ├─ WebView 初始化
  │    └─ createAppStore() ← 注入 windowLabel
  │         └─ React Root mount
  │
  ├─ Store 活跃期
  │    ├─ 接收 Tauri Events → dispatch
  │    ├─ 用户交互 → dispatch → invoke
  │    └─ 接收 invoke 结果 → update state
  │
  └─ 窗口关闭
       ├─ 清理 Event listeners
       ├─ React Root unmount
       └─ Store 随 WebView 销毁（GC）
```

**关键保证**：
- Store 不存在于 WebView 之外，窗口关闭自动回收
- 不存在跨窗口的 Store 引用，杜绝内存泄漏
- 每个 Store 的中间件和订阅独立，互不影响

## 3.5 领域数据同步模式

窗口隔离 + 事件同步 的组合：

```
Window A: dispatch(updateContent(...))
  ↓ invoke('article:save', { article })
Rust: BEGIN TRANSACTION → UPDATE → COMMIT
  ↓ emit('article:article:updated', payload)

Window B: listen('article:article:updated')
  ↓ dispatch(articleUpdated(payload))
Window B UI 自动刷新
```

## 3.6 Slice 设计规范

### 3.6.1 模块化 Slice

每个业务模块的 Slice 只管理该模块的状态：

```typescript
// modules/articles/view-models/articlesSlice.ts
interface ArticlesState {
  items: Record<string, ArticleDTO>;
  activeId: string | null;
  loadingStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  // 窗口级状态
  editorScrollPosition: number;       // 不跨窗口
  editorFontSize: number;             // 不跨窗口
  // 领域数据（可跨窗口同步）
  lastSyncVersion: number;
}

// Reducer: 仅处理窗口本地事件
const articlesSlice = createSlice({
  name: 'articles',
  initialState,
  reducers: {
    // 跨窗口同步 —— 外部事件触发
    articleUpserted(state, action: PayloadAction<ArticleDTO>) {
      state.items[action.payload.id] = action.payload;
    },
    articleDeleted(state, action: PayloadAction<string>) {
      delete state.items[action.payload];
    },
    // 窗口本地 —— 仅本窗口使用
    setScrollPosition(state, action: PayloadAction<number>) {
      state.editorScrollPosition = action.payload;
    },
  },
});
```

### 3.6.2 Slice 分类

| 类别         | 示例                    | 跨窗口同步 |
| ------------ | ----------------------- | ---------- |
| 领域数据     | articles, projects      | 是（Event）|
| 窗口 UI 状态 | editorScroll, panelOpen | 否         |
| 会话状态     | currentUser, permissions| 否（加密存储）|
| 配置         | theme, fontSize         | 是（Event）|

## 3.7 反模式

| 反模式                                    | 后果                           |
| ----------------------------------------- | ------------------------------ |
| 在 window A 的 Store 中引用 window B 数据 | 状态泄漏、竞态                 |
| 使用 BroadcastChannel 模拟共享 Store       | 绕过 Rust 真理源，一致性问题   |
| middleware 做跨窗口 dispatch               | 循环更新、难以调试             |
| Slice 包含 `otherWindowsState` 字段        | 违背隔离原则                   |
| 窗口关闭时不清除 Event listener           | 内存泄漏                       |

## 3.8 窗口关闭时的清理

```typescript
// hooks/useWindowCleanup.ts
import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useStore } from 'react-redux';

export function useWindowCleanup() {
  const store = useStore();

  useEffect(() => {
    const window = getCurrentWindow();
    
    const unlisten = window.onCloseRequested(async () => {
      // 检查是否有未保存更改
      const state = store.getState();
      if (state.articles.isDirty) {
        // 提示用户保存
        const confirmed = await showSaveDialog();
        if (!confirmed) return; // 阻止关闭
      }
      // 清理
      unlisten();
    });

    return () => { unlisten(); };
  }, [store]);
}
```
