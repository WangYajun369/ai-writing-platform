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
| **状态管理** | Zustand（业务数据 + 插件状态）+ Jotai（UI 原子状态，21 个 atom） |
| **路由** | React Router v7（懒加载 Editor/Settings 页面） |
| **后端** | Rust 2021 + SQLite（WAL 模式）+ rusqlite（bundled）+ r2d2 连接池 |
| **AI 通信** | SSE 流式对话，reqwest stream + tokio 异步 |
| **包管理** | pnpm >= 9，Node >= 20 |
| **深度链接** | com.ukcoder.timewrite 协议（`com.ukcoder.timewrite://`），支持外部应用唤起与参数传递 |

## 功能特性

### 书库管理
- 多作品管理，网格/列表双视图切换，虚拟化滚动
- 搜索、排序（时间/字数/书名）
- 创建/编辑/删除书籍，书籍封面设置（JPG/PNG/WebP）
- 每日写作目标 + 进度环可视化
- 回收站管理：软删除作品/卷/章节，支持恢复与永久删除
- 右键上下文菜单（编辑/删除作品）

### 章节编辑
- TipTap 富文本编辑器（H1-H3、加粗/斜体/下划线/颜色、图片、表格、代码高亮 34 种语言、任务列表、Placeholder 占位提示）
- 图片插入与拖拽缩放，编辑器图片 1200px 等比压缩、封面图片 800px 压缩
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
- 双服务商支持：智谱 BigModel + 自定义 OpenAI 兼容端点（含 DeepSeek 预设）
- 推理模型 Thinking 展示，对话/RAG 配置完全解耦，API Key 按服务商独立管理
- SSE 流式对话，自动重试与网络容错
- RAG 语义检索：向量检索 + FTS5 双轨降级，Embedding 索引管理
- AI 工具箱：30+ 快捷提示词（续写/润色/扩写/剧情推演/角色分析/章末总结 等）
- 滑动窗口上下文管理（自动截断保护），对话总结压缩
- 章节总结缓存、Token 用量统计、连接状态指示器
- 请求详情面板：查看完整 AI 请求/响应内容
- 默认对话模型：`glm-5.1`，Embedding：`embedding-3`

### 版本管理
- 章节 HTML 内容快照（auto/milestone 类型）
- 支持预览、恢复到历史版本、删除快照
- 版本历史独立窗口

### 导入导出
- 导出为 TXT / Markdown / HTML
- 导入 TXT，自动按正则识别章节分隔
- 数据备份：全量导出/单作品导出，AES-256-GCM 加密，支持完整恢复

### 个性化设置
- 浅色/深色/跟随系统主题切换
- 护眼模式：暖黄色 / 豆沙绿（亮色 + 暗色各一套）
- 全局字体切换（微软雅黑/黑体/宋体/楷体）
- 字体大小自定义（12-24px）
- 作品列表网格尺寸（小/中/大）
- 编辑器显示宽度（移动端/标准/宽屏）

### 独立窗口系统
- 5 种独立悬浮窗口：世界观资料库 / 版本历史 / 章节总结 / AI 工具箱 / 调试控制台
- 窗口状态通过 Jotai 原子跨页面共享，支持多窗口协作

### 调试与诊断
- 调试控制台：SQL 日志广播、Console 拦截、前端日志上报
- 数据库完整性自动校验
- 全局 ErrorBoundary：捕获渲染异常，展示友好提示
- AI 连接状态检测与诊断

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
- GitHub CI/CD 自动构建与代码签名
- 产品宣传页（Landing Page） + GitHub Issue 模板

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
| 版本 | 0.9.0 |
| 窗口默认尺寸 | 1280 × 800 |
| 窗口最小尺寸 | 800 × 600 |
| 深度链接协议 | `com.ukcoder.timewrite://` |

## 许可证

本项目采用 [MIT License](./LICENSE)，版权所有 © 2026 WangYaJun。
