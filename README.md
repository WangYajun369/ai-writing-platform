# MirageInk（幻境水墨）

跨平台桌面端小说写作软件 —— Tauri v2 + React 18 + TipTap

面向网络小说作者和文学创作者，提供从书库管理、章节编辑到 AI 辅助创作的完整写作工作流。

## 技术栈

| 层级 | 技术 |
|------|------|
| **桌面框架** | Tauri v2 |
| **前端** | React 18 + TypeScript 5 + Vite 8 |
| **样式** | TailwindCSS 3 + HSL CSS 变量色彩体系（亮色/暗色/暖黄/豆沙绿四套主题） |
| **富文本** | TipTap（H1-H3/加粗/斜体/下划线/颜色/图片/表格/字符计数/Placeholder） |
| **状态管理** | Zustand（业务数据 + 插件状态）+ Jotai（UI 原子状态，13 个 atom） |
| **路由** | React Router v7（懒加载 Editor/Settings 页面） |
| **后端** | Rust 2021 + SQLite（WAL 模式）+ rusqlite（bundled）+ r2d2 连接池 |
| **包管理** | pnpm >= 9，Node >= 20 |
| **深度链接** | ukcoder 协议（`ukcoder://`），支持外部应用唤起与参数传递 |

## 功能特性

### 书库管理
- 多作品管理，网格/列表双视图切换，虚拟化滚动
- 搜索、排序（时间/字数/书名）
- 创建/删除作品，书籍封面设置（JPG/PNG/WebP）
- 每日写作目标 + 进度环可视化

### 章节编辑
- TipTap 富文本编辑器（H1-H3、加粗/斜体/下划线/颜色、图片、表格、Placeholder 占位提示）
- 卷-章节两级目录树，新建/重命名/折叠/状态标签
- 双保险自动保存（300ms 防抖 + 3 分钟定时），底部状态栏实时显示保存状态
- 中文字数统计（HTML 解析去标签）

### 专注写作
- 专注模式：隐藏侧栏/工具栏/状态栏，Esc 退出

### 世界观资料库
- 6 种卡片类型：人物/地点/时间线/势力/物品/其他
- 搜索、标签、过滤
- 独立悬浮窗口模式（always_on_top，420x650）

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

### 个性化设置
- 浅色/深色/跟随系统主题切换
- 护眼模式：暖黄色 / 豆沙绿（亮色 + 暗色各一套）
- 全局字体切换（衬线/黑体/宋体/楷体/微软雅黑）
- 字体大小自定义（12-24px）
- 作品列表网格尺寸（小/中/大）
- 编辑器显示宽度（移动端/标准/宽屏）

### 插件系统
- 6 个扩展点（editor/menu/toolbar/settings/ai/search），支持生命周期管理
- PluginManager 单例驱动，启用/禁用/卸载
- 内置字符统计示例插件

### ukcoder 协议（深度链接）
- 注册 `ukcoder://` 自定义 URL Scheme，支持从外部应用（浏览器/其他桌面应用）唤起 MirageInk
- 支持参数传递（如 `ukcoder://open?bookId=xxx`），实现快速跳转到指定作品/章节
- 基于 Tauri v2 deep-link 插件，自动处理 mac OS 和 Windows 平台注册

### 其他
- 完整性自动检测脚本
- 更新器插件集成（GitHub Releases）
- 代码分割优化（TipTap、Lucide、状态库等独立 chunk）

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发模式（首次会编译 Rust，需要数分钟）
pnpm tauri dev

# 仅启动前端 Vite 预览
pnpm dev

# 运行完整性检测
pnpm check
```

## 构建发布

```bash
pnpm tauri build
```

打包目标：macOS（DMG） + Windows（NSIS 安装包）

## 项目结构

```
MirageInk/
├── src/                         # React 前端
│   ├── components/
│   │   ├── library/             # 书库：BookCard / NewBookDialog / CoverPicker
│   │   ├── editor/              # 编辑器：RichTextEditor / EditorToolbar / SnapshotPanel
│   │   ├── outline/             # 目录树面板 OutlinePanel
│   │   ├── worldbuilding/       # 世界观资料库：WorldbuildingPanel / WorldCardEditor
│   │   ├── ai/                  # AI 助手侧面板 AiSidePanel
│   │   ├── layout/              # 布局容器 EditorLayout + 底部状态栏 StatusBar
│   │   ├── diff/                # （预留）版本对比视图
│   │   └── ui/                  # （预留）通用 UI 组件
│   ├── pages/                   # 页面：Library / Editor / Settings
│   ├── stores/                  # Zustand（appStore + pluginStore）+ Jotai（uiAtoms）
│   ├── plugins/                 # 插件系统：PluginManager / 类型定义 / 示例插件
│   ├── lib/                     # 工具函数 + Tauri IPC 桥接（7 个 API 模块）
│   ├── types/                   # TypeScript 类型定义（15 个核心类型）
│   ├── router/                  # React Router v7 路由
│   ├── styles/                  # 全局样式（四套主题 CSS 变量）
│   └── hooks/                   # （预留）自定义 Hooks
├── src-tauri/                   # Rust 后端
│   └── src/
│       ├── commands/            # IPC 命令（book/volume/chapter/snapshot/world_card/ai/io/window）
│       ├── db/                  # SQLite 连接池 + 5 张表 DDL + 6 个索引
│       └── models/              # Serde 数据模型
└── scripts/check.mjs            # 完整性检测脚本
```

## 数据库设计

| 表名 | 说明 |
|------|------|
| books | 书籍元信息（标题、作者、描述、封面路径、字数、日更目标、标签等） |
| volumes | 卷信息（书名、排序） |
| chapters | 章节内容（HTML、字数、状态、软删除） |
| snapshots | 版本快照（auto/milestone 类型） |
| world_cards | 世界观卡片（6 种类型、标签、向量化标记） |

## Roadmap

| Phase | 状态 | 内容 |
|-------|------|------|
| Phase 1 | ✅ 完成 | 工程骨架、书库管理、TipTap 编辑、SQLite CRUD |
| Phase 2 | ✅ 完成 | 自动保存、专注模式、导入导出、图片/表格、世界观资料库、AI 助手、版本快照、多窗口/护眼模式/字体系统/插件系统框架 |
| Phase 3 | 🔜 规划 | react-diff-viewer 版本对比视图、EPUB/PDF 导出 |
| Phase 4 | 🔜 规划 | sqlite-vec 向量语义检索 + Ollama RAG |
| Phase 5 | 🔜 规划 | 跨平台打包发布（macOS DMG + Windows NSIS） |

## 更新日志

### v0.1.0 (2026-06-03)

#### 新增
- 工程骨架搭建：Tauri v2 + React 18 + TypeScript + Vite 8 + TailwindCSS
- 书库管理：多作品网格/列表视图、虚拟化滚动、搜索排序、创建/删除、封面设置
- TipTap 富文本编辑器：H1-H3、加粗、斜体、下划线、颜色、图片、表格、Placeholder、字数统计
- 卷-章节两级目录树：新建/重命名/折叠/状态标签
- SQLite 数据持久化：5 张表、WAL 模式、r2d2 连接池、外键级联删除、6 个索引
- IPC 命令封装：7 个 API 模块（bookApi / volumeApi / chapterApi / snapshotApi / worldCardApi / aiApi / importExportApi）
- 双层状态管理：Zustand（appStore + pluginStore）+ Jotai（13 个 UI atom）
- 双保险自动保存：300ms 防抖 + 3 分钟定时
- 专注模式
- 世界观资料库：6 种卡片类型、搜索/标签/过滤、独立悬浮窗口
- AI 助手：Ollama 流式对话 + RAG 上下文检索 + 快捷提示词
- 版本快照：auto/milestone 类型，支持内容恢复
- 导入导出：导出 TXT/MD/HTML，导入 TXT 自动正则分章
- 主题系统：浅色/深色/跟随系统 + 暖黄/豆沙绿护眼模式（亮/暗各一套）
- 全局字体切换（5 种）+ 字体大小自定义（12-24px）
- 编辑器宽度自定义 + 网格尺寸偏好
- 写作目标：每日字数目标 + 进度环可视化
- 底部状态栏：章节名/字数/保存状态
- 插件系统框架：6 个扩展点、PluginManager、示例插件
- 完整性自动检测脚本
- HSL CSS 变量色彩体系（shadcn/ui 风格）
- 自定义滚动条样式
- 代码分割优化（TipTap / Lucide / 状态库独立 chunk）
- 更新器插件集成（GitHub Releases）

## 应用信息

| 项目 | 值 |
|------|------|
| 应用名称 | MirageInk |
| 应用标识 | `com.ukcoder.mirageink` |
| 版本 | 0.1.0 |
| 窗口默认尺寸 | 1280 × 800 |
| 窗口最小尺寸 | 800 × 600 |
| 深度链接协议 | `ukcoder://` |

## 许可证

MIT
