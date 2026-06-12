# 技术栈

## 总览

| 层级 | 技术 | 版本 |
|------|------|------|
| **桌面框架** | Tauri | v2 |
| **前端框架** | React | 19 |
| **语言** | TypeScript | 6 |
| **构建工具** | Vite | 8 |
| **样式方案** | TailwindCSS | 4 |
| **富文本编辑器** | TipTap | 3.26 |
| **状态管理** | Zustand + Jotai | 5 / 2.20 |
| **路由** | React Router | v7 |
| **后端语言** | Rust | 2021 Edition |
| **数据库** | SQLite (rusqlite bundled) | WAL 模式 |
| **连接池** | r2d2 | - |
| **包管理** | pnpm | ≥ 11 |

## 前端依赖

### 核心框架
| 依赖 | 说明 |
|------|------|
| `react` / `react-dom` | UI 框架 |
| `react-router-dom` | SPA 路由 |
| `@tauri-apps/api` | Tauri 前端 API |

### 状态管理
| 依赖 | 说明 |
|------|------|
| `zustand` | 全局业务/插件状态 |
| `jotai` | UI 原子状态 |

### 富文本
| 依赖 | 说明 |
|------|------|
| `@tiptap/react` | 编辑器核心 |
| `@tiptap/starter-kit` | 基础扩展包 |
| `@tiptap/extension-*` | 表格/图片/颜色/下划线/任务列表/字符计数等扩展 |
| `@tiptap/extension-code-block-lowlight` | 代码块语法高亮 |
| `lowlight` | 代码语法高亮引擎（34 种语言） |
| `katex` | LaTeX 数学公式渲染 |

### UI 工具
| 依赖 | 说明 |
|------|------|
| `tailwind-merge` + `clsx` | 类名合并 |
| `class-variance-authority` | 组件变体 |
| `lucide-react` | 图标库 |
| `react-markdown` + `remark-gfm` | Markdown 渲染 |
| `react-diff-viewer-continued` | 版本对比视图（diff） |
| `@tanstack/react-virtual` | 虚拟化滚动 |
| `@dnd-kit/core` + `@dnd-kit/utilities` | 拖拽排序 |

### 工具函数
| 依赖 | 说明 |
|------|------|
| `date-fns` | 日期处理 |
| `react-markdown` + `remark-gfm` | Markdown 渲染 |
| `katex` | LaTeX 公式渲染 |

## Tauri 插件

| 插件 | 用途 |
|------|------|
| `tauri-plugin-http` | HTTP 请求（AI API 调用） |
| `tauri-plugin-dialog` | 原生文件对话框 |
| `tauri-plugin-fs` | 文件系统访问 |
| `tauri-plugin-shell` | Shell 命令执行 |
| `tauri-plugin-updater` | 应用更新 |
| `tauri-plugin-deep-link` | 深度链接（`com.ukcoder.timewrite://`） |

## Rust 依赖

| Crate | 用途 |
|-------|------|
| `tauri` | 应用框架 |
| `rusqlite` (bundled) | SQLite 数据库 |
| `r2d2` + `r2d2_sqlite` | 连接池 |
| `serde` / `serde_json` | 序列化 |
| `reqwest` | HTTP 客户端 |
| `futures-util` | 异步流处理 |
| `uuid` | UUID 生成 |
| `chrono` | 时间处理 |
