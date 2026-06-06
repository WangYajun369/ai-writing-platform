# MirageInk（幻境水墨）— 项目目录说明

> 跨平台桌面端小说写作软件 | Tauri v2 + React + Rust + SQLite

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 |
| 前端框架 | React 18 + TypeScript 5 + Vite 8 |
| 样式方案 | TailwindCSS 3 + CSS 变量色彩体系 |
| 富文本编辑 | TipTap（H1-H3/加粗/斜体/下划线/颜色/图片/表格/字数统计） |
| 状态管理 | Zustand（业务数据）+ Jotai（UI 原子状态） |
| 路由 | React Router v7 |
| 后端语言 | Rust 2021 Edition |
| 数据库 | SQLite（WAL 模式）+ rusqlite（bundled） |
| 包管理 | pnpm >= 9, Node >= 20 |

---

## 目录结构

```
MirageInk/
├── index.html                  # SPA 入口 HTML
├── package.json                # 项目配置（18 dependencies + 14 devDependencies）
├── pnpm-lock.yaml               # pnpm 锁文件
├── tsconfig.json                # TypeScript 编译配置（路径别名 @/* -> ./src/*）
├── tsconfig.node.json           # vite.config.ts 专用 TypeScript 配置
├── vite.config.ts               # Vite 构建配置（端口 1420/1421，路径别名 @）
├── tailwind.config.ts           # TailwindCSS 配置（暗黑主题、HSL 色彩系统、自定义字体）
├── postcss.config.js           # PostCSS 配置（tailwindcss + autoprefixer）
├── .gitignore                   # Git 忽略配置
├── .npmrc                       # pnpm 配置（hoisted 模式，解决 Tauri native 模块问题）
│
├── scripts/                     # 脚本工具
│   ├── check.mjs                #   67 项完整性自动检测脚本（7 大类检查）
│   ├── gen_icons_rgba.py        #   预留图标生成脚本
│   └── gen_icons.py             #   预留图标生成脚本
│
├── src/                         # React 前端源码
│   ├── main.tsx                 #   应用入口（ReactDOM.createRoot + StrictMode）
│   ├── App.tsx                  #   根组件（Jotai Provider + 主题切换 light/dark/system）
│   ├── router/
│   │   └── index.tsx            #   路由定义（/书库、/editor/:bookId、/settings）
│   │
│   ├── pages/                   #   页面组件
│   │   ├── LibraryPage.tsx      #     书库首页（搜索、排序、网格/列表视图、新建作品）
│   │   ├── EditorPage.tsx       #     编辑器主页面（三栏布局：目录树/编辑器/右侧面板）
│   │   └── SettingsPage.tsx     #     设置页面（AI 配置/外观/存储管理）
│   │
│   ├── components/              #   功能组件
│   │   ├── library/             #     书库相关
│   │   │   ├── BookCard.tsx     #       书籍卡片（网格/列表双模式、日更进度环、右键菜单）
│   │   │   └── NewBookDialog.tsx#       新建作品弹窗
│   │   ├── editor/              #     编辑器相关
│   │   │   ├── RichTextEditor.tsx#     TipTap 富文本编辑器（11 个扩展、双保险自动保存）
│   │   │   ├── EditorToolbar.tsx#      编辑器工具栏（返回/目录/模式切换/面板开关/保存状态）
│   │   │   └── SnapshotPanel.tsx#      版本历史面板（里程碑快照/预览/恢复/删除）
│   │   ├── outline/             #     目录相关
│   │   │   └── OutlinePanel.tsx #       卷-章节目录树（新建/折叠/重命名/状态标签）
│   │   ├── worldbuilding/       #     世界观资料库
│   │   │   ├── WorldbuildingPanel.tsx#  资料库面板（6 种类型过滤/搜索/卡片列表）
│   │   │   └── WorldCardEditor.tsx#     卡片编辑弹窗（类型/标题/详情/标签）
│   │   ├── ai/                  #     AI 助手
│   │   │   └── AiSidePanel.tsx  #       AI 侧面板（Ollama 流式对话/RAG 检索/快捷提示词）
│   │   ├── layout/              #     布局组件
│   │   │   ├── EditorLayout.tsx #       编辑器布局容器
│   │   │   └── StatusBar.tsx    #       底部状态栏（章节名/字数/保存状态）
│   │   ├── diff/                #     预留：版本对比视图（Phase 3）
│   │   └── ui/                  #     预留：通用 UI 组件
│   │
│   ├── stores/                  #   状态管理
│   │   ├── appStore.ts          #     Zustand 全局业务状态（书籍/章节/加载/AI 配置/主题）
│   │   └── uiAtoms.ts           #     Jotai UI 原子状态（14 个：面板开关/保存状态/字数等）
│   │
│   ├── lib/                     #   工具库
│   │   ├── tauri-bridge.ts      #     Tauri IPC 桥接层（31 个 invoke 调用，7 个 API 模块）
│   │   └── utils.ts             #     工具函数（cn/格式化/字数统计/配置常量等）
│   │
│   ├── types/                   #   类型定义
│   │   └── index.ts             #     核心类型（12 个：Book/Volume/Chapter/Snapshot 等）
│   │
│   ├── styles/                  #   样式
│   │   └── globals.css          #     全局样式（Tailwind/CSS 变量/编辑器样式/暗黑主题）
│   │
│   └── hooks/                   #   预留：自定义 Hooks
│
└── src-tauri/                   # Rust 后端
    ├── Cargo.toml               #   Rust 项目配置（10 个 crate 依赖）
    ├── tauri.conf.json          #   Tauri 应用配置（窗口 1280x800、CSP、插件）
    ├── build.rs                 #   Tauri 构建脚本
    ├── capabilities/
    │   └── default.json         #     Tauri v2 权限配置（15 条权限）
    │
    ├── src/                     #   Rust 源码
    │   ├── main.rs              #     入口（调用 lib.rs 的 run()）
    │   ├── lib.rs               #     应用主逻辑（插件初始化、数据库初始化、31 个 IPC 命令注册）
    │   ├── db/
    │   │   └── mod.rs           #     数据库层（WAL 模式、外键约束、5 张表 DDL）
    │   ├── models/
    │   │   └── mod.rs           #     Serde 数据模型（5 个结构体，snake_case ↔ camelCase）
    │   └── commands/            #     IPC 命令模块
    │       ├── mod.rs           #       模块声明
    │       ├── book.rs          #       书籍管理（5 个命令：CRUD + list）
    │       ├── volume.rs        #       卷管理（5 个命令：CRUD + list + 排序）
    │       ├── chapter.rs       #       章节管理（8 个命令：CRUD/保存/重命名/软删除/排序）
    │       ├── snapshot.rs      #       版本快照（5 个命令：创建/列表/查看/恢复/删除）
    │       ├── world_card.rs    #       世界观卡片（5 个命令：CRUD + 搜索）
    │       ├── ai.rs            #       AI & 向量检索（2 个命令：RAG 占位/embedding 占位）
    │       └── io.rs            #       导入导出（2 个命令：TXT/MD/HTML 导出 + TXT 导入）
    │
    ├── icons/                   #   应用图标资源（各尺寸 PNG + icns/ico）
    └── gen/schemas/             #   Tauri 自动生成的 JSON Schema
```

---

## 数据库设计（5 张表）

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `books` | 书籍元信息 | id, title, author, description, word_count, daily_target, tags(JSON) |
| `volumes` | 卷信息 | id, book_id(FK CASCADE), title, sort_order |
| `chapters` | 章节内容 | id, book_id(FK CASCADE), volume_id, title, content_html, word_count, status, deleted_at |
| `snapshots` | 版本快照 | id, chapter_id(FK CASCADE), content_html, type(auto/milestone), label |
| `world_cards` | 世界观卡片 | id, book_id(FK CASCADE), type(6种), title, content, tags(JSON), vectorized |

---

## 核心架构

- **Tauri v2 IPC**：前端 `invoke()` → `tauri-bridge.ts` 类型安全封装 → Rust 命令处理 → SQLite 读写
- **双层状态管理**：Zustand（业务数据）+ Jotai（UI 原子状态）
- **双保险自动保存**：300ms 防抖 + 3 分钟定时
- **软删除**：章节使用 `deleted_at` 字段，非物理删除
- **RAG 占位**：AI 模块预留语义检索接口，当前 LIKE 降级，Phase 4 接入 sqlite-vec

---

## 开发命令

```bash
pnpm dev          # 启动开发服务器（Tauri + Vite）
pnpm build        # 生产构建
pnpm preview      # 预览生产构建
pnpm tauri         # Tauri CLI 命令
pnpm check         # 运行 67 项完整性检测
```
