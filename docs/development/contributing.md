# 贡献指南

感谢你对 TimeWrite（智写时光）项目的关注！

## 开发环境

### 前置要求

| 工具 | 版本 |
|------|------|
| Node.js | ≥ 22 |
| pnpm | ≥ 11 |
| Rust | 最新稳定版 |
| macOS / Windows / Linux | - |

### 克隆并启动

```bash
git clone git@github.com:WangYajun369/ai-writing-platform.git
cd ai-writing-platform
pnpm install
pnpm tauri dev
```

> **运行环境说明**：v1.1 起 Agent 引擎为 Rust 原生实现，**无需 Python 环境**。
> 仅 AI 对话需要可用的云端 API Key（设置页配置）或本地 Ollama 服务。

## 项目规范

### 代码风格
- **TypeScript**：严格模式，路径别名 `@/` 映射到 `src/`
- **Rust**：2021 Edition，标准格式化（`cargo fmt`）
- **样式**：TailwindCSS + `cn()` 工具函数合并类名

### 命名约定
- 组件文件：PascalCase（`AiSidePanel.tsx`）
- 工具函数：camelCase（`formatWordCount`）
- 类型接口：PascalCase（`AiConfig`）
- Rust 结构体：PascalCase + `#[serde(rename_all = "camelCase")]`

### 提交规范

```
<type>: <description>

类型：
- feat: 新功能
- fix: 修复
- refactor: 重构
- docs: 文档
- style: 样式
- chore: 构建/工具
```

## 架构约定

### 前端
- **状态管理**：业务数据用 Zustand，UI 状态用 Jotai
- **IPC 通信**：统一通过 `src/lib/tauri-bridge.ts` 封装
- **路由**：懒加载页面组件

### 后端
- **分层**：`commands/` → `service/`（事务边界）→ `repository/`（纯 SQL）→ `db/`
- **IPC 命令**：在 `src-tauri/src/commands/` 按功能模块组织，并在 `lib.rs` 的 `invoke_handler` 中注册
- **数据库**：通过 `r2d2` 连接池访问，WAL 模式；禁止跨层直接写 SQL
- **事件推送**：使用 `app.emit()` 向前端推送实时事件

### Agent 引擎（Rust 原生）
- **技能**：新增 Skill 需同时修改 `src-tauri/src/commands/agent/prompts.rs`（`skill_base_prompt` 与 `dynamic_hints`）、`tools.rs`（`tools_for_skill` 工具映射）、`skills.rs`（IPC 层）
- **数据访问**：工具调用经 repository 层直查 SQLite，禁止在引擎层写裸 SQL
- **记忆**：记忆沉淀遵循 `memory.rs` 的规则式提取（零 LLM 成本），不阻塞主流程

## 测试

```bash
# 运行完整性检测
pnpm check
```

## 构建发布

```bash
pnpm tauri build
```

## 分支策略

- `main`：稳定分支
- `feat/*`：功能开发分支
- `fix/*`：修复分支

## 许可证

本项目采用 [MIT License](https://github.com/WangYajun369/ai-writing-platform/blob/main/LICENSE)。
