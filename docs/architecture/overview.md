# 架构总览

## 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                    前端 (React/TypeScript)                │
├─────────────────────────────────────────────────────────┤
│  pages/          components/        stores/              │
│  书库/编辑器/设置  各功能组件          Zustand + Jotai     │
│       │               │                  │               │
│       └───────────────┼──────────────────┘               │
│                       │                                  │
│              lib/tauri-bridge.ts                         │
│              (8 个 API 模块，类型安全封装)                  │
│                       │                                  │
├───────────────────────┼──────────────────────────────────┤
│                  Tauri IPC 边界                           │
├───────────────────────┼──────────────────────────────────┤
│                       │                                  │
│              src-tauri/src/commands/                     │
│  book.rs | volume.rs | chapter.rs | snapshot.rs          │
│  world_card.rs | ai/ | io/ | window/ | image.rs         │
│  agent/ (Agent 管理：技能执行/状态同步)                   │
│                       │                                  │
│              db/mod.rs (r2d2 连接池)                      │
│                       │                                  │
│              SQLite (WAL 模式)                            │
│  books | volumes | chapters | snapshots |                │
│  world_cards | embeddings                                │
└─────────────────────────────────────────────────────────┘
```

## 核心设计原则

### 1. 关注点分离
- **前端**：UI 渲染、用户交互、状态管理
- **后端**：数据持久化、业务逻辑、AI 集成
- **桥接层**：类型安全的 IPC 封装

### 2. 数据流方向
```
用户操作 → React 组件 → Zustand Action → tauri-bridge.invoke()
    → Rust 命令 → SQLite 读写 → 返回结果 → 更新状态 → 重新渲染
```

### 3. 实时事件流
```
Rust 命令 → app.emit('ai-stream-chunk') → 前端 listen() → 更新 UI
```

## 数据库设计

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `books` | 书籍元信息 | title, author, cover_image, word_count, daily_target |
| `volumes` | 卷信息 | book_id (FK), title, sort_order |
| `chapters` | 章节内容 | book_id (FK), content_html, word_count, deleted_at |
| `snapshots` | 版本快照 | chapter_id (FK), content_html, type |
| `world_cards` | 世界观卡片 | book_id (FK), type, title, content_html, vectorized |
| `embeddings` | 向量索引 | source_type, source_id, embedding (BLOB), model |

- 7 个索引优化查询性能
- WAL 模式支持并发读写
- 外键级联删除保障数据完整性
- 章节软删除（`deleted_at`）

## IPC 模块映射

| API 模块 | Rust 命令 | 功能 |
|---------|----------|------|
| `bookApi` | `commands/book.rs` | 书籍 CRUD + 封面管理 |
| `volumeApi` | `commands/volume.rs` | 卷管理 |
| `chapterApi` | `commands/chapter.rs` | 章节 CRUD + 自动保存 |
| `snapshotApi` | `commands/snapshot.rs` | 版本快照 |
| `worldCardApi` | `commands/world_card.rs` | 世界观卡片 |
| `aiApi` | `commands/ai/` | AI 对话（智谱/DeepSeek/自定义）+ RAG 检索 + Embedding 索引 + 章节/对话总结 |
| `importExportApi` | `commands/io/` | 导入导出 + 加密备份 |
| `windowApi` | `commands/window/` | 独立窗口管理（世界观/历史/总结/AI 工具箱/调试控制台） |
| `debugApi` | `commands/window/debug.rs` | 调试控制台 + 日志管理 + 数据库校验 |
| `imageApi` | `commands/image.rs` | 图片处理与裁剪 |
| `agentApi` | `commands/agent/` | Agent 服务管理（启停/技能/状态） |

## Tauri 插件

| 插件 | 用途 |
|------|------|
| `tauri-plugin-http` | AI API 请求 |
| `tauri-plugin-dialog` | 文件选择对话框 |
| `tauri-plugin-fs` | 文件读写 |
| `tauri-plugin-shell` | Shell 命令 |
| `tauri-plugin-updater` | 版本更新 |
| `tauri-plugin-deep-link` | URL Scheme 唤起 |

## 主题系统

基于 HSL CSS 变量实现多套主题组合：
- 3 种基础主题：亮色 / 暗色 / 跟随系统
- 2 种护眼模式：暖黄色 / 豆沙绿
- 亮色和暗色可与护眼模式自由组合，共 6 种视觉组合
