# TimeWrite（智写时光）

跨平台桌面端小说写作软件 —— Tauri v2 + React 19 + TipTap

面向网络小说作者和文学创作者，提供从书库管理、章节编辑到 AI 辅助创作的完整写作工作流。

🌐 **项目介绍**：[https://wangyajun369.github.io/ai-writing-platform/](https://wangyajun369.github.io/ai-writing-platform/)

## 技术栈

| 层级 | 技术 |
|------|------|
| **桌面框架** | Tauri v2 |
| **前端** | React 19 + TypeScript 6 + Vite 8 |
| **样式** | TailwindCSS 4（CSS-first）+ HSL CSS 变量色彩体系（亮色/暗色/暖黄/豆沙绿四套主题） |
| **富文本** | TipTap（H1-H3/加粗/斜体/下划线/颜色/图片/表格/代码高亮/任务列表/字符计数/Placeholder） |
| **状态管理** | Zustand（业务数据 + 插件状态）+ Jotai（UI 原子状态） |
| **路由** | React Router v7（懒加载 Editor/Settings 页面） |
| **后端** | Rust 2021 + SQLite（WAL 模式）+ rusqlite（bundled）+ r2d2 连接池 |
| **AI 通信** | SSE 流式对话，reqwest stream + tokio 异步 |
| **Agent 引擎** | Rust 原生实现（Skill Prompt + SSE 流式 ReAct 工具循环），无外部进程 |
| **Agent 记忆** | SQLite 持久化（time_write.db memories 表，跨会话偏好/决策/经验记忆，关键词相关性检索） |
| **包管理** | pnpm >= 11，Node >= 22 |
| **深度链接** | com.ukcoder.timewrite 协议（`com.ukcoder.timewrite://`），支持外部应用唤起与参数传递 |

## 功能特性

### 书库管理
- 多作品管理，网格/列表双视图切换，虚拟化滚动
- 搜索、排序（时间/字数/书名）
- 创建/编辑/删除书籍，书籍封面设置（JPG/PNG/WebP）
- 每日写作目标 + 进度环可视化
- 回收站管理：软删除作品/卷/章节，支持恢复与永久删除
- 右键上下文菜单（编辑/删除作品）

### 日记与个人日程
- 书库首页右侧「日记」面板：按月日历 + 当日日记卡片 + 当日个人日程，三区联动
- 日历状态点：日期上方圆点 = 已写日记；下方圆点 = 日程状态（逾期红 / 今天绿 / 未来蓝 / 已完成灰），附图例
- 日记编辑器（TipTap 富文本）：标题、颜色、表格（合并/拆分单元格）、图片（可裁剪）、代码块、任务清单；实时字数统计 + 高频关键字自动提取
- 自动保存：300ms 防抖落盘，Esc / Ctrl+S 立即保存，关闭前兜底落盘；内容清空自动删除该日记录；删除需二次确认（误触自动复原）
- 「看日记」书页式浏览：右上角「看日记」入口，弹窗一次展开左右两页（左旧右新），只有写过日记的日子占页、自动跳过无日记日期，打开即定位最近日记，左右箭头 / ← → 方向键整组翻页，仅展示只读
- 个人日程管理：添加、勾选完成、双击编辑（回车保存 / Esc 取消）、删除，右上角显示完成进度
- 数据本地存储：`diaries` 表每天最多一篇（日期唯一），`schedules` 表某天可有多条日程

### 章节编辑
- TipTap 富文本编辑器（H1-H3、加粗/斜体/下划线/颜色、图片、表格、代码高亮 36 种语言、任务列表、Placeholder 占位提示）
- 图片插入与拖拽缩放，编辑器图片 1200px 等比压缩、封面图片 800px 压缩
- 图片查看器（放大/缩小/拖拽）与精确选区裁剪对话框
- 数学公式渲染（KaTeX）
- 卷-章节两级目录树，新建/重命名/折叠/状态标签、拖拽排序、内联标题编辑
- 编辑器状态恢复：滚动位置和光标位置自动保存，切换章节后恢复上次编辑位置
- 双保险自动保存（300ms 防抖 + 3 分钟定时），底部状态栏实时显示保存状态
- 中文字数统计（HTML 解析去标签）

### 专注写作
- 专注模式：隐藏侧栏/工具栏/状态栏，Esc 退出

### 世界观资料库
- 6 种卡片类型：人物/地点/时间线/势力/物品/其他
- 搜索、标签、过滤、FTS5 全文搜索
- 独立悬浮窗口模式（always_on_top，420×650）

### AI 助手
- 多服务商支持：智谱 BigModel / DeepSeek + 自定义 OpenAI 兼容端点
- 推理模型 Thinking 展示，对话/RAG 配置完全解耦，API Key 按服务商独立管理
- SSE 流式对话，自动重试与网络容错（2 次指数退避 + 60s 断流保底 + 保留已生成内容）
- RAG 语义检索：向量检索 + FTS5 双轨降级，Embedding 索引管理（连接独立测试 + stale 过期提示）
- AI 工具箱：29 个预设快捷提示词，5 大分类（续写/润色/扩写/剧情推演/角色分析/章末总结 等）
- 滑动窗口上下文管理（自动截断保护），对话总结压缩
- 章节总结缓存、Token 用量统计、连接状态指示器
- 请求详情面板：查看完整 AI 请求/响应内容
- 默认对话模型：`glm-5.1`，Embedding：`embedding-3`

### Agent 智能助手（Rust 原生引擎）
Agent 引擎已完全内置于 Rust 后端（无 Python / 外部进程依赖），基于 OpenAI function calling 协议实现流式 ReAct 工具循环，调用云端模型 + 数据库工具链完成多步写作任务：

- **4 个核心技能（Skill）**：
  - 写作辅助（WRITING）—— 大纲生成、情节建议、角色对话模拟、冲突设计
  - 文学分析（ANALYSIS）—— 文风分析、连贯性检查、伏笔追踪、角色弧光、节奏评估
  - 设定研究（RESEARCH）—— 资料检索、世界观一致性校验、设定扩展、关系图谱
  - 文字润色（POLISH）—— 语法纠错、文笔润色、风格统一、冗余精简
- **原生 ReAct 执行引擎**：SSE 流式接收模型输出，工具调用增量累积 → 执行 → 回填 → 多轮循环（上限 15 轮），事件契约与旧版一致（`agent-stream-chunk`）
- **动态 Prompt 注入**：按 Skill 组装 System Prompt + 用户消息关键词匹配最多 3 个场景提示 + 记忆注入 + 历史摘要
- **6 个数据库工具链**：读取章节/摘要/分页、列出章节、搜索世界观卡片、获取整书上下文 — 直接在 Rust 内访问 SQLite（repository 层），无中间跳转
- **记忆体系统**：三层记忆（偏好/决策/经验）、`memories` 表 SQLite 持久化、关键词相关性打分、Token 预算控制，附管理界面（查看/编辑/删除/清空）；启动时自动导入旧版 Python 记忆库（幂等）
- **模型路由**：按用户 AI 配置直连 DeepSeek / 智谱等 OpenAI 兼容端点（SSE 流式 + 60s 断流保底 + 总超时保护）
- **前端 RAF 缓冲优化**：requestAnimationFrame 合并高频 SSE chunk，避免过多重渲染

### 版本管理
- 章节 HTML 内容快照（auto/milestone 类型）
- 支持预览、恢复到历史版本、删除快照
- 版本历史独立窗口

### 导入导出
- 导出为 TXT / Markdown / HTML
- 导入 TXT，自动按正则识别章节分隔
- 数据备份：全量导出/单作品导出，AES-256-GCM 加密，支持完整恢复（密钥管理见 [安全设计](#-安全设计)）

### 个性化设置
- 浅色/深色/跟随系统主题切换
- 护眼模式：暖黄色 / 豆沙绿（亮色 + 暗色各一套）
- 全局字体切换（微软雅黑/黑体/宋体/楷体）
- 字体大小自定义（12-24px）
- 作品列表网格尺寸（小/中/大）
- 编辑器显示宽度（移动端/标准/宽屏）

### 独立窗口系统
- 5 种独立悬浮窗口：世界观资料库 / 版本历史 / 章节总结 / AI 工具箱 / 调试控制台
- Agent 侧边面板：内嵌 AI 侧栏，Skill 选择器 + 消息列表 + 流式输出，无需独立窗口即可交互
- 窗口状态通过 Jotai 原子跨页面共享，支持多窗口协作

### 调试与诊断
- 调试控制台：SQL 日志广播、Console 拦截、前端日志上报
- 数据库完整性自动校验
- 全局 ErrorBoundary：捕获渲染异常，展示友好提示
- AI 连接状态检测与诊断

### 插件系统
- 6 个扩展点（`editor-toolbar` / `editor-sidebar` / `library-card` / `export-format` / `ai-prompt` / `command-palette`），支持生命周期管理
- PluginManager 单例驱动，启用/禁用/卸载
- 内置字符统计示例插件

### com.ukcoder.timewrite 协议（深度链接）
- 注册 `com.ukcoder.timewrite://` 自定义 URL Scheme，支持从外部应用（浏览器/其他桌面应用）唤起 TimeWrite
- 支持参数传递（如 `com.ukcoder.timewrite://open?bookId=xxx`），实现快速跳转到指定作品/章节
- 基于 Tauri v2 deep-link 插件，自动处理 macOS 和 Windows 平台注册

### 其他
- 完整性自动检测脚本
- 更新器插件集成（GitHub Releases + GitHub API 双重回退）
- 代码分割优化（TipTap、Lucide、状态库等独立 chunk）
- GitHub CI/CD 自动构建与代码签名
- 产品宣传页（Landing Page） + GitHub Issue 模板

## 🔒 安全设计

- **备份加密**：备份文件使用 AES-256-GCM 加密，密钥不硬编码 —— 支持环境变量 `TIMEWRITE_BACKUP_KEY`（SHA-256 派生），或使用首次启动自动生成的本机密钥文件（`<app_data_dir>/backup.key`，Unix 权限 0600）
- **更新签名**：GitHub Releases 更新包经 minisign 签名校验，公钥内置于应用，防止更新包被篡改
- **CSP 收紧**：严格内容安全策略 —— `img-src` 仅允许本地资源（`asset:`/`data:`），`connect-src` 仅放行 IPC 与必要的 `api.github.com`，阻断注入攻击面
- **文件系统权限作用域**：Tauri fs 权限限定在应用数据目录与资源目录（`$APPDATA/**`、`$RESOURCE/**`），用户选择的路径经系统对话框动态授权
- **IPC 最小暴露**：`withGlobalTauri` 关闭，前端仅通过显式导入的 `@tauri-apps/api` 调用 IPC，不暴露全局 `window.__TAURI__`
- **Agent 只读保证**：Agent 工具仅通过 Rust repository 层只读访问数据库，所有写操作唯一入口在 Rust 侧

## 📖 文档

完整项目文档请访问 [TimeWrite Wiki](https://github.com/WangYajun369/ai-writing-platform/wiki)，包括快速开始、构建发布、项目结构、数据库设计、Roadmap 等。

## 更新日志

详细版本更新记录请参见 [docs/CHANGELOG.md](./docs/CHANGELOG.md)。

## 联系与赞助

如果这个项目对你有帮助，欢迎赞助支持 ❤️

<div align="center">
  <img src="product/wx-pay.jpg" width="200" alt="微信赞助">&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="product/wx-wyj.jpg" width="200" alt="微信联系">
</div>

## 应用信息

| 项目 | 值 |
|------|------|
| 应用名称 | TimeWrite |
| 应用标识 | `com.ukcoder.timewrite` |
| 版本 | 1.4.0 |
| 窗口默认尺寸 | 1280 × 800 |
| 窗口最小尺寸 | 800 × 600 |
| 深度链接协议 | `com.ukcoder.timewrite://` |

## 许可证

本项目采用 [MIT License](./LICENSE)，版权所有 © 2026 WangYaJun。
