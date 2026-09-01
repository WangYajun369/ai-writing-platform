# 常见问题

## 使用相关

### Q: TimeWrite 支持哪些平台？
目前支持 **macOS（Apple Silicon）**和 **Windows**。Linux 版本在计划中。

### Q: 数据存储在哪里？
数据存储在应用本地数据目录的 SQLite 数据库中。macOS 通常在 `~/Library/Application Support/com.ukcoder.timewrite/`。

### Q: 如何备份数据？
可通过导出功能将作品导出为 TXT/Markdown/HTML 格式进行备份。建议定期导出重要作品。

### Q: 专注模式下如何恢复面板？
按 `Esc` 键退出专注模式，所有面板恢复之前状态。

### Q: AI 助手支持哪些模型？
默认集成智谱 BigModel（`glm-5.1`）和 DeepSeek（支持推理思考模式），同时支持任何 OpenAI 兼容 API 以及本地 Ollama 部署。

### Q: 为什么 AI 回复被截断？
检查设置中的「最大输出 Token」参数，确保设置足够大的值（默认 131072）。

### Q: 如何设置写作目标？
在书库页面，作品卡片上点击目标设置区域，输入每日目标字数。进度以环形图显示。

### Q: 章节删除后能恢复吗？
章节使用软删除机制（`deleted_at` 字段），可通过回收站（TrashModal）查看、恢复或彻底删除已删除的章节、卷和作品。

## Agent 自动化相关

### Q: Agent 面板显示"未启动"怎么办？

Agent 由 Rust 侧 `python/manager.rs` 自动拉起。点击面板右上角「启动」按钮即可；若反复失败，常见原因：

1. **未初始化 Python 环境** —— 执行 `pnpm agent:setup` 创建 `agent/.venv` 并安装依赖
2. **uvicorn 不可用** —— AgentManager 会验证解释器可用性，缺失时会自动降级查找，详见 [Agent 架构](architecture/agent-architecture)
3. **端口 9877 被占用** —— AgentManager 启动时会自动 kill 僵尸进程；仍失败可手动 `lsof -i :9877`

### Q: Agent 需要联网吗？

取决于技能与模型路由：

- **润色优化（polish）** —— 走本地 Ollama（`qwen2.5:7b`），无需联网，但需要本地已拉取该模型
- **写作 / 分析 / 研究** —— 走云端 DeepSeek，需要有效的 API Key（在设置 → AI 配置中填写）

若本地 Ollama 不可用，历史压缩功能会自动降级跳过。

### Q: Agent 会修改我的章节内容吗？

**不会。** Python Agent 不直接访问 SQLite，只能通过 Rust Bridge（端口 9876）**读取**数据。所有写操作（保存、恢复快照等）的唯一入口仍在 Rust 侧。Agent 的输出以文本形式展示，是否采纳由你决定。

### Q: Agent 记忆保存在哪里？可以删除吗？

保存在 `agent/data/agent_memory.db`（SQLite，WAL 模式），按作品隔离。可在 Agent 面板点击「记忆」按钮查看、编辑、删除单条记忆，或清空当前作品的全部记忆。

### Q: Agent 和 AI 助手有什么区别？

AI 助手是单轮/多轮对话工具，通过 RAG 检索片段作为上下文；Agent 会自主规划、多步调用 6 个数据库工具完成复杂任务，并拥有跨会话的三层记忆体。详见 [Agent 自动化](user-guide/agent-panel)。

## 开发相关

### Q: 开发环境需要什么？
- Node.js ≥ 22
- pnpm ≥ 11
- Python ≥ 3.10（Agent 服务）
- Rust 最新稳定版
- macOS / Windows / Linux

### Q: 如何调试 Rust 后端？
使用 `pnpm tauri dev` 启动开发模式，Rust 代码的 `println!` 输出会出现在终端中。

### Q: 如何添加新的 IPC 命令？
1. 在 `src-tauri/src/commands/` 添加命令函数
2. 在 `mod.rs` 中声明模块
3. 在 `lib.rs` 中注册命令
4. 在 `src/lib/tauri-bridge.ts` 中添加前端封装

### Q: 如何添加新的 Tauri 插件？
1. 在 `Cargo.toml` 添加插件依赖
2. 在 `lib.rs` 中注册插件
3. 在 `capabilities/default.json` 中配置权限

### Q: 为什么构建失败？
运行 `pnpm check` 完整性检测脚本，确认所有文件结构完整。

### Q: 如何自定义主题？
主题通过 `src/styles/theme.css` 中的 CSS 变量控制。可修改 HSL 值自定义颜色方案。
