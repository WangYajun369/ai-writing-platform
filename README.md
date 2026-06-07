# TimeWrite（智写时光）

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
| **深度链接** | com.ukcoder.timewrite 协议（`com.ukcoder.timewrite://`），支持外部应用唤起与参数传递 |

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
- 集成智谱 BigModel 流式对话 + 自定义 OpenAI 兼容端点，支持 RAG 上下文检索
- 快捷提示词：续写/润色/剧情推演/角色分析
- 默认模型：`glm-4.6v`，Embedding：`embedding-3`

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

### com.ukcoder.timewrite 协议（深度链接）
- 注册 `com.ukcoder.timewrite://` 自定义 URL Scheme，支持从外部应用（浏览器/其他桌面应用）唤起 TimeWrite
- 支持参数传递（如 `com.ukcoder.timewrite://open?bookId=xxx`），实现快速跳转到指定作品/章节
- 基于 Tauri v2 deep-link 插件，自动处理 macOS 和 Windows 平台注册

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
TimeWrite/
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

### v0.2.4 (2026-06-07)

#### 优化
- 修复 GitHub Actions `if:` 条件中对 secrets 的引用方式（`env.*` → `secrets.*`），确保 macOS 构建正确跳过签名步骤
- 优化 Apple 代码签名流程：签名身份改为环境变量注入，避免硬编码在构建命令中
- 修复 macOS 公证步骤：改为公证 `.dmg` 文件而非 `.app` 包

### v0.2.3 (2026-06-07)

#### 优化
- 精简 AI 服务商为智谱 BigModel + 自定义，移除 Ollama/OpenAI 支持，统一使用 OpenAI 兼容协议
- SSE 流处理代码重构：提取 `flush_sse_buffer` 公共函数，消除重复的 buffer 残留处理逻辑
- 应用版本号改为运行时从 Tauri 动态获取，不再硬编码在 SettingsPage 中
- 默认 AI 配置改为智谱 BigModel（`glm-4.6v` / `embedding-3`）

### v0.2.2 (2026-06-07)

#### 优化
- 项目全面重命名：MirageInk（幻境水墨）→ TimeWrite（智写时光），涵盖 Rust 包名、数据库路径、localStorage 键名、组件注释及所有文档
- 图标资源重新生成，移除废弃的 Android/iOS 平台图标，新增圆角源图标
- 脚本目录重组：图标生成脚本移至 scripts/，统一管理

### v0.2.1 (2026-06-07)

#### 优化
- 更新 version-release 技能配置，完善版本发布与提交工作流程
- 同步 Cargo.lock 依赖锁定文件版本号

### v0.2.0 (2026-06-07)

#### 新增
- RAG 语义检索：新增 embeddings 数据表，支持章节/世界观卡片的向量索引与余弦相似度搜索
- AI 侧边栏重构：改进 UI/UX，扩展后端 AI 命令，完善 AI 设置页面
- 网格尺寸设置：书库页支持 small/medium/large 三种网格尺寸，动态调整列数和行高
- 编辑器宽度设置：支持 mobile/standard/wide 三种编辑器宽度
- 全局 CSS 样式系统与变量

#### 优化
- 移除打字机模式，字体大小滑块改为 +/- 按钮操作
- 更新 npm 与 Cargo 依赖至最新版本
- 清理冗余文件，更新项目配置与文档

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
| 应用名称 | TimeWrite |
| 应用标识 | `com.ukcoder.timewrite` |
| 版本 | 0.2.4 |
| 窗口默认尺寸 | 1280 × 800 |
| 窗口最小尺寸 | 800 × 600 |
| 深度链接协议 | `com.ukcoder.timewrite://` |

## 许可证

MIT
