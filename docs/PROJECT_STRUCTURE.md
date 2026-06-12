# 智写时光 (TimeWrite) — 项目目录结构说明

> **版本**: `0.9.4` | **架构**: Tauri v2 (Rust + React) | **语言**: Rust 2021 / TypeScript 6 | **包管理**: pnpm 11

---

## 目录

- [项目根目录](#项目根目录)
- [前端源码 `src/`](#前端源码-src)
  - [入口文件](#入口文件)
  - [页面 `pages/`](#页面-pages)
  - [组件 `components/`](#组件-components)
  - [状态管理 `stores/`](#状态管理-stores)
  - [工具库 `lib/`](#工具库-lib)
  - [自定义 Hooks `hooks/`](#自定义-hooks-hooks)
  - [类型定义 `types/`](#类型定义-types)
  - [路由 `router/`](#路由-router)
  - [插件系统 `plugins/`](#插件系统-plugins)
  - [样式 `styles/`](#样式-styles)
- [Rust 后端 `src-tauri/`](#rust-后端-src-tauri)
  - [入口与配置](#入口与配置)
  - [命令层 `commands/`](#命令层-commands)
  - [数据库 `db/`](#数据库-db)
  - [数据模型 `models/`](#数据模型-models)
  - [数据仓库 `repository/`](#数据仓库-repository)
  - [业务服务 `service/`](#业务服务-service)
  - [错误处理 `error.rs`](#错误处理-errorrs)
  - [工具函数 `utils.rs`](#工具函数-utilsrs)
- [辅助目录](#辅助目录)
  - [脚本 `scripts/`](#脚本-scripts)
  - [文档 `docs/`](#文档-docs)
  - [产品页面 `product/`](#产品页面-product)
- [构建产物](#构建产物)
- [IPC 命令速查](#ipc-命令速查)

---

## 项目根目录

```
MirageInk/
├── package.json              # 前端依赖与脚本定义 (pnpm workspace)
├── pnpm-lock.yaml            # 依赖锁定文件
├── tsconfig.json             # TypeScript 编译配置 (strict: true, paths: @/*)
├── tsconfig.node.json        # Node 端 TS 配置 (vite.config, scripts)
├── vite.config.ts            # Vite 构建配置 (代码分包、别名)
├── index.html                # Vite 入口 HTML (React 挂载点)
├── .npmrc                    # pnpm 配置 (shamefully-hoist=true)
├── .gitignore                # Git 忽略规则
├── LICENSE                   # MIT 许可证
├── README.md                 # 项目说明
├── CODEBUDDY.md              # AI 编码助手指导文件
├── src/                      # 🔵 前端源码 (React + TypeScript)
├── src-tauri/                # 🟠 Rust 后端源码 (Tauri v2)
├── agent/                    # 🐍 Python Agent 服务 (FastAPI, 端口 9877)
├── scripts/                  # 🔧 构建/检查工具脚本
├── docs/                     # 📖 项目文档 (同步到 GitHub Wiki)
├── product/                  # 🏠 产品落地页
└── dist/                     # 📦 前端构建产物 (tsc + vite build)
```

---

## 前端源码 `src/`

```
src/
├── main.tsx                  # 应用入口，加载 ErrorBoundary + React Router
├── App.tsx                   # 根组件：主题初始化、窗口类型检测、路由挂载
├── vite-env.d.ts             # Vite 环境类型声明
├── pages/                    # 页面级组件
├── components/               # UI 组件（按业务域分目录）
├── stores/                   # 状态管理 (Zustand + Jotai)
├── lib/                      # 工具库 (IPC 桥接、工具函数)
├── hooks/                    # 自定义 React Hooks
├── types/                    # TypeScript 类型定义
├── router/                   # React Router 配置
├── plugins/                  # 扩展插件系统
└── styles/                   # CSS 样式 (TailwindCSS v4)
```

### 入口文件

| 文件 | 大小 | 说明 |
|------|------|------|
| `main.tsx` | 小 | ReactDOM.createRoot 挂载，包裹 ErrorBoundary |
| `App.tsx` | 小 | 根组件：useThemeFontInit、deep-link 窗口检测 |
| `vite-env.d.ts` | 小 | Vite 客户端类型声明 |

---

### 页面 `pages/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `LibraryPage.tsx` | ~700 行 | 书籍库总页：书卡网格、新建/编辑/删除/恢复书籍、筛选搜索 |
| `EditorPage.tsx` | ~280 行 | 编辑器主页面：左大纲 + 中编辑区 + 右 AI 侧栏，三栏拖拽布局 |
| `SettingsPage.tsx` | ~140 行 | 设置页面入口，组合各设置区域 |

---

### 组件 `components/`

#### `ai/` — AI 助手

| 文件 | 大小 | 说明 |
|------|------|------|
| `AiSidePanel.tsx` | ~400 行 | 右侧 AI 对话面板：消息列表 + 输入框，控制 AI 对话流 |
| `AiToolboxPanel.tsx` | ~800 行 | AI 工具箱面板（独立窗口）：提示词模板、场景生成等工具 |
| `MessageBubble.tsx` | ~400 行 | 单条消息气泡：Markdown 渲染、操作按钮（重试/复制/加入参考等） |
| `RequestDetailModal.tsx` | ~250 行 | 请求详情弹窗：查看完整 System/User Prompt |
| `useAiChat.ts` | ~590 行 | AI 对话核心 Hook：流式 SSE、RAG 检索、会话压缩、自动总结 |
| `panel/` | — | AI 面板子组件：消息列表、输入区、工具箱侧栏、输出面板等 |

#### `app/` — 应用级初始化

| 文件 | 大小 | 说明 |
|------|------|------|
| `AppInit.tsx` | ~80 行 | 应用启动初始化：加载持久化状态、注册全局事件 |
| `AppClosingOverlay.tsx` | ~35 行 | 关闭退出遮罩：显示关闭中进度，等待 Agent 停止 |
| `windowDetection.ts` | ~70 行 | 窗口类型检测：通过 URL 参数判断窗口类型（world/history/summary/debug） |

#### `common/` — 通用组件

| 文件 | 大小 | 说明 |
|------|------|------|
| `ContextMenu.tsx` | ~200 行 | 通用右键菜单：支持层级菜单、分组分隔、图标 |
| `DebugPanel.tsx` | ~350 行 | 调试控制台面板：查看系统日志、数据库校验 |
| `ToastContainer.tsx` | ~60 行 | Toast 通知容器：显示成功/错误/信息提示 |

#### `editor/` — 编辑器

| 文件 | 大小 | 说明 |
|------|------|------|
| `RichTextEditor.tsx` | ~400 行 | 富文本编辑器核心：TipTap 集成，自动保存（300ms 防抖 + 3 分钟定时） |
| `EditorToolbar.tsx` | ~800 行 | 编辑器工具栏：字体、格式、插入、字数统计、保存状态 |
| `ChapterSummaryHeader.tsx` | ~350 行 | 章节总结头部：展开/折叠总结内容区域 |
| `SnapshotPanel.tsx` | ~320 行 | 快照管理面板：创建、预览、恢复、删除快照 |
| `ImageResizeNodeView.tsx` | ~120 行 | 图片拖拽缩放 NodeView（TipTap 扩展） |
| `ImageCropperDialog.tsx` | ~320 行 | 图片裁剪对话框：拖拽选区精确裁剪并替换编辑器图片 |
| `ImageViewerDialog.tsx` | ~230 行 | 图片查看器：放大/缩小/拖拽查看高清原图 |
| `ResizableImageExtension.ts` | ~50 行 | 可缩放图片的 TipTap 扩展定义 |
| `toolbar/` | — | 工具栏子组件：颜色选择器、表格弹窗、代码语言选择、保存指示器 |

#### `layout/` — 布局组件

| 文件 | 大小 | 说明 |
|------|------|------|
| `EditorLayout.tsx` | ~10 行 | 编辑器布局容器：大纲 + 编辑 + AI 面板三栏 |
| `StatusBar.tsx` | ~40 行 | 底部状态栏：字数统计、保存状态指示、章节信息 |

#### `library/` — 书籍库

| 文件 | 大小 | 说明 |
|------|------|------|
| `BookCard.tsx` | ~350 行 | 书籍卡片：封面、书名、进度、操作菜单 |
| `CoverPicker.tsx` | ~150 行 | 封面选取组件：预设封面 + 自定义上传 |
| `NewBookDialog.tsx` | ~170 行 | 新建书籍对话框：标题/简介/封面 |
| `EditBookDialog.tsx` | ~200 行 | 编辑书籍对话框：修改书籍元信息 |
| `TrashModal.tsx` | ~250 行 | 回收站弹窗：查看、恢复、彻底删除软删除项目 |

#### `outline/` — 大纲/目录树

| 文件 | 大小 | 说明 |
|------|------|------|
| `OutlinePanel.tsx` | ~1050 行 | 大纲面板：可拖拽卷/章排列（@dnd-kit）、虚拟滚动、删除/恢复/重命名 |

#### `settings/` — 设置页

| 文件 | 大小 | 说明 |
|------|------|------|
| `SettingsPage.tsx` | ~150 行 | 设置页主组件：组合所有设置区域 |
| `AppearanceSection.tsx` | ~120 行 | 外观设置：主题（亮/暗/护眼暖/护眼绿）、字体大小 |
| `EditorConfigSection.tsx` | ~30 行 | 编辑器配置：自动保存开关等 |
| `AiConfigSection.tsx` | ~40 行 | AI 基本配置：API Key、Base URL、模型 |
| `ChatConfigSection.tsx` | ~200 行 | AI 对话配置：温度、Top-P、最大 Token、System Prompt |
| `RagConfigSection.tsx` | ~150 行 | RAG 检索配置：嵌入模型、检索策略 |
| `AiToolboxSection.tsx` | ~550 行 | AI 工具箱配置：提示词模板管理 |
| `StorageSection.tsx` | ~20 行 | 存储信息：数据库大小、备份路径 |
| `VersionSection.tsx` | ~210 行 | 版本信息：当前版本、检查更新、更新日志 |
| `constants.ts` | ~30 行 | 设置常量定义 |
| `shared.tsx` | ~170 行 | 设置页共享 UI 组件（Section 容器等） |

#### `worldbuilding/` — 世界观

| 文件 | 大小 | 说明 |
|------|------|------|
| `WorldbuildingPanel.tsx` | ~900 行 | 世界观面板（独立窗口）：World Card 列表、搜索、CRUD |
| `WorldCardEditor.tsx` | ~140 行 | World Card 编辑器：标题/分类/内容编辑 |

#### 顶级组件

| 文件 | 说明 |
|------|------|
| `ErrorBoundary.tsx` | React Error Boundary：捕获渲染错误，显示故障恢复界面 |

#### `agent/` — Agent 交互

| 文件 | 大小 | 说明 |
|------|------|------|
| `AgentPanel.tsx` | ~170 行 | Agent 交互面板：技能选择、任务执行、结果展示 |
| `AgentMessageBubble.tsx` | ~150 行 | Agent 消息气泡：技能执行状态与结果展示 |

> **注**: `diff/` 和 `ui/` 目录当前为空，预留给对比视图和通用 UI 基元组件。

---

### 状态管理 `stores/`

采用 **Zustand + Jotai** 双状态管理策略：

| 文件 | 大小 | 说明 |
|------|------|------|
| `appStore.ts` | ~70 行 | Zustand store 入口：组合所有 slice |
| `appTypes.ts` | ~500 行 | `AppState` + `AppActions` 全量类型定义 |
| `booksSlice.ts` | ~60 行 | 书籍管理 Slice：CRUD 操作、书架树状态 |
| `aiSlice.ts` | ~220 行 | AI 对话 Slice：多书多会话管理、消息增删改 |
| `preferencesSlice.ts` | ~50 行 | 偏好设置 Slice：主题/字体/编辑器偏好 |
| `pluginStore.ts` | ~70 行 | 插件状态管理：已安装插件列表、启用/禁用 |
| `uiAtoms.ts` | ~75 行 | Jotai atoms：瞬时 UI 状态（编辑器焦点、面板可见性、保存状态、弹窗开关） |

**状态持久化策略**：

| 数据 | 存储位置 | 说明 |
|------|----------|------|
| 业务数据（书籍/卷/章/快照/WorldCard） | SQLite (via IPC) | Rust 后端管理，前端缓存于 Zustand |
| AI 对话记录 | `localStorage` | 每次增/改消息立即序列化全量 |
| 偏好设置（主题/字体/AI 配置） | `localStorage` | 应用启动时恢复 |
| UI 瞬时状态 | 仅内存 (Jotai) | 不持久化 |

---

### 工具库 `lib/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `tauri-bridge.ts` | ~500 行 | IPC 桥接层：40+ 个类型安全的 `invoke` 包装函数，是本文件唯一允许调用 Tauri IPC 的地方 |
| `utils.ts` | ~240 行 | 通用工具函数：`cn()` 类名合并、字数统计、HTML 清洗、日期格式化、UUID 生成 |
| `image-utils.ts` | ~60 行 | 图片处理工具：图片压缩、Base64 转换、尺寸获取 |
| `toast.ts` | ~70 行 | Toast 通知工具：成功/错误/警告/信息四类提示 |

---

### 自定义 Hooks `hooks/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `useResizeHandle.ts` | ~180 行 | 面板拖拽调整大小：鼠标/触摸事件处理、最小/最大宽度限制、百分比持久化 |
| `useConsoleInterceptor.ts` | ~100 行 | 控制台拦截：捕获 console.log/error/warn 转发到调试面板 |
| `useThemeFontInit.ts` | ~80 行 | 主题和字体初始化：从 localStorage 恢复并应用到 DOM |
| `useAppVersion.ts` | ~20 行 | 应用版本号 Hook：从 Tauri 获取当前版本 |

---

### 类型定义 `types/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `index.ts` | ~200 行 | 核心业务类型：`Book`、`Volume`、`Chapter`、`Snapshot`、`WorldCard`、`AiConfig`、`EmbeddingStatus` 等 |

关键类型结构：

```
Book        ← 书籍：标题/简介/封面/字数/卷列表
  └─ Volume   ← 卷：卷名/排序/包含章节
       └─ Chapter ← 章节：标题/内容/字数/状态/总结/大纲
            └─ Snapshot ← 快照：内容/时间戳/标签
WorldCard   ← 世界观卡片：标题/分类/内容/标签
AiConfig    ← AI 配置：API Key/模型/温度/System Prompt
```

---

### 路由 `router/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `index.tsx` | ~45 行 | React Router v7 配置：`/` → LibraryPage, `/editor/:bookId` → EditorPage, `/settings` → SettingsPage |

路由使用懒加载（`React.lazy` + `Suspense`），EditorPage 和 SettingsPage 在访问时才加载。

---

### 插件系统 `plugins/`

基于**扩展点 (Extension Point)** 的插件架构：

| 文件 | 大小 | 说明 |
|------|------|------|
| `PluginManager.ts` | ~130 行 | 插件管理器单例：注册/注销/查询插件 |
| `types.ts` | ~110 行 | 插件类型定义：6 个扩展点 + Plugin 接口 |
| `index.ts` | ~50 行 | 插件系统导出 |
| `examples/charCounter.ts` | ~50 行 | 示例插件：字符计数器 |

**6 个扩展点**：
- `editor-toolbar` — 编辑器工具栏扩展按钮
- `editor-sidebar` — 编辑器侧边栏面板
- `library-card` — 书籍卡片扩展信息
- `export-format` — 自定义导出格式
- `ai-prompt` — AI 提示词模板
- `command-palette` — 命令面板项

---

### 样式 `styles/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `globals.css` | ~10 行 | TailwindCSS v4 入口：`@import "tailwindcss"` + `@theme` 定义 |
| `theme.css` | ~280 行 | 主题系统：4 种模式 CSS 自定义属性 (HSL color space) |
| `tiptap.css` | ~280 行 | TipTap 编辑器样式：标题、代码块、图片、表格、任务列表 |
| `markdown.css` | ~60 行 | Markdown 渲染样式：AI 消息气泡中的内容格式 |
| `base.css` | ~35 行 | 基础重置样式：滚动条、选中颜色、全局字体 |

**4 种主题模式**：
- `light` — 日间亮色
- `dark` — 夜间暗色
- `eyecare-warm` — 护眼暖色（降低蓝光）
- `eyecare-green` — 护眼绿色

---

## Rust 后端 `src-tauri/`

```
src-tauri/
├── Cargo.toml                # Rust 依赖与元数据
├── build.rs                  # Tauri 构建脚本
├── tauri.conf.json           # Tauri 应用配置
├── capabilities/
│   └── default.json          # 安全权限声明 (CSP / FS / Shell / HTTP)
├── gen/
│   └── schemas/              # 自动生成的 JSON Schema
│       ├── acl-manifests.json
│       ├── capabilities.json
│       ├── desktop-schema.json
│       └── macOS-schema.json
├── icons/                    # 应用图标 (25 PNG + 1 ICNS + 1 ICO)
└── src/                      # Rust 源代码
    ├── main.rs               # 程序入口
    ├── lib.rs                # Tauri Builder 与 IPC 注册
    ├── error.rs              # 统一错误类型
    ├── utils.rs              # 工具函数
    ├── commands/             # IPC 命令层
    ├── db/                   # 数据库连接与模式
    ├── models/               # 数据传输模型
    ├── repository/           # 数据访问层 (DAO)
    └── service/              # 业务逻辑层
```

### 入口与配置

| 文件 | 说明 |
|------|------|
| `main.rs` | Rust 程序入口，调用 `lib::run()` |
| `lib.rs` | Tauri Builder 核心：注册 7 个插件、初始化 SQLite、注册 55 个 IPC 命令 |
| `Cargo.toml` | Rust 依赖：tauri 2、rusqlite、r2d2、reqwest、serde、uuid、tokio、anyhow 等 |
| `build.rs` | Tauri 构建脚本（编译时资源处理） |
| `tauri.conf.json` | Tauri 配置：窗口 1280x800、DMG/NSIS 打包、deep-link 协议 |

**注册的 Tauri 插件**：
- `tauri-plugin-shell` — Shell 命令执行
- `tauri-plugin-dialog` — 文件选择对话框
- `tauri-plugin-fs` — 文件系统读写
- `tauri-plugin-updater` — 自动更新
- `tauri-plugin-deep-link` — 深度链接（自定义协议窗口）
- `tauri-plugin-http` — HTTP 客户端

---

### 命令层 `commands/`

命令层仅做参数转换和调用 Service，不包含业务逻辑。

#### `commands/book.rs`
| 函数 | 说明 |
|------|------|
| `list_books` | 列出所有书籍（排除已删除） |
| `get_book` | 获取单本书详情 |
| `create_book` | 创建新书籍 |
| `update_book` | 更新书籍元信息 |
| `set_book_cover` | 设置书籍封面图片 |
| `delete_book` | 软删除书籍（含子孙卷/章） |
| `list_deleted_books` | 列出回收站中的书籍 |
| `restore_book` | 恢复已删除书籍 |
| `hard_delete_book` | 彻底删除书籍 |
| `clear_book_trash` | 清空回收站 |

#### `commands/volume.rs`
| 函数 | 说明 |
|------|------|
| `list_volumes` | 列出书籍下所有卷 |
| `list_deleted_volumes` | 列出回收站卷 |
| `create_volume` | 创建新卷 |
| `update_volume` | 更新卷名 |
| `delete_volume` | 软删除卷（含子孙章节） |
| `restore_volume` | 恢复已删除卷 |
| `hard_delete_volume` | 彻底删除卷 |
| `reorder_volumes` | 卷排序 |

#### `commands/chapter.rs`
| 函数 | 说明 |
|------|------|
| `list_chapters` | 列出章节列表 |
| `list_deleted_chapters` | 列出回收站章节 |
| `get_chapter_content` | 获取章节正文 |
| `create_chapter` | 创建新章节 |
| `save_chapter` | 保存章节内容（字数统计 + 更新书籍总字数） |
| `update_chapter_status` | 更新章节状态（草稿/完成） |
| `rename_chapter` | 重命名章节 |
| `delete_chapter` | 软删除章节 |
| `restore_chapter` | 恢复章节 |
| `hard_delete_chapter` | 彻底删除章节 |
| `reorder_chapters` | 章节排序 |
| `move_chapter_to_volume` | 移动章节到其他卷 |
| `save_chapter_summary` | 保存 AI 章节总结 |
| `clear_chapter_summary` | 清除章节总结 |
| `get_chapter_summary` | 获取章节总结 |
| `save_chapter_outline` | 保存章节大纲 |

#### `commands/snapshot.rs`
| 函数 | 说明 |
|------|------|
| `list_snapshots` | 列出章节所有快照 |
| `create_snapshot` | 创建新快照 |
| `get_snapshot_content` | 获取快照内容 |
| `restore_snapshot` | 恢复快照内容到章节 |
| `delete_snapshot` | 删除快照 |

#### `commands/world_card.rs`
| 函数 | 说明 |
|------|------|
| `list_world_cards` | 列出所有世界观卡片 |
| `create_world_card` | 创建世界观卡片 |
| `update_world_card` | 更新卡片内容 |
| `delete_world_card` | 删除卡片 |
| `search_world_cards` | FTS5 全文搜索 |

#### `commands/ai/` — AI 功能

| 子模块 | 文件 | 说明 |
|--------|------|------|
| `mod.rs` | ~160 行 | AI 模块入口，共用工具函数 |
| `chat.rs` | ~480 行 | **流式对话**：构建 SSE 请求、流式转发到前端（Tauri Event） |
| `embedding.rs` | ~150 行 | **向量嵌入**：文本分段 → 调用嵌入 API → 存储向量 |
| `summarize.rs` | ~200 行 | **内容总结**：章节总结、对话摘要（滑动窗口压缩） |
| `test.rs` | ~80 行 | **连接测试**：验证 API Key / Base URL 可用性 |

#### `commands/agent/` — Agent 管理

| 子模块 | 文件 | 说明 |
|--------|------|------|
| `mod.rs` | ~80 行 | Agent 模块入口，状态查询 |
| `skills.rs` | ~180 行 | **技能管理**：列出可用技能、执行技能、取消任务 |

#### `commands/io/` — 导入导出

| 子模块 | 文件 | 说明 |
|--------|------|------|
| `mod.rs` | 小 | IO 模块入口 |
| `export.rs` | ~80 行 | **格式导出**：书籍导出为 TXT/Markdown/HTML |
| `import_txt.rs` | ~80 行 | **TXT 导入**：解析 TXT 文件创建书籍+章节 |
| `backup.rs` | ~550 行 | **加密备份**：全量导出/导入，AES-256-CBC 加密 |
| `crypto.rs` | ~170 行 | **加密工具**：AES 加密/解密、文件哈希 |

#### `commands/image.rs`
| 函数 | 说明 |
|------|------|
| `process_image` | 图片压缩存储 |

#### `commands/window/` — 多窗口管理

| 子模块 | 文件 | 说明 |
|--------|------|------|
| `mod.rs` | ~90 行 | 窗口模块入口，URL 参数构建 |
| `manager.rs` | ~190 行 | **独立窗口**：open/close world/history/summary/ai_toolbox 子窗口 |
| `debug.rs` | ~110 行 | **调试窗口**：open/close/log/clear_logs |
| `validate.rs` | ~180 行 | **数据库校验**：完整性检查、FTS5 索引重建 |

---

### 数据库 `db/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `mod.rs` | ~350 行 | 数据库核心：连接池 (r2d2, max 10)、WAL 模式、FTS5 全文索引、自动建表迁移 |
| `schema.rs` | ~40 行 | 表结构常量定义 |

**6 张数据表**：

| 表名 | 主键类型 | 说明 |
|------|----------|------|
| `books` | TEXT (UUID) | 书籍元数据：标题/简介/封面/总字数/日目标/已删除标记 |
| `volumes` | TEXT (UUID) | 卷：卷名/排序/所属书籍 |
| `chapters` | TEXT (UUID) | 章节：标题/内容HTML/字数/状态/总结/大纲/所属卷/所属书籍 |
| `chapters_fts` | FTS5 | 章节全文搜索索引 |
| `snapshots` | TEXT (UUID) | 快照：内容HTML/字数/标签/章节引用 |
| `world_cards` | TEXT (UUID) | 世界观卡片：标题/分类/内容/所属书籍 |
| `embeddings` | TEXT (UUID) | 向量嵌入：文本/向量BLOB/来源类型 |

**数据库特性**：
- **WAL 模式**：支持并发读写
- **外键约束**：级联删除
- **自动迁移**：`safe_add_column()` 检测列是否存在后 ALTER TABLE
- **FTS5**：章节 + 世界观卡片全文搜索
- **软删除**：`deleted_at` 时间戳字段，回收站模式

---

### 数据模型 `models/`

| 文件 | 大小 | 说明 |
|------|------|------|
| `mod.rs` | ~100 行 | 所有 Rust struct 定义：统一使用 `#[serde(rename_all = "camelCase")]` 匹配前端 |

核心结构体：
```rust
Book / Volume / Chapter / Snapshot / WorldCard
CreateBookRequest / UpdateBookRequest / SaveChapterResult
CreateVolumeRequest / ReorderRequest / MoveChapterRequest
AiConfig / RAGConfig / EmbeddingStatus
ExportFormat / BackupMeta / ChatRequest
```

---

### 数据仓库 `repository/`

纯 SQL 访问层，不含业务逻辑：

| 文件 | 大小 | 说明 |
|------|------|------|
| `mod.rs` | 小 | Repository 模块入口 |
| `book_repo.rs` | ~220 行 | 书籍 CRUD、字数统计累加、回收站查询 |
| `chapter_repo.rs` | ~380 行 | 章节 CRUD、内容读写、软删除/恢复、排序、FTS5 操作 |
| `volume_repo.rs` | ~120 行 | 卷 CRUD、排序、回收站查询 |
| `snapshot_repo.rs` | ~85 行 | 快照 CRUD |
| `world_card_repo.rs` | ~200 行 | 世界观卡片 CRUD、FTS5 搜索 |
| `embedding_repo.rs` | ~140 行 | 向量嵌入存取、按来源批量查询 |

---

### 业务服务 `service/`

组装 Repository 调用，实现事务性操作：

| 文件 | 大小 | 说明 |
|------|------|------|
| `mod.rs` | 小 | Service 模块入口 |
| `book_service.rs` | ~240 行 | 书籍业务：创建默认卷、级联删除、字数统计聚合 |
| `chapter_service.rs` | ~280 行 | 章节业务：保存时更新书籍总字数、内容摘要提取 |
| `volume_service.rs` | ~100 行 | 卷业务：排序、级联操作 |
| `snapshot_service.rs` | ~100 行 | 快照业务：创建、恢复（复制内容回章节） |
| `search_service.rs` | ~360 行 | 搜索业务：FTS5 全文搜索 + LIKE 降级、向量语义搜索、混合排序 |
| `world_card_service.rs` | ~190 行 | 世界观业务：CRUD + 搜索 |

---

### 错误处理 `error.rs`

统一错误类型 `AppError`，实现 `From` trait 转换：
- `rusqlite::Error` → 数据库错误
- `r2d2::Error` → 连接池错误
- `reqwest::Error` → HTTP 请求错误
- `serde_json::Error` → JSON 序列化错误
- `anyhow::Error` → 通用错误
- `std::io::Error` → IO 错误

### 工具函数 `utils.rs`

共享工具函数：路径处理、文件操作、UUID 生成等。

---

## 辅助目录

### 脚本 `scripts/`

| 文件 | 说明 |
|------|------|
| `check.mjs` | **项目完整性检查**：`pnpm check` 执行，检查 pnpm/frontend/Rust 版本一致性 |
| `check-versions.ts` | **前端依赖版本检查**：对比 `package.json` vs `pnpm-lock.yaml` |
| `check-rust-versions.ts` | **Rust 版本检查**：对比 `Cargo.toml` vs `Cargo.lock` |
| `node-manager.ts` | **Node 版本管理**：检查/切换/安装 Node.js 版本 |
| `setup-agent.ts` | **Agent 环境初始化**：配置 Python 虚拟环境、安装依赖、下载模型 |
| `clean.ts` | **清理脚本**：清除构建产物、临时文件和缓存 |

---

### 文档 `docs/`

```
docs/
├── Home.md                  # GitHub Wiki 首页
├── _Sidebar.md              # Wiki 侧边栏导航
├── _Footer.md               # Wiki 页脚
├── CHANGELOG.md             # 版本更新日志
├── FAQ.md                   # 常见问题
├── PROJECT_STRUCTURE.md     # 📄 本文件 — 目录结构说明
├── 深度优化分析报告.md        # 项目优化分析报告
├── architecture/            # 架构文档
│   ├── overview.md          # 系统架构概览
│   └── AI-architecture.md   # AI 子系统架构
├── development/             # 开发文档
│   ├── contributing.md      # 贡献指南
│   ├── debug-console.md     # 调试控制台说明
│   ├── github-integration.md# GitHub 集成说明
│   ├── plugin-system.md     # 插件系统开发指南
│   ├── project-structure.md # 项目结构说明
│   ├── state-management.md  # 状态管理说明
│   └── tech-stack.md        # 技术栈说明
├── features/                # 功能文档
│   ├── feature-list.md      # 功能列表
│   └── ai-assistant-analysis.md # AI 助手分析报告
└── user-guide/              # 用户指南
    ├── quick-start.md       # 快速入门
    ├── library-management.md# 书籍库管理
    ├── chapter-editing.md   # 章节编辑
    ├── ai-assistant.md      # AI 助手使用
    ├── worldbuilding.md     # 世界观构建
    ├── version-management.md# 版本管理
    ├── import-export.md     # 导入导出
    ├── focus-mode.md        # 专注模式
    └── personalization.md   # 个性化设置
```

---

### Agent 服务 `agent/`

```
agent/
├── main.py                  # FastAPI 入口，端口 9877
├── requirements.txt         # Python 依赖
├── models/                  # 模型适配器
│   └── __init__.py          # 模型工厂函数
├── skills/                  # Agent 技能实现
│   ├── __init__.py
│   ├── writing.py           # 写作辅助技能（续写/润色/扩写）
│   └── analysis.py          # 分析技能（角色/剧情/总结）
├── core/                    # 核心基础设施
│   ├── config.py            # 配置管理
│   ├── tracer.py            # 日志与追踪
│   └── bridge.py            # Bridge 客户端（与 Rust 端通信）
└── data/                    # 运行时数据缓存
```

Agent 服务由 Rust 后端通过 `src-tauri/src/python/` 模块自动启动和管理，支持健康检查与异常自动重启。Python 环境自动检测（`which python`），uvicorn 作为 ASGI 服务器。

---

### 产品页面 `product/`

| 文件 | 说明 |
|------|------|
| `landing-page.html` | 产品落地页（GitHub Pages 部署） |
| `logo.png` | 产品 Logo |
| `wx-pay.jpg` / `wx-wangyajun.jpg` / `wx-wyj.jpg` | 微信/赞赏码图片 |
| `AI小说写作平台=智写时光-宣传页.png` | 宣传图 |
| `css/` / `js/` | 落地页样式和脚本 |

---

## 构建产物

| 目录 | 说明 |
|------|------|
| `dist/` | 前端构建输出（`tsc && vite build`），包含 HTML/CSS/JS 文件 |
| `src-tauri/target/` | Rust 编译产物（release/debug），包含二进制和中间文件 |

---

## IPC 命令速查

共 **60+ 个** IPC 命令，全部在 `src-tauri/src/lib.rs` 中注册，前端通过 `src/lib/tauri-bridge.ts` 调用：

| 模块 | 命令数 | 命令列表 |
|------|--------|----------|
| **书籍** | 10 | list_books, get_book, create_book, update_book, set_book_cover, delete_book, list_deleted_books, restore_book, hard_delete_book, clear_book_trash |
| **卷** | 8 | list_volumes, list_deleted_volumes, create_volume, update_volume, delete_volume, restore_volume, hard_delete_volume, reorder_volumes |
| **章节** | 16 | list_chapters, list_deleted_chapters, get_chapter_content, create_chapter, save_chapter, update_chapter_status, rename_chapter, delete_chapter, restore_chapter, hard_delete_chapter, reorder_chapters, move_chapter_to_volume, save_chapter_summary, clear_chapter_summary, get_chapter_summary, save_chapter_outline |
| **快照** | 5 | list_snapshots, create_snapshot, get_snapshot_content, restore_snapshot, delete_snapshot |
| **世界观** | 5 | list_world_cards, create_world_card, update_world_card, delete_world_card, search_world_cards |
| **AI** | 8 | test_ai_connection, rag_search, trigger_embedding, check_embedding_status, test_rag_connection, stream_ai_chat, summarize_chapter, summarize_conversation |
| **导入导出** | 5 | export_book, import_txt, export_all_data, export_single_book, import_backup |
| **图片** | 2 | process_image, process_image_cropped |
| **窗口** | 10 | open/close_world_window, open/close_history_window, open/close_summary_window, open/close_ai_toolbox_window, open/close_debug_window, log_message, get_debug_logs, clear_debug_logs, validate_database |
| **Agent** | 5 | get_agent_status, start_agent, stop_agent, execute_skill, cancel_skill |

---

## 架构分层

```
┌─────────────────────────────────────────────────────────┐
│                    React Frontend                         │
│  pages/ ← components/ ← stores/ ← lib/tauri-bridge.ts   │
├─────────────────────────────────────────────────────────┤
│                   Tauri IPC Bridge                        │
│              invoke("command_name", args)                 │
├─────────────────────────────────────────────────────────┤
│                    Rust Backend                           │
│  commands/ → service/ → repository/ → db/ (SQLite)      │
│                       models/ (serde camelCase)          │
└─────────────────────────────────────────────────────────┘
```

- **前端层**: React 组件 → Zustand/Jotai → `tauri-bridge.ts` → `invoke`
- **IPC 桥**: 序列化 JSON 参数 ↔ Tauri IPC 协议
- **命令层**: 接收参数 → 调用 Service → 返回序列化结果
- **服务层**: 事务组装 → 调用 Repository
- **仓库层**: SQL 执行 → 返回 Model 结构体
- **数据库**: SQLite WAL 模式 + FTS5 全文索引

---

> 📅 生成日期: 2025-06-11 | 更新日期: 2026-06-12 | 基于 MirageInk v0.9.4 (agent-dev 分支)
