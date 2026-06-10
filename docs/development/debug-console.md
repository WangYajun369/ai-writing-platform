# 调试控制台

TimeWrite 内置了一套跨进程的日志汇聚与实时展示系统，可捕获所有前端窗口（主窗口 + 独立子窗口）的 `console.log/warn/error` 输出，并在一个独立的调试控制台窗口中统一展示，支持过滤、清空和自动滚动。

---

## 架构总览

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│   主窗口 (main)   │   │   独立窗口 (world)  │   │   其他窗口        │
│  console.log()   │   │  console.warn()  │   │  console.error() │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │  log_message          │  log_message          │  log_message
         ▼                       ▼                       ▼
┌────────────────────────────────────────────────────────────────┐
│                       Tauri Rust 后端                           │
│  ┌─────────────────────┐      ┌──────────────────────────────┐ │
│  │   LOG_BUFFER         │      │  log_message() IPC command   │ │
│  │   (Mutex<Vec<LogEntry>>)│◄───│  · 读取时间戳                 │ │
│  │   最近 1000 条        │      │  · 写入缓冲区 (FIFO)          │ │
│  │                     │      │  · 广播 debug-log 事件       │ │
│  └─────────┬───────────┘      └──────────────────────────────┘ │
│            │                                                    │
│            │ get_debug_logs / clear_debug_logs                  │
│            ▼                                                    │
└────────────────────────────────────────────────────────────────┘
             │  debug-log 事件广播 (实时)
             ▼
┌─────────────────────────────────────────┐
│          调试控制台窗口 (debug)            │
│  ┌─────────────────────────────────────┐ │
│  │  DebugPanel.tsx                     │ │
│  │  · 加载历史日志 (get_debug_logs)      │ │
│  │  · 监听 debug-log 事件 (实时)         │ │
│  │  · 按级别过滤：全部/信息/警告/错误    │ │
│  │  · 清空全部日志 (clear_debug_logs)   │ │
│  │  · 自动滚动 + 手动暂停              │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 关键设计点

| 特性 | 实现方式 |
|------|---------|
| 跨窗口日志汇聚 | 所有窗口 `console.*` 被拦截，统一通过 `invoke('log_message')` 发送到 Rust 后端 |
| 独立窗口不丢失 | 主窗口关闭 → `setup()` 中监听到 `Destroyed` → 自动关闭 `debug` 窗口 |
| 实时 + 历史双模式 | 打开调试窗口时 `get_debug_logs` 加载缓冲区，随后 `debug-log` 事件实时推送 |
| 缓冲区上限 | `LOG_BUFFER` 容量固定为 1000 条，超出时移除最早日志（FIFO） |
| 调试窗口自身不拦截 | `?debugwin=1` 参数检测，调试窗口跳过 `console` 拦截，避免无限循环 |
| 静默失败 | `sendLog()` 内部 `try/catch`，日志发送失败不影响主流程 |

---

## TypeScript 侧：日志打印

### 数据模型

```typescript
// src/lib/tauri-bridge.ts

export interface LogEntry {
  timestamp: string   // "HH:mm:ss" 格式，如 "20:15:30"
  level: string       // "log" | "warn" | "error"
  message: string     // 日志正文
}
```

### 拦截原理

在 `App.tsx` 的 `AppInit()` 中，非调试窗口启动时会拦截全局 `console` 方法：

```typescript
// src/App.tsx — 启动时的 console 拦截逻辑

const origLog = console.log.bind(console)
const origWarn = console.warn.bind(console)
const origError = console.error.bind(console)

console.log = (...args: unknown[]) => {
  origLog(...args)       // 保持浏览器控制台原始行为
  sendLog('log', args)   // 额外发送到 Rust 后端
}
console.warn = (...args: unknown[]) => {
  origWarn(...args)
  sendLog('warn', args)
}
console.error = (...args: unknown[]) => {
  origError(...args)
  sendLog('error', args)
}
```

`sendLog()` 会将参数序列化并调用 `invoke('log_message', { level, message })`：

```typescript
async function sendLog(level: string, args: unknown[]) {
  const message = args
    .map((a) => {
      if (a === null || a === undefined) return String(a)
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'string') return a
      if (typeof a === 'object') {
        try { return JSON.stringify(a, null, 2) } catch { return String(a) }
      }
      return String(a)
    })
    .filter(Boolean)
    .join(' ')

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('log_message', { level, message })
  } catch {
    // 静默失败（调试日志不影响主流程）
  }
}
```

### 使用示例一：基本打印

```typescript
// ✅ 以下所有 console 调用都会被捕获并发送到调试控制台

console.log('应用启动完成')
console.log('当前书籍数量:', books.length)
console.warn('RAG 索引已过期，需要重新生成')
console.error('保存章节失败:', error)
```

效果：

```
┌──────────────────────────────────────────────────────┐
│ 20:15:30  [INFO]  应用启动完成                        │
│ 20:15:30  [INFO]  当前书籍数量: 3                     │
│ 20:15:31  [WARN]  RAG 索引已过期，需要重新生成         │
│ 20:15:32  [ERROR] 保存章节失败: Error: 网络连接超时    │
└──────────────────────────────────────────────────────┘
```

### 使用示例二：打印对象和 Error

```typescript
// 普通对象 → 自动 JSON.stringify
console.log('AI 配置:', { provider: 'zhipu', model: 'glm-4-plus', temperature: 0.7 })

// Error 对象 → 自动提取 stack trace
try {
  await someAsyncOperation()
} catch (e) {
  console.error('异步操作失败:', e)  // 自动展示 e.stack || e.message
}
```

### 使用示例三：在各组件中的典型用法

```typescript
// === src/pages/LibraryPage.tsx ===
async function handleToggleDebugWindow() {
  if (debugWindowOpen) {
    try {
      await invoke('close_debug_window')
    } catch (e) {
      console.error('关闭调试控制台失败', e)  // ← 捕获并发送
    }
    setDebugWindowOpen(false)
  } else {
    try {
      await invoke('open_debug_window')
      setDebugWindowOpen(true)
    } catch (e) {
      console.error('打开调试控制台失败', e)  // ← 捕获并发送
    }
  }
}

// === src/components/editor/RichTextEditor.tsx ===
async function handleSave() {
  const html = editor.getHTML()
  const wc = countWordsFromHtml(html)
  try {
    const result = await chapterApi.save(chapterId, html, wc)
    console.log('章节已保存:', { chapterId, wordCount: result.wordCount })
  } catch (e) {
    console.error('章节保存失败:', e)
  }
}

// === src/components/ai/AiSidePanel.tsx ===
function handleStreamError(err: string) {
  console.error('AI 流式响应中断:', err)
}

// === src/components/worldbuilding/WorldbuildingPanel.tsx ===
async function handleSearch(query: string) {
  console.log('世界观搜索:', { bookId, query })
  try {
    const results = await worldCardApi.search(bookId, query)
    console.log(`搜索完成，找到 ${results.length} 条结果`)
  } catch (e) {
    console.warn('世界观搜索降级为本地:', e)
  }
}
```

### 使用示例四：独立窗口中打印

```typescript
// 世界观窗口（?worldwin=1）、版本历史窗口（?historywin=1）、
// AI 工具箱窗口（?aitoolboxwin=1）等独立窗口中的 console 调用同样被捕获。
//
// 这些窗口运行的是同一个前端页面，只是通过 URL 参数
// 决定了渲染哪个面板，console 拦截逻辑对其同样生效。

// 在世界观窗口中：
console.log('加载世界观卡片:', cards.length)
// ↑ 这条日志同样会出现在调试控制台中
```

### 使用示例五：不可打印的类型序列化

```typescript
// 函数→忽略
console.log('回调函数:', () => {})           // → "回调函数:"

// Symbol → 忽略
const sym = Symbol('test')
console.log('symbol:', sym)                  // → "symbol:"

// 循环引用对象 → JSON.stringify 报错后 fallback
const obj: any = { a: 1 }
obj.self = obj
console.log('循环对象:', obj)                // → "循环对象: [object Object]"

// undefined → "undefined"
console.log('值是:', undefined)              // → "值是: undefined"
```

---

## Rust 侧：日志打印

### 数据模型

```rust
// src-tauri/src/commands/window.rs

/// 日志条目
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub timestamp: String,   // HH:mm:ss 格式，chrono::Local 生成
    pub level: String,       // "log" | "warn" | "error"
    pub message: String,     // 日志正文
}
```

### 全局缓冲区

```rust
use std::sync::{Mutex, OnceLock};

/// 全局日志缓冲区（最近 1000 条），调试窗口启动时加载历史日志
static LOG_BUFFER: OnceLock<Mutex<Vec<LogEntry>>> = OnceLock::new();

fn log_buffer() -> &'static Mutex<Vec<LogEntry>> {
    LOG_BUFFER.get_or_init(|| Mutex::new(Vec::with_capacity(1000)))
}
```

### IPC 命令定义

```rust
/// 接收前端日志并广播到调试窗口
///
/// 所有窗口（包括独立窗口）的 console.log/warn/error 都会通过此命令
/// 汇聚到全局日志缓冲区，并实时广播给调试窗口。
#[tauri::command]
pub async fn log_message(app: AppHandle, level: String, message: String) -> Result<(), String> {
    let entry = LogEntry {
        timestamp: Local::now().format("%H:%M:%S").to_string(),
        level,
        message,
    };

    {
        let buffer = log_buffer();
        let mut logs = buffer.lock().map_err(|e| e.to_string())?;
        if logs.len() >= 1000 {
            logs.remove(0);           // FIFO：移除最早日志
        }
        logs.push(entry.clone());
    }

    // 广播到所有窗口（调试窗口监听此事件实时展示日志）
    let _ = app.emit("debug-log", &entry);

    Ok(())
}

/// 获取所有已缓存的日志（调试窗口启动时加载历史日志）
#[tauri::command]
pub async fn get_debug_logs() -> Result<Vec<LogEntry>, String> {
    let buffer = log_buffer();
    let logs = buffer.lock().map_err(|e| e.to_string())?;
    Ok(logs.clone())
}

/// 清空所有缓存的日志
#[tauri::command]
pub async fn clear_debug_logs() -> Result<(), String> {
    let buffer = log_buffer();
    let mut logs = buffer.lock().map_err(|e| e.to_string())?;
    logs.clear();
    Ok(())
}
```

### Rust 侧主动发送日志到调试控制台

> **核心思路**：Rust 侧想将日志推送至前端调试控制台，只需调用 `app.emit("debug-log", &entry)` 即可。`log_message()` 本身已经完成了「写入缓冲区 + 广播事件」，你可以：
>
> (A) 复用 `log_message()` 命令（推荐，统一管道路由）
> (B) 在 Rust 内部直接构造 `LogEntry` + 写入缓冲区 + `emit`

#### 方案 A：复用 log_message（推荐）

```rust
// 在 Rust 命令中记录自定义日志到调试控制台
use tauri::AppHandle;

#[tauri::command]
pub async fn some_business_logic(app: AppHandle, data: String) -> Result<(), String> {
    // 业务逻辑...
    println!("[Rust] 处理数据: {}", data);  // 打印到 Rust stdout（终端可见）

    // 发送日志到前端调试控制台（通过调用自身的 log_message 命令）
    // 注意：需要把 AppHandle 传下来，或使用 app.state::<AppDb>() 等

    Ok(())
}
```

实际上，由于 Rust 侧已有 `println!()` 打印到终端，若希望将 Rust 输出同步到前端调试控制台，可在 `log_message` 命令内部同时调用 `println!`：

```rust
#[tauri::command]
pub async fn log_message(app: AppHandle, level: String, message: String) -> Result<(), String> {
    // 同时输出到 Rust stdout（终端可见）
    match level.as_str() {
        "warn" => eprintln!("[WARN] {}", message),
        "error" => eprintln!("[ERROR] {}", message),
        _ => println!("[INFO] {}", message),
    }

    let entry = LogEntry {
        timestamp: Local::now().format("%H:%M:%S").to_string(),
        level,
        message,
    };
    // ... 写入缓冲区 + emit
    Ok(())
}
```

#### 方案 B：Rust 命令中直接推送到调试控制台

```rust
use tauri::{AppHandle, Emitter};
use chrono::Local;

// 假设在某个命令中需要记录业务日志
pub async fn do_something_complex(app: AppHandle, param: String) -> Result<String, String> {
    // 开始处理
    let entry = LogEntry {
        timestamp: Local::now().format("%H:%M:%S").to_string(),
        level: "log".to_string(),
        message: format!("开始处理: param={}", param),
    };

    // 写入全局缓冲区
    {
        let buffer = log_buffer();
        let mut logs = buffer.lock().map_err(|e| e.to_string())?;
        if logs.len() >= 1000 { logs.remove(0); }
        logs.push(entry.clone());
    }

    // 广播到调试窗口
    let _ = app.emit("debug-log", &entry);

    // 继续业务逻辑...
    match process(&param) {
        Ok(result) => {
            // 成功日志
            let entry = LogEntry {
                timestamp: Local::now().format("%H:%M:%S").to_string(),
                level: "log".to_string(),
                message: format!("处理完成: {}", result),
            };
            // ... (同样的写入 + emit)
            Ok(result)
        }
        Err(e) => {
            // 错误日志
            let entry = LogEntry {
                timestamp: Local::now().format("%H:%M:%S").to_string(),
                level: "error".to_string(),
                message: format!("处理失败: {}", e),
            };
            // ... (同样的写入 + emit)
            Err(e.to_string())
        }
    }
}
```

#### 方案 C：封装 Rust 工具函数（最佳实践）

```rust
// 在 window.rs 或新建 debug.rs 中封装一个便捷函数
use tauri::{AppHandle, Emitter};
use chrono::Local;

/// 从 Rust 侧发送一条日志到前端调试控制台
pub fn rust_log(app: &AppHandle, level: &str, message: &str) {
    let entry = LogEntry {
        timestamp: Local::now().format("%H:%M:%S").to_string(),
        level: level.to_string(),
        message: message.to_string(),
    };

    // 写入缓冲区
    if let Ok(mut logs) = log_buffer().lock() {
        if logs.len() >= 1000 { logs.remove(0); }
        logs.push(entry.clone());
    }

    // 广播事件
    let _ = app.emit("debug-log", &entry);
}

// ── 在任意命令中使用 ──
#[tauri::command]
pub async fn process_data(app: AppHandle, data: String) -> Result<(), String> {
    rust_log(&app, "log", &format!("收到数据: {}", data));

    match heavy_computation(&data) {
        Ok(result) => {
            rust_log(&app, "log", &format!("计算完成: {}", result));
            Ok(())
        }
        Err(e) => {
            rust_log(&app, "error", &format!("计算失败: {}", e));
            Err(e)
        }
    }
}
```

---

## 前端 API 参考

### debugApi 对象

```typescript
// src/lib/tauri-bridge.ts

export const debugApi = {
  /** 打开调试控制台窗口（独立 always-on-top 窗口） */
  async open(): Promise<void>,

  /** 关闭调试控制台窗口 */
  async close(): Promise<void>,

  /** 获取所有已缓存的日志（调试窗口启动时调用） */
  async getLogs(): Promise<LogEntry[]>,

  /** 清空所有日志（缓冲区 + 当前显示） */
  async clear(): Promise<void>,
}
```

### 事件

| 事件名 | 方向 | 载荷类型 | 说明 |
|--------|------|---------|------|
| `debug-log` | Rust → 所有窗口 | `LogEntry` | 新日志条目广播，调试窗口监听此事件实时展示 |
| `debug-window-closed` | Rust → main 窗口 | `()` | 调试窗口关闭通知，主窗口复位按钮状态 |

### 在组件中使用

```typescript
import { debugApi } from '@/lib/tauri-bridge'

// 打开调试窗口
await debugApi.open()

// 关闭调试窗口
await debugApi.close()

// 清空日志
await debugApi.clear()
```

### 监听实时日志事件

```typescript
import { listen } from '@tauri-apps/api/event'
import type { LogEntry } from '@/lib/tauri-bridge'

// 订阅实时日志
const unlisten = await listen<LogEntry>('debug-log', (event) => {
  console.log('新日志:', event.payload.message)
})

// 取消订阅
unlisten()
```

---

## DebugPanel 组件解析

`src/components/common/DebugPanel.tsx` 是调试控制台的核心 UI 组件，仅在 `?debugwin=1` 模式下渲染。

### 组件结构

```
┌─────────────────────────────────────────────────┐
│ 🐛 调试控制台    128 条日志  3 错误  5 警告      │ ← 顶栏
│                   [全部][信息][警告][错误]  清空  │
├─────────────────────────────────────────────────┤
│ 20:15:30 [INFO]  应用启动完成                    │ ← 日志列表
│ 20:15:30 [INFO]  当前书籍数量: 3                 │   斑马纹背景
│ 20:15:31 [WARN]  RAG 索引已过期                  │   等宽字体
│ 20:15:32 [ERROR] 保存章节失败: Error: ...        │   自动滚动
│ ...                                              │
├─────────────────────────────────────────────────┤
│ 已暂停自动滚动  [回到底部]                       │ ← 底栏 (暂停时显示)
└─────────────────────────────────────────────────┘
```

### 关键行为

| 功能 | 实现 |
|------|------|
| 历史日志加载 | `useEffect` 启动时调用 `invoke('get_debug_logs')` |
| 实时日志追加 | `listen<LogEntry>('debug-log', ...)` 事件监听，追加到 `logs` state |
| 级别过滤 | `filter` state 控制 `filteredLogs` 计算（`all`/`log`/`warn`/`error`） |
| 自动滚动 | `useEffect([logs])` 中检测 `autoScrollRef.current`，滚动到底部 |
| 手动暂停 | `onScroll` 事件中检测距底部 `< 40px` 判定为非底部 → 暂停自动滚动 |
| 恢复滚动 | 底栏按钮点击 → `autoScrollRef.current = true` + `scrollTo` |
| 清空 | `handleClear()` → `invoke('clear_debug_logs')` + `setLogs([])` |
| 日志级别着色 | `LEVEL_STYLES` 映射表：普通用前景色，警告用黄色，错误用红色 |

### 样式说明

```typescript
const LEVEL_STYLES: Record<string, { text: string; badge: string }> = {
  log: {
    text: 'text-foreground',
    badge: 'bg-muted text-muted-foreground'
  },
  warn: {
    text: 'text-yellow-600 dark:text-yellow-400',
    badge: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
  },
  error: {
    text: 'text-red-600 dark:text-red-400',
    badge: 'bg-red-500/10 text-red-600 dark:text-red-400'
  },
}
```

---

## 窗口生命周期

### 主窗口关闭 → 调试窗口自动关闭

```rust
// src-tauri/src/lib.rs — setup() 中
if let Some(main) = app.get_webview_window("main") {
    let handle = app.handle().clone();
    main.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            // 主窗口关闭 → 关闭调试窗口
            if let Some(debug) = handle.get_webview_window("debug") {
                let _ = debug.close();
            }
        }
    });
}
```

### 调试窗口关闭 → 通知主窗口

```rust
// 检测调试窗口关闭，发送事件到 main 窗口复位按钮
w.on_window_event(move |event| {
    if let tauri::WindowEvent::Destroyed = event {
        let _ = main.emit("debug-window-closed", ());
    }
});
```

### 主窗口监听 → 更新 UI 原子

```typescript
// src/pages/LibraryPage.tsx
useEffect(() => {
  const unlisten = listen('debug-window-closed', () => {
    setDebugWindowOpen(false)
  })
  return () => { unlisten.then((fn) => fn()) }
}, [])
```

### 按钮状态共享

```typescript
// src/stores/uiAtoms.ts
export const debugWindowOpenAtom = atom<boolean>(false)

// 用于 LibraryPage 按钮高亮状态：
// debugWindowOpen 为 true 时按钮显示激活态（bg-primary/10 text-primary）
```

---

## 注册清单

为使调试控制台正常工作，以下文件必须正确配置：

| 文件 | 作用 |
|------|------|
| `src-tauri/src/commands/window.rs` | 定义 `LogEntry`、`LOG_BUFFER`、`log_message`、`open_debug_window`、`close_debug_window`、`get_debug_logs`、`clear_debug_logs` |
| `src-tauri/src/lib.rs` | `invoke_handler` 注册命令 + `setup` 监听主窗口关闭 |
| `src/lib/tauri-bridge.ts` | 导出 `LogEntry` 类型 + `debugApi` 封装 |
| `src/stores/uiAtoms.ts` | 导出 `debugWindowOpenAtom` |
| `src/App.tsx` | 检测 `?debugwin=1`、拦截 `console.*`、渲染 `DebugPanel` |
| `src/pages/LibraryPage.tsx` | 工具栏调试按钮 + 事件监听 |
| `src/components/common/DebugPanel.tsx` | 调试控制台 UI 组件 |

---

## 扩展指南

### 添加新的日志来源

如果想在 Rust 侧新增日志来源（例如在 `ai.rs` 或 `db/mod.rs` 中主动推送日志），参考上面的「Rust 侧主动发送日志」。

### 在调试窗口中添加更多功能

`DebugPanel.tsx` 使用标准的 React + TailwindCSS 组件结构，可以方便地扩展：

```typescript
// 示例：添加导出日志功能
const handleExport = useCallback(async () => {
  // 调用 Tauri dialog 保存日志为文本文件
}, [logs])
```

### 调整缓冲区大小

在 `src-tauri/src/commands/window.rs` 中修改常量：

```rust
static LOG_BUFFER: OnceLock<Mutex<Vec<LogEntry>>> = OnceLock::new();

fn log_buffer() -> &'static Mutex<Vec<LogEntry>> {
    // 将 1000 改为所需容量
    LOG_BUFFER.get_or_init(|| Mutex::new(Vec::with_capacity(2000)))
}
```

`log_message` 中对应的上限判断也需要同步调整。

---
