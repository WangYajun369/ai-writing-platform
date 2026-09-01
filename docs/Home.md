# TimeWrite（智写时光）Wiki

> 跨平台桌面端小说写作软件 —— Tauri v2 + React 19 + TipTap + Python Agent

> **适用版本**：`1.0.0`　|　**最后核对**：2026-08-31

欢迎来到 TimeWrite 的官方文档！TimeWrite 是一款面向网络小说作者和文学创作者的桌面写作工具，提供从书库管理、章节编辑到 AI 辅助创作的完整写作工作流。

> 🚀 [**查看项目介绍**](https://wangyajun369.github.io/ai-writing-platform/)

---

## 快速导航

| 板块 | 说明 |
|------|------|
| [📖 用户指南](user-guide/quick-start) | 快速上手、各项功能使用说明 |
| [🤖 Agent 自动化](user-guide/agent-panel) | 4 大写作技能、记忆系统、模型路由 |
| [✨ 功能特性](features/feature-list) | 完整功能清单与介绍 |
| [🔧 开发文档](development/project-structure) | 项目结构、技术栈、状态管理、插件系统 |
| [🏗️ 架构说明](architecture/overview) | 三进程架构、AI 模块、Agent 子系统 |
| [❓ 常见问题](FAQ) | 使用和开发常见问题解答 |
| [📋 更新日志](CHANGELOG) | 版本发布历史 |
| [🗺️ 文档地图](DOC-INDEX) | 全部文档索引与维护规范 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 |
| 前端 | React 19 + TypeScript 6 + Vite 8 |
| 样式 | TailwindCSS 4 + HSL CSS 变量（3 基础主题 × 2 护眼模式） |
| 富文本 | TipTap |
| 状态管理 | Zustand（业务 slice）+ Jotai（21 个 UI atom） |
| 后端 | Rust 2021 + SQLite（WAL 模式 + FTS5 全文索引） |
| AI 通信 | Rust `reqwest` SSE 流式对话（智谱 / DeepSeek / OpenAI 兼容 / Ollama） |
| Agent 服务 | Python + FastAPI + LangGraph ReAct（端口 **9877**） |
| 数据桥接 | Rust Bridge HTTP Server（端口 **9876**），Agent 反向回调读库 |

### 三进程架构

TimeWrite 运行时包含 3 个独立进程，Rust 是**唯一的数据拥有者**：

```
WebView 前端  ──Tauri IPC──►  Rust Core  ──HTTP SSE──►  Python Agent
 (React 19)                  (SQLite 独占)              (LangGraph)
                                   ▲                          │
                                   └──── HTTP 9876 Bridge ◄───┘
```

- **前端**：只通过 IPC 访问数据，不直连数据库
- **Rust Core**：业务编排 + 数据持久化 + 子进程管理
- **Python Agent**：AI 执行体，不直接触碰 SQLite，通过 9876 Bridge 反向回调读数据

---

## 应用信息

| 项目 | 值 |
|------|-----|
| 应用名称 | TimeWrite（智写时光） |
| 应用标识 | `com.ukcoder.timewrite` |
| 当前版本 | 1.0.0 |
| 许可证 | MIT |
| 仓库地址 | [github.com/WangYajun369/ai-writing-platform](https://github.com/WangYajun369/ai-writing-platform) |

---

## ❤️ 赞助支持

如果 TimeWrite 对你的创作有帮助，欢迎赞助支持，让智写时光越做越好！

![微信赞助](https://wangyajun369.github.io/ai-writing-platform/wx-pay.jpg)

---

## 💬 扫码添加微信

有任何问题或建议，欢迎添加微信沟通，期待与每一位创作者交流 👋

![微信联系](https://wangyajun369.github.io/ai-writing-platform/wx-wyj.jpg)
