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

### 3.3.4 Store 清理钩子设计（内存泄漏防护）

⚠️ **风险**：若某个 async thunk 在窗口关闭后 resolve，会导致：
- 向已销毁的 WebView 发送 IPC 请求 → 应用崩溃
- 闭包持有旧 window 引用 → 内存泄漏
- Redux middleware 继续处理已卸载组件的 action → 静默失败

**解决方案**：在 Store 创建时注册 `__TAURI_STORE_CLEANUP__` 全局钩子，窗口关闭前强制取消所有进行中的 thunk 并清理资源。

```typescript
// stores/createStore.ts (补充清理钩子)
import { configureStore } from '@reduxjs/toolkit';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createListenerMiddleware } from '@reduxjs/toolkit';

// 跟踪进行中的 async thunk
const pendingThunks = new Map<string, AbortController>();

export function createAppStore() {
  const windowLabel = getCurrentWindow().label;
  
  // 创建 listener middleware 用于跟踪 async thunk 生命周期
  const listenerMiddleware = createListenerMiddleware();
  
  const store = configureStore({
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
          ignoredActions: ['persist/REHYDRATE'],
        },
      }).prepend(listenerMiddleware.middleware),
  });
  
  // 监听 thunk pending → 注册 AbortController
  listenerMiddleware.startListening({
    predicate: (action) => action.type.endsWith('/pending'),
    effect: (action, listenerApi) => {
      const abortController = new AbortController();
      pendingThunks.set(action.meta.requestId, abortController);
      
      // 将 abortController.signal 注入到 thunk extra 参数中
      // （需在 async thunk 中读取 abortController.signal）
    },
  });
  
  // 监听 thunk fulfilled/rejected → 清理
  listenerMiddleware.startListening({
    predicate: (action) => 
      action.type.endsWith('/fulfilled') || 
      action.type.endsWith('/rejected'),
    effect: (action) => {
      pendingThunks.delete(action.meta.requestId);
    },
  });
  
  // 注册全局清理钩子
  (window as any).__TAURI_STORE_CLEANUP__ = async () => {
    console.log(`[Store Cleanup] Window ${windowLabel}: 开始清理...`);
    
    // 1. 取消所有进行中的 thunk
    pendingThunks.forEach((abortController, requestId) => {
      console.log(`[Store Cleanup] 取消 thunk: ${requestId}`);
      abortController.abort('Window closing');
    });
    pendingThunks.clear();
    
    // 2. 清除所有 Tauri event listeners
    // （具体模块的 listener unsubscribe 函数需注册到此处）
    const unsubscribers = (window as any).__TAURI_EVENT_UNSUBSCRIBERS__ || [];
    unsubscribers.forEach((unsub: () => void) => unsub());
    (window as any).__TAURI_EVENT_UNSUBSCRIBERS__ = [];
    
    // 3. 重置 Store 状态（可选，加速 GC）
    store.dispatch({ type: 'RESET_STORE_FOR_CLEANUP' });
    
    console.log(`[Store Cleanup] Window ${windowLabel}: 清理完成`);
  };
  
  return store;
}
```

**集成要求**：
1. 所有自定义 async thunk 必须接受 `abortController.signal` 参数
2. 所有 `listen()` 调用必须保存 unsubscriber 到 `__TAURI_EVENT_UNSUBSCRIBERS__`
3. Rust 侧在关闭窗口前，必须先调用前端的 `__TAURI_STORE_CLEANUP__` （通过 `invoke()`）

```typescript
// Rust 侧：关闭窗口前调用前端清理钩子
#[tauri::command]
async fn close_window(window: Window) -> Result<()> {
    // 1. 调用前端清理钩子
    window.eval("if(window.__TAURI_STORE_CLEANUP__) window.__TAURI_STORE_CLEANUP__()")?;
    
    // 2. 等待清理完成（最多 3 秒）
    tokio::time::sleep(Duration::from_millis(300)).await;
    
    // 3. 关闭窗口
    window.close()?;
    Ok(())
}
```

## 3.4 Store 生命周期

```
创建窗口
  │
  ├─ WebView 初始化
  │    └─ createAppStore()
  │         ├─ 注入 windowLabel
  │         ├─ 注册 listenerMiddleware（跟踪 async thunk）
  │         ├─ 注册 __TAURI_STORE_CLEANUP__ 钩子
  │         └─ React Root mount
  │
  ├─ Store 活跃期
  │    ├─ 接收 Tauri Events → dispatch
  │    ├─ 用户交互 → dispatch → invoke
  │    ├─ Async Thunk 发起 → 注册 AbortController
  │    └─ 接收 invoke 结果 → update state
  │
  └─ 窗口关闭（Rust 调用 close_window）
       ├─ Rust 调用 window.eval("__TAURI_STORE_CLEANUP__()")
       ├─ 前端执行清理钩子：
       │    ├─ 取消所有进行中的 async thunk（abortController.abort）
       │    ├─ 执行所有 event listener unsubscribers
       │    └─ 分发 RESET_STORE_FOR_CLEANUP action
       ├─ 等待清理完成（300ms timeout）
       ├─ React Root unmount
       └─ WebView 销毁 → Store 随 GC 回收
```

**关键保证**：
- Store 不存在于 WebView 之外，窗口关闭自动回收
- 不存在跨窗口的 Store 引用，杜绝内存泄漏
- 每个 Store 的中间件和订阅独立，互不影响
- **新增**：窗口关闭前强制清理进行中的异步操作，防止崩溃

> ⚠️ **注意**：若前端清理钩子在 3 秒内未完成，Rust 侧将强制关闭窗口（防止用户等待超时）。

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
import { showSaveDialog } from '../components/SaveDialog';

export function useWindowCleanup() {
  const store = useStore();

  useEffect(() => {
    const window = getCurrentWindow();
    
    const unlisten = window.onCloseRequested(async (event) => {
      // 1. 检查是否有未保存更改
      const state = store.getState();
      if (state.articles.isDirty) {
        const confirmed = await showSaveDialog();
        if (!confirmed) {
          event.preventDefault(); // 阻止关闭
          return;
        }
      }
      
      // 2. 执行 Store 清理钩子（取消进行中的 thunk）
      try {
        if ((window as any).__TAURI_STORE_CLEANUP__) {
          await (window as any).__TAURI_STORE_CLEANUP__();
        }
      } catch (error) {
        console.error('[Store Cleanup] 清理失败:', error);
        // 清理失败不阻止关闭（防止用户无法关闭窗口）
      }
      
      // 3. 清理完成，允许关闭
      unlisten();
    });

    return () => { unlisten(); };
  }, [store]);
}
```

### 3.8.1 Event Listener 取消注册规范

所有 `listen()` 调用**必须**保存 unsubscriber：

```typescript
// modules/articles/hooks/useArticleSync.ts
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

export function useArticleSync() {
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];
    
    // 监听文章更新事件
    listen('article:updated', (event) => {
      // 处理更新...
    }).then((unsubscribe) => {
      unsubscribers.push(unsubscribe);
    });
    
    // 注册到全局清理列表
    (window as any).__TAURI_EVENT_UNSUBSCRIBERS__ = [
      ...((window as any).__TAURI_EVENT_UNSUBSCRIBERS__ || []),
      ...unsubscribers,
    ];
    
    return () => {
      // 组件卸载时也清理
      unsubscribers.forEach((unsub) => unsub());
    };
  }, []);
}
```
