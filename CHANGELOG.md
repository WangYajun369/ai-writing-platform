# 更新日志

### v0.3.0 (2026-06-08)

#### 新增
- 图片插入：通过 Tauri 原生文件对话框选择本地图片直接插入编辑器
- 图片缩放：新增 ResizableImage 扩展，支持拖拽控制点和工具栏调整图片尺寸（宽度/高度独立缩放）
- 任务列表：新增 TaskList/TaskItem 扩展，支持复选框任务清单
- 编辑器工具栏增强：新增标题、无序列表、有序列表、任务列表、代码块等格式化按钮

#### 优化
- 编辑器实例通过 Jotai atom 共享至工具栏，实现跨组件联动
- 代码块样式重构：自定义字体、圆角、暗色模式适配
- 新增 MIT License 开源许可证

### v0.2.5 (2026-06-08)

#### 优化
- 优化 macOS 构建签名流程：增加 keychain 签名身份验证步骤，签名前先检测证书是否存在；显式设置无证书时的签名身份为 `-`，防止 Tauri 自动寻找错误身份

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
