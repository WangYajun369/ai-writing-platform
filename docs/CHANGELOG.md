# 更新日志

## v0.7.0 (2026-06-10)

### 新增
- 通用 ContextMenu 组件：新增右键菜单系统，支持全局上下文操作
- AI 请求详情面板：新增 RequestDetailModal 组件，支持查看 AI 请求详情与消息删除
- AI 工具箱面板：新增 AiToolboxPanel，集成章末总结/续写/扩写等 AI 写作辅助工具
- 章节摘要头部：新增 ChapterSummaryHeader 组件，展示章节摘要信息
- AI 对话增强：新增 MessageBubble、useAiChat hook，重构 AiSidePanel 对话流程
- 回收站管理：新增 TrashModal 组件，支持软删除数据的恢复与永久删除
- 设置页面全面重构：新增独立配置组件（外观/编辑器/存储/AI/RAG/聊天/工具箱/版本），实现模块化设置管理
- 版本信息展示：新增 VersionSection，运行时动态展示应用版本与更新信息
- AI 服务商预设：新增 ChatConfigSection 和 RAGConfigSection，预设常用模型配置

### 优化
- 拆分 SettingsPage 为独立配置组件，提取 useResizeHandle 通用 hook
- 重构快照面板布局与窗口管理，优化编辑器工具栏交互
- 书籍管理增强：BookCard 右键菜单支持编辑/删除，EditBookDialog 和 NewBookDialog 功能完善
- AI 后端命令增强：ai.rs 扩展多项 IPC 命令，支持工具箱 API 调用
- Tauri 窗口管理扩展：window.rs 新增辅助窗口创建与管理能力
- 状态管理扩展：appStore 新增回收站、AI 配置、章节摘要等状态字段

## v0.6.0 (2026-06-09)

### 新增
- ErrorBoundary 组件：新增全局错误边界，捕获渲染异常并展示友好提示，提升应用稳定性

### 优化
- 升级 Tiptap 编辑器至 v3：RichTextEditor、EditorToolbar 适配新 API，编辑器性能更优
- 迁移 Tailwind CSS v3 到 v4：移除 tailwind.config.ts，采用 CSS-first 配置，优化构建性能
- 重构存储层：appStore 状态管理全面重构，优化渲染性能，涉及 App.tsx、EditorPage、LibraryPage、AiSidePanel 等多处适配
- 核心依赖版本大升级：更新 Rust/Node 依赖至最新版本，移除废弃依赖
- 样式增强：globals.css 扩展动画与基础样式，提升 UI 细节

## v0.5.0 (2026-06-09)

### 新增
- 编辑器工具栏大幅增强：新增字体颜色选择、标题层级、列表、代码块、任务列表等格式化按钮
- TrailingNodeExtension：新增尾部节点扩展，确保编辑器末尾始终可编辑
- 大纲面板全面重构：支持卷/章节拖拽排序、软删除、插入指示器动画，交互体验大幅提升
- 编辑位置记忆与恢复：滚动位置和光标位置自动保存，切换章节后恢复上次编辑位置
- 版本检查工具：新增 Rust 依赖版本检测（check-rust-versions.ts）和项目完整性检测（check-versions.ts）脚本

### 修复
- 修复卷/章节排序逻辑在拖拽场景下的边界问题
- 修复章节移动到不同卷时的状态同步问题

### 优化
- 文档全面更新：所有用户指南和架构文档同步至 v0.4.0 代码现状
- 章节命令模块重构：新增 chapter.rs 独立命令文件，支持章节排序和卷迁移
- 卷操作支持软删除（deletedAt 字段），保留历史数据可恢复
- 全局样式增强：新增 pop-in、pulse-indicator 动画，编辑器 UI 细节打磨
- 编辑器状态管理扩展：saveEditorState 方法支持滚动/光标位置持久化

## v0.4.0 (2026-06-08)

### 新增
- DeepSeek 对话支持：新增 DeepSeek 服务商选项，支持思考模式（thinking），对话 API Key 按服务商独立管理
- AI 配置解耦：对话（AiChatConfig）与 RAG/Embedding（RagConfig）配置完全分离，各自独立管理 API Key 和模型
- 编辑器字体颜色选择：工具栏新增字体颜色按钮，支持预设色板和自定义颜色
- 作品信息编辑：新增 EditBookDialog 组件，支持编辑书名、封面、简介等作品元信息
- 产品宣传页：新增 product/ 目录宣传页面，含微信分享合规信息，支持 GitHub Pages 自动部署
- README 重构为 Wiki 导航，新增赞助与联系方式

### 修复
- 修复外观设置持久化缺失：gridSize/editorWidth 分别独立保存，避免覆盖丢失
- 修复 DeepSeek API 路径拼接：自动补全 /chat/completions 后缀
- 修复 GitHub Wiki 子目录展平问题，增强部署流程稳健性

### 优化
- SettingsPage 重构：新增 RAG 独立配置区，支持连通性测试（test_rag_connection 命令）
- AI 架构重构：新增 RagConfig/AiChatConfig 分离类型，getChatApiKey/getRagApiKey 工具函数
- 文档结构重组为 GitHub Wiki，配置 CI 自动部署
- 添加 GitHub Issue 模板（Bug 报告 & 功能请求）及集成总览文档
- Vite 构建优化：dependabot 依赖分组，chunk 名称更新（react-markdown/remark-gfm）

## v0.3.0 (2026-06-08)

### 新增
- 图片插入：通过 Tauri 原生文件对话框选择本地图片直接插入编辑器
- 图片缩放：新增 ResizableImage 扩展，支持拖拽控制点和工具栏调整图片尺寸
- 任务列表：新增 TaskList/TaskItem 扩展，支持复选框任务清单
- 编辑器工具栏增强：新增标题、无序列表、有序列表、任务列表、代码块等格式化按钮

### 优化
- 编辑器实例通过 Jotai atom 共享至工具栏，实现跨组件联动
- 代码块样式重构：自定义字体、圆角、暗色模式适配
- 新增 MIT License 开源许可证

## v0.2.5 (2026-06-08)

### 优化
- 优化 macOS 构建签名流程：增加 keychain 签名身份验证步骤

## v0.2.4 (2026-06-07)

### 优化
- 修复 GitHub Actions 条件引用方式
- 优化 Apple 代码签名流程
- 修复 macOS 公证步骤

## v0.2.3 (2026-06-07)

### 优化
- 精简 AI 服务商为智谱 BigModel + 自定义
- SSE 流处理代码重构
- 应用版本号改为运行时动态获取
- 默认 AI 配置改为智谱 BigModel

## v0.2.2 (2026-06-07)

### 优化
- 项目全面重命名：MirageInk → TimeWrite（智写时光）
- 图标资源重新生成

## v0.2.1 (2026-06-07)

### 优化
- 更新 version-release 技能配置
- 同步 Cargo.lock 依赖版本号

## v0.2.0 (2026-06-07)

### 新增
- RAG 语义检索
- AI 侧边栏重构
- 网格尺寸设置（small/medium/large）
- 编辑器宽度设置（mobile/standard/wide）
- 全局 CSS 样式系统

### 优化
- 移除打字机模式
- 更新依赖至最新版本

## v0.1.0 (2026-06-03)

### 新增
- 工程骨架搭建：Tauri v2 + React 18 + TypeScript + Vite 8 + TailwindCSS
- 书库管理：多作品网格/列表视图、虚拟化滚动
- TipTap 富文本编辑器：完整格式化支持
- 卷-章节两级目录树
- SQLite 数据持久化：6 张表、WAL 模式
- IPC 命令封装：7 个 API 模块
- 双层状态管理：Zustand + Jotai
- 双保险自动保存
- 专注模式
- 世界观资料库：6 种卡片类型
- AI 助手：流式对话 + RAG 检索
- 版本快照
- 导入导出：TXT/MD/HTML
- 主题系统：4 套主题
- 全局字体切换 + 字号自定义
- 插件系统框架
- 完整性检测脚本
