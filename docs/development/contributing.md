# 贡献指南

感谢你对 TimeWrite（智写时光）项目的关注！

## 开发环境

### 前置要求

| 工具 | 版本 |
|------|------|
| Node.js | ≥ 22 |
| pnpm | ≥ 11 |
| Python | ≥ 3.10（Agent 服务） |
| Rust | 最新稳定版 |
| macOS / Windows / Linux | - |

### 克隆并启动

```bash
git clone git@github.com:WangYajun369/ai-writing-platform.git
cd ai-writing-platform
pnpm install
pnpm tauri dev
```

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
- **IPC 命令**：在 `src-tauri/src/commands/` 按功能模块组织
- **数据库**：通过 `r2d2` 连接池访问，WAL 模式
- **事件推送**：使用 `app.emit()` 向前端推送实时事件

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
