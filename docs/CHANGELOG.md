# 更新日志

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
