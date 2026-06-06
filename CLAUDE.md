# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MirageInk（幻境水墨）是一个跨平台桌面端小说写作软件，采用 Tauri v2 + React + Rust + SQLite 架构，面向网络小说作者和文学创作者，提供完整的写作工作流。

### Key Features
- 书库管理：多作品网格/列表视图、搜索排序、创建/删除
- TipTap 富文本编辑器：标题、加粗、斜体、下划线、颜色、图片、表格、字数统计
- 卷-章节两级目录树：新建/重命名/折叠/排序
- 自动保存：300ms 防抖 + 3 分钟定时双保险
- 专注模式与打字机模式
- 世界观资料库：6 种卡片类型、搜索/标签/过滤
- AI 助手：Ollama 流式对话 + RAG 上下文检索 + 4 个快捷提示词
- 版本快照：auto/milestone 类型，支持内容恢复
- 导入导出：导出 TXT/MD/HTML，导入 TXT 自动正则分章
- 浅色/深色/跟随系统主题切换
- 写作目标：每日字数目标 + 进度环可视化

## Architecture

### Technology Stack
- **Desktop Framework**: Tauri v2
- **Frontend**: React 18 + TypeScript 5 + Vite 8
- **Styles**: TailwindCSS 3 + CSS 变量色彩体系
- **Rich Text Editor**: TipTap
- **State Management**: Zustand（业务数据）+ Jotai（UI 原子状态）
- **Router**: React Router v7
- **Backend Language**: Rust 2021 Edition
- **Database**: SQLite（WAL 模式）+ rusqlite

### Core Architecture
1. **Tauri v2 IPC**: Frontend `invoke()` → `tauri-bridge.ts` → Rust 命令处理 → SQLite 读写
2. **Double Auto-Save**: 300ms debounce + 3-minute timer
3. **Soft Delete**: Chapters use `deleted_at` field instead of physical deletion
4. **RAG Placeholder**: AI module has semantic search interface, currently using LIKE fallback, Phase 4 will integrate sqlite-vec

## Project Structure

```
MirageInk/
├── src/                         # React 前端
│   ├── main.tsx                 # 应用入口
│   ├── App.tsx                  # 根组件（Jotai Provider + 主题切换）
│   ├── router/                  # 路由定义
│   ├── pages/                   # 页面组件
│   ├── components/              # 功能组件
│   ├── stores/                  # 状态管理
│   ├── lib/                     # 工具库
│   ├── types/                   # 类型定义
│   ├── styles/                  # 样式
│   └── hooks/                   # 预留自定义 Hooks
├── src-tauri/                   # Rust 后端
│   ├── src/                     # Rust 源码
│   │   ├── lib.rs               # 应用主逻辑
│   │   ├── db/                  # 数据库层
│   │   ├── models/              # Serde 数据模型
│   │   └── commands/            # IPC 命令模块
│   └── gen/schemas/             # Tauri 自动生成的 JSON Schema
└── scripts/                     # 脚本工具
```

## Database Design

### 5 Tables
1. **books**: 书籍元信息（标题、作者、描述、字数、标签等）
2. **volumes**: 卷信息（书名、排序）
3. **chapters**: 章节内容（HTML、字数、状态、软删除）
4. **snapshots**: 版本快照（auto/milestone 类型）
5. **world_cards**: 世界观卡片（6 种类型、标签、向量化标记）

## Development Commands

```bash
# 开发模式（首次启动需要编译 Rust，约几分钟）
pnpm tauri dev

# 仅启动前端 Vite 预览
pnpm dev

# 生产构建
pnpm tauri build

# 预览生产构建
pnpm tauri preview

# 运行 67 项完整性检测
pnpm check
```

## Common Development Patterns

### State Management
- **Zustand**: 全局业务数据状态管理
- **Jotai**: UI 原子状态管理

### IPC Communication
- 通过 `tauri-bridge.ts` 封装 31 个 Tauri IPC 命令
- 命令模块按功能分组：bookApi、volumeApi、chapterApi 等

### Auto-Save Mechanism
- 300ms 防抖 + 3 分钟定时器双保险
- 使用防抖函数处理编辑器内容变化

### Theme System
- 支持浅色/深色/跟随系统主题切换
- 使用 CSS 变量实现主题切换

## Key Components

### Frontend Components
- **RichTextEditor**: TipTap 富文本编辑器（11 个扩展）
- **EditorLayout**: 编辑器三栏布局容器
- **StatusBar**: 底部状态栏（章节名/字数/保存状态）
- **AI SidePanel**: AI 侧面板（Ollama 流式对话）

### Backend Commands
- 书籍管理（CRUD + 列表）
- 卷管理（CRUD + 排序）
- 章节管理（CRUD/保存/重命名/软删除/排序）
- 版本快照管理
- 世界观卡片管理
- 导入导出

## Testing Strategy

### Unit Testing
- 使用 Jest + React Testing Library 测试 React 组件
- Tauri 命令使用 Mocking 进行单元测试

### Integration Testing
- 使用 Playwright 进行端到端测试
- 模拟 Tauri 环境测试跨进程通信

## Deployment

### Cross-Platform Packaging
- 使用 Tauri 的 `tauri build` 命令生成 macOS、Windows、Linux 安装包
- 支持 App Store 提交

## Roadmap

### Phase 1 (已完成)
- 工程骨架搭建
- 书库管理
- TipTap 编辑器
- SQLite CRUD

### Phase 2 (已完成)
- 自动保存
- 专注/打字机模式
- 导入导出
- 世界观资料库
- AI 助手
- 版本快照

### Phase 3 (规划中)
- 版本对比视图

### Phase 4 (规划中)
- sqlite-vec 向量语义检索 + Ollama RAG

### Phase 5 (规划中)
- 跨平台打包发布

## Important Notes

1. **Database Operations**: 所有数据库操作通过 Rust 后端进行，前端通过 IPC 调用
2. **AI Integration**: 当前使用 Ollama 本地模型，支持流式对话
3. **Theme System**: 使用 CSS 变量实现主题切换，避免直接修改颜色值
4. **Soft Delete**: 使用 `deleted_at` 字段而非物理删除
5. **Auto-Save**: 双保险机制确保数据安全

## License

MIT