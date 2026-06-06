# MirageInk（幻境水墨）— 项目目录说明

> 跨平台桌面端小说写作软件 | Tauri v2 + React + Rust + SQLite

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 |
| 前端框架 | React 18 + TypeScript 5 + Vite 8 |
| 样式方案 | TailwindCSS 3 + HSL CSS 变量色彩体系（亮色/暗色/暖黄/豆沙绿） |
| 富文本编辑 | TipTap（H1-H3/加粗/斜体/下划线/颜色/图片/表格/字符计数/Placeholder） |
| 状态管理 | Zustand（appStore + pluginStore）+ Jotai（13 个 atom） |
| 路由 | React Router v7（懒加载） |
| 后端语言 | Rust 2021 Edition |
| 数据库 | SQLite（WAL 模式）+ rusqlite（bundled）+ r2d2 连接池 |
| 包管理 | pnpm >= 9，Node >= 20 |
| 深度链接 | ukcoder 协议（`ukcoder://`），支持外部应用唤起 |

---

## 目录结构

```
MirageInk/
├── index.html                  # SPA 入口 HTML
├── package.json                # 项目配置（22 dependencies + 13 devDependencies）
├── pnpm-lock.yaml              # pnpm 锁文件
├── tsconfig.json               # TypeScript 编译配置（路径别名 @/* -> ./src/*）
├── tsconfig.node.json          # vite.config.ts 专用 TypeScript 配置
├── vite.config.ts              # Vite 构建配置（端口 1420/1421，路径别名 @，代码分割）
├── tailwind.config.ts          # TailwindCSS 配置（暗黑主题、HSL 色彩系统、自定义字体）
├── postcss.config.js           # PostCSS 配置（tailwindcss + autoprefixer）
├── .gitignore                  # Git 忽略配置
│
├── scripts/                    # 脚本工具
│   └── check.mjs               #   完整性自动检测脚本
│
├── src/                        # React 前端源码
│   ├── main.tsx                #   应用入口（ReactDOM.createRoot + StrictMode）
│   ├── App.tsx                 #   根组件（Jotai Provider + 主题/护眼/字体初始化 + 世界观独立窗口检测）
│   ├── router/
│   │   └── index.tsx           #   路由定义（/→书库、/editor/:bookId→编辑器、/settings→设置，懒加载）
│   │
│   ├── pages/                  #   页面组件
│   │   ├── LibraryPage.tsx     #     书库首页（搜索、排序、网格/列表视图、虚拟化滚动、新建作品、状态栏）
│   │   ├── EditorPage.tsx      #     编辑器主页面（三栏布局：目录树/编辑器/右侧面板，专注模式 Esc 退出）
│   │   └── SettingsPage.tsx    #     设置页面（5 个标签页：AI 配置/外观/编辑/存储/版本，版本检查更新）
│   │
│   ├── components/             #   功能组件
│   │   ├── library/            #     书库相关
│   │   │   ├── BookCard.tsx    #       书籍卡片（网格/列表双模式、日更进度环、右键菜单、长按拖拽重排）
│   │   │   ├── NewBookDialog.tsx#      新建作品弹窗
│   │   │   └── CoverPicker.tsx #       封面选择器（本地文件选择 + 预览 + JPG/PNG/WebP 格式校验）
│   │   ├── editor/             #     编辑器相关
│   │   │   ├── RichTextEditor.tsx#     TipTap 富文本编辑器（11 个扩展、双保险自动保存、Placeholder）
│   │   │   ├── EditorToolbar.tsx#      编辑器工具栏（返回/目录/模式切换/面板开关/保存状态）
│   │   │   └── SnapshotPanel.tsx#      版本历史面板（里程碑快照/预览/恢复/删除）
│   │   ├── outline/            #     目录相关
│   │   │   └── OutlinePanel.tsx#       卷-章节目录树（新建/折叠/重命名/状态标签/上下文菜单）
│   │   ├── worldbuilding/      #     世界观资料库
│   │   │   ├── WorldbuildingPanel.tsx#  资料库面板（6 种类型过滤/搜索/卡片列表/独立窗口模式）
│   │   │   └── WorldCardEditor.tsx#     卡片编辑弹窗（类型/标题/富文本详情/标签）
│   │   ├── ai/                 #     AI 助手
│   │   │   └── AiSidePanel.tsx #       AI 侧面板（Ollama 流式对话/RAG 检索/快捷提示词）
│   │   ├── layout/             #     布局组件
│   │   │   ├── EditorLayout.tsx#       编辑器三栏布局容器
│   │   │   └── StatusBar.tsx   #       底部状态栏（章节名/字数/保存状态）
│   │   ├── diff/               #     预留：版本对比视图（Phase 3）
│   │   └── ui/                 #     预留：通用 UI 组件
│   │
│   ├── stores/                 #   状态管理
│   │   ├── appStore.ts         #     Zustand 全局业务状态（书籍/卷/章节/AI配置/主题/护眼/字体/网格/编辑器宽度）
│   │   ├── pluginStore.ts      #     Zustand 插件状态（已安装插件列表、启用/禁用/卸载）
│   │   └── uiAtoms.ts          #     Jotai UI 原子状态（13 个：面板开关/保存状态/字数/搜索/刷新等）
│   │
│   ├── plugins/                #   插件系统
│   │   ├── index.ts            #     插件系统入口（导出类型/管理器 + definePlugin 辅助函数）
│   │   ├── types.ts            #     插件类型定义（6 个扩展点/PluginManifest/PluginContext/PluginCommand）
│   │   ├── PluginManager.ts    #     插件管理器单例（注册/启用/禁用/卸载/生命周期/按扩展点获取命令）
│   │   └── examples/
│   │       └── charCounter.ts  #     示例插件：字符统计
│   │
│   ├── lib/                    #   工具库
│   │   ├── tauri-bridge.ts     #     Tauri IPC 桥接层（7 个 API 模块，类型安全封装）
│   │   └── utils.ts            #     工具函数（cn/格式化/字数统计/配置常量/防抖/深拷贝/截断）
│   │
│   ├── types/                  #   类型定义
│   │   └── index.ts            #     核心类型（15 个：Book/Volume/Chapter/Snapshot/WorldCard/AiConfig/RagResult 等）
│   │
│   ├── styles/                 #   样式
│   │   └── globals.css         #     全局样式（四套主题 CSS 变量/编辑器排版/护眼模式 prose 覆盖/专注模式/滚动条）
│   │
│   └── hooks/                  #   预留：自定义 Hooks
│
└── src-tauri/                  # Rust 后端
    ├── Cargo.toml              #   Rust 项目配置（13 个 crate 依赖，含 deep-link）
    ├── tauri.conf.json         #   Tauri 应用配置（窗口 1280x800、CSP、DMG+NSIS 打包、更新器、插件、ukcoder 协议）
    ├── build.rs                #   Tauri 构建脚本
    ├── capabilities/
    │   └── default.json        #     Tauri v2 权限配置（含 deep-link:default）
    │
    ├── src/                    #   Rust 源码
    │   ├── main.rs             #     入口（调用 lib.rs 的 run()）
    │   ├── lib.rs              #     应用主逻辑（5 个插件初始化、数据库初始化、IPC 命令注册）
    │   ├── db/
    │   │   └── mod.rs          #     数据库层（r2d2 连接池、WAL 模式、外键约束、5 张表 DDL、6 个索引）
    │   ├── models/
    │   │   └── mod.rs          #     Serde 数据模型（5 个结构体，snake_case ↔ camelCase）
    │   └── commands/           #     IPC 命令模块
    │       ├── mod.rs          #       模块声明（8 个命令模块）
    │       ├── book.rs         #       书籍管理（CRUD + list + set_cover，封面格式校验，复制到数据目录）
    │       ├── volume.rs       #       卷管理（CRUD + list + 排序）
    │       ├── chapter.rs      #       章节管理（CRUD/保存/重命名/状态更新/软删除/排序，自动更新全书字数）
    │       ├── snapshot.rs     #       版本快照（创建/列表/查看/恢复/删除，恢复时覆盖章节内容并更新字数）
    │       ├── world_card.rs   #       世界观卡片（CRUD + LIKE 关键词搜索，最多 20 条）
    │       ├── ai.rs           #       AI & 向量检索（RAG LIKE 降级实现 + Embedding 占位）
    │       ├── io.rs           #       导入导出（TXT/MD/HTML 导出 + TXT 正则分章导入）
    │       └── window.rs       #       多窗口管理（打开/关闭世界观独立悬浮窗口，always_on_top，事件通知）
    │
    ├── icons/                  #   应用图标资源（各尺寸 PNG + icns/ico）
    └── gen/schemas/            #   Tauri 自动生成的 JSON Schema
```

---

## 数据库设计（5 张表）

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `books` | 书籍元信息 | id, title, author, description, cover_image, word_count, daily_target, tags(JSON) |
| `volumes` | 卷信息 | id, book_id(FK CASCADE), title, sort_order |
| `chapters` | 章节内容 | id, book_id(FK CASCADE), volume_id, title, content_html, word_count, status, sort_order, deleted_at |
| `snapshots` | 版本快照 | id, chapter_id(FK CASCADE), content_html, type(auto/milestone), label |
| `world_cards` | 世界观卡片 | id, book_id(FK CASCADE), type(6种), title, content_html, tags(JSON), vectorized |

**6 个索引**：book_id（volumes/chapters/world_cards）、chapter_id（snapshots）、deleted_at（chapters）、updated_at（chapters）

---

## 核心架构

- **Tauri v2 IPC**：前端 `invoke()` → `tauri-bridge.ts` 类型安全封装 → Rust 命令处理 → r2d2 连接池 → SQLite 读写
- **双层状态管理**：Zustand（业务数据 + 插件状态）+ Jotai（UI 原子状态）
- **双保险自动保存**：300ms 防抖 + 3 分钟定时
- **软删除**：章节使用 `deleted_at` 字段，非物理删除
- **RAG 占位**：AI 模块预留语义检索接口，当前 LIKE 降级，Phase 4 接入 sqlite-vec
- **多窗口支持**：世界观资料库可独立为悬浮窗口（always_on_top），通过 Tauri 事件通信
- **插件系统**：6 个扩展点（editor/menu/toolbar/settings/ai/search），PluginManager 单例驱动
- **四套主题**：亮色 + 暗色 + 暖黄护眼 + 豆沙绿护眼（亮/暗模式各一套独立 CSS 变量）
- **深度链接**：`ukcoder://` 自定义 URL Scheme，基于 `tauri-plugin-deep-link`，支持外部应用唤起与参数传递

---

## 状态管理详解

### Zustand AppStore
书籍列表、当前书籍/章节、卷/章节树、AI 配置、主题/护眼/字体/网格/编辑器宽度偏好（localStorage 持久化）、CRUD actions

### Zustand PluginStore
已安装插件列表、启用/禁用/卸载操作，通过 PluginManager 单例交互

### Jotai UI Atoms（13 个）
| atom | 说明 |
|------|------|
| `editorFocusAtom` | 编辑器是否聚焦 |
| `diffViewModeAtom` | Diff 对比视图模式（side-by-side/inline） |
| `sidebarOpenAtom` | 侧边栏展开状态 |
| `aiPanelOpenAtom` | AI 对话面板展开 |
| `historyPanelOpenAtom` | 版本历史面板展开 |
| `zenModeAtom` | 专注模式 |
| `hoverKeywordAtom` | 当前悬浮速览关键词 |
| `modalStackAtom` | 模态框栈（嵌套弹窗管理） |
| `isSavingAtom` | 正在保存状态 |
| `lastSavedAtom` | 最后保存时间 |
| `wordCountAtom` | 字数统计（章节 + 总计） |
| `searchOpenAtom` | 搜索面板 |
| `contentRefreshAtom` | 内容刷新计数器（恢复快照等场景触发编辑器重载） |

---

## 插件系统详解

### 6 个扩展点
| 扩展点 | 说明 |
|--------|------|
| `editor` | 编辑器功能扩展 |
| `menu` | 菜单项扩展 |
| `toolbar` | 工具栏按钮扩展 |
| `settings` | 设置面板扩展 |
| `ai` | AI 功能扩展 |
| `search` | 搜索功能扩展 |

### PluginManager API
- `register(plugin)` — 注册插件
- `enable(id)` / `disable(id)` / `uninstall(id)` — 生命周期管理
- `getCommandsByExtensionPoint(point)` — 按扩展点获取命令
- `executeCommand(id, context)` — 执行命令
- `subscribe(callback)` — 状态变化订阅
- 内置示例：`charCounter` 字符统计插件

---

## 开发命令

```bash
pnpm dev          # 仅启动前端 Vite 开发服务器
pnpm tauri dev    # 启动 Tauri 桌面应用开发模式
pnpm build        # 生产构建（tsc + vite build）
pnpm preview      # 预览生产构建
pnpm tauri build  # Tauri 桌面应用打包
pnpm check        # 运行完整性检测
```
