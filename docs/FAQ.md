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
章节使用软删除机制（`deleted_at` 字段），但前端目前不提供回收站功能。建议在删除前通过版本快照备份。

## 开发相关

### Q: 开发环境需要什么？
- Node.js ≥ 20
- pnpm ≥ 9
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
主题通过 `src/styles/globals.css` 中的 CSS 变量控制。可修改 HSL 值自定义颜色方案。
