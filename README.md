# MirageInk（幻境水墨）

跨平台桌面端小说写作软件 —— Tauri v2 + React 18 + TipTap

面向网络小说作者和文学创作者，提供从书库管理、章节编辑到 AI 辅助创作的完整写作工作流。

## 技术栈

| 层级 | 技术 |
|------|------|
| **桌面框架** | Tauri v2 |
| **前端** | React 18 + TypeScript 5 + Vite 8 |
| **样式** | TailwindCSS 3 + CSS 变量色彩体系 |
| **富文本** | TipTap（标题/加粗/斜体/下划线/颜色/图片/表格） |
| **状态管理** | Zustand（业务数据）+ Jotai（UI 原子状态） |
| **后端** | Rust 2021 + SQLite（WAL 模式）+ rusqlite |
| **包管理** | pnpm >= 9，Node >= 20 |

## 功能特性

### 书库管理
- 多作品管理，网格/列表双视图切换
- 搜索、排序（时间/字数/书名）
- 创建/删除作品，每日写作目标 + 进度环可视化

### 章节编辑
- TipTap 富文本编辑器（H1-H3、加粗/斜体/下划线/颜色、图片、表格）
- 卷-章节两级目录树，拖拽排序、新建/重命名/折叠
- 自动保存（300ms 防抖 + 3 分钟定时），底部状态栏实时显示保存状态
- 中文字数统计（中文字符 + 英文单词混合计数）

### 专注写作
- 专注模式：隐藏侧栏/工具栏/状态栏，Esc 退出
- 打字机模式：内容区上下留白 40vh，聚焦当前行

### 世界观资料库
- 6 种卡片类型：人物/地点/时间线/势力/物品/其他
- 搜索、标签、过滤

### AI 助手
- 集成 Ollama 流式对话，支持 RAG 上下文检索
- 快捷提示词：续写/润色/剧情推演/角色分析
- 默认模型：`qwen2.5:7b`，Embedding：`bge-m3`

### 版本管理
- 章节 HTML 内容快照（auto/milestone 类型）
- 支持恢复到历史版本

### 导入导出
- 导出为 TXT / Markdown / HTML
- 导入 TXT，自动按正则识别章节分隔

### 其他
- 浅色/深色/跟随系统主题切换
- 67 项完整性自动检测脚本

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发模式（首次会编译 Rust，需要数分钟）
pnpm tauri dev

# 仅启动前端 Vite 预览
pnpm dev

# 运行完整性检测（67 项）
pnpm check
```

## 构建发布

```bash
pnpm tauri build
```

## 项目结构

```
MirageInk/
├── src/                         # React 前端
│   ├── components/
│   │   ├── library/             # 书库：书籍卡片、新建作品弹窗
│   │   ├── editor/              # 编辑器：TipTap 富文本、工具栏
│   │   ├── outline/             # 目录树面板
│   │   ├── worldbuilding/       # 世界观资料库
│   │   ├── ai/                  # AI 助手侧面板
│   │   ├── layout/              # 布局容器、状态栏
│   │   ├── diff/                # （预留）版本对比视图
│   │   └── ui/                  # （预留）通用 UI 组件
│   ├── pages/                   # 页面：Library / Editor / Settings
│   ├── stores/                  # Zustand + Jotai 状态
│   ├── lib/                     # 工具函数 + Tauri IPC 封装（31 个命令）
│   ├── types/                   # TypeScript 类型定义
│   ├── router/                  # React Router v7
│   ├── styles/                  # 全局样式（CSS 变量主题）
│   └── hooks/                   # （预留）自定义 Hooks
├── src-tauri/                   # Rust 后端
│   └── src/
│       ├── commands/            # IPC 命令（book/volume/chapter/snapshot/world_card/ai/io）
│       ├── db/                  # SQLite 初始化 + 5 张表 DDL
│       └── models/              # serde 数据模型
└── scripts/check.mjs            # 完整性检测脚本（67 项）
```

## 数据库设计

| 表名 | 说明 |
|------|------|
| books | 书籍元信息（标题、作者、描述、字数、标签等） |
| volumes | 卷信息（书名、排序） |
| chapters | 章节内容（HTML、字数、状态、软删除） |
| snapshots | 版本快照（auto/milestone 类型） |
| world_cards | 世界观卡片（6 种类型、标签、向量化标记） |

## Roadmap

| Phase | 状态 | 内容 |
|-------|------|------|
| Phase 1 | ✅ 完成 | 工程骨架、书库管理、TipTap 编辑、SQLite CRUD |
| Phase 2 | ✅ 完成 | 自动保存、专注/打字机模式、导入导出、图片/表格、世界观资料库、AI 助手、版本快照 |
| Phase 3 | 🔜 规划 | myers-diff 版本对比视图 |
| Phase 4 | 🔜 规划 | sqlite-vec 向量语义检索 + Ollama RAG |
| Phase 5 | 🔜 规划 | 跨平台打包发布 |

## 更新日志

### v0.1.0 (2026-06-03)

#### 新增
- 工程骨架搭建：Tauri v2 + React 18 + TypeScript + Vite 8 + TailwindCSS
- 书库管理：多作品网格/列表视图、搜索排序、创建/删除
- TipTap 富文本编辑器：标题、加粗、斜体、下划线、颜色、图片、表格、字数统计
- 卷-章节两级目录树：新建/重命名/折叠/排序
- SQLite 数据持久化：5 张表、WAL 模式、外键级联删除
- 31 个 IPC 命令封装（bookApi / volumeApi / chapterApi / snapshotApi / worldCardApi / aiApi / importExportApi）
- 双层状态管理：Zustand 业务数据 + Jotai UI 原子状态
- 自动保存：300ms 防抖 + 3 分钟定时双保险
- 专注模式与打字机模式
- 世界观资料库：6 种卡片类型、搜索/标签/过滤
- AI 助手：Ollama 流式对话 + RAG 上下文检索 + 4 个快捷提示词
- 版本快照：auto/milestone 类型，支持内容恢复
- 导入导出：导出 TXT/MD/HTML，导入 TXT 自动正则分章
- 浅色/深色/跟随系统主题切换
- 写作目标：每日字数目标 + 进度环可视化
- 底部状态栏：章节名/字数/保存时间
- 67 项完整性自动检测脚本
- CSS 变量 + HSL 色彩体系（shadcn/ui 风格）
- 自定义滚动条样式

## 应用信息

| 项目 | 值 |
|------|------|
| 应用名称 | MirageInk |
| 应用标识 | `com.ukcoder.mirageink.app` |
| 版本 | 0.1.0 |
| 窗口默认尺寸 | 1280 × 800 |
| 窗口最小尺寸 | 800 × 600 |

## 许可证

MIT
