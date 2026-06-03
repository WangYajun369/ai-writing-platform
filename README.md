# MirageInk

跨平台小说写作软件 —— Tauri v2 + React 18 + TipTap

## 技术栈

- **前端**：React 18 + TypeScript + Vite 8 + TailwindCSS + TipTap
- **状态**：Zustand（全局）+ Jotai（UI 原子）
- **后端**：Tauri v2 + Rust + SQLite（rusqlite）
- **包管理**：pnpm ≥ 9

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发模式（首次会编译 Rust，需要数分钟）
pnpm tauri dev

# 仅启动前端 Vite 预览
pnpm dev

# 运行完整性检测（67 项）
pnpm check
```

## 构建发布

```bash
pnpm tauri build
```

## 项目结构

```
MirageInk/
├── src/                     # React 前端
│   ├── components/          # UI 组件
│   ├── pages/               # 页面：Library / Editor / Settings
│   ├── stores/              # Zustand + Jotai 状态
│   ├── lib/                 # 工具函数 + Tauri IPC 封装
│   ├── types/               # TypeScript 类型
│   └── router/              # React Router v7
├── src-tauri/               # Rust 后端
│   └── src/
│       ├── commands/        # IPC 命令（book/chapter/world_card/ai/io）
│       ├── db/              # SQLite 初始化 + 表结构
│       └── models/          # serde 数据模型
└── scripts/check.mjs        # 完整性检测脚本（67 项）
```

## Roadmap

| Phase | 状态 | 内容 |
|-------|------|------|
| Phase 1 | ✅ 完成 | 工程骨架、书库、TipTap 编辑、SQLite CRUD |
| Phase 2 | 🔜 | 自动保存、专注模式、导入导出、图片/表格 |
| Phase 3 | 🔜 | myers-diff 版本对比 |
| Phase 4 | 🔜 | sqlite-vec + Ollama RAG |
| Phase 5 | 🔜 | 跨平台打包发布 |
