# 项目结构

## 目录总览

```
TimeWrite/
├── index.html                  # SPA 入口 HTML
├── package.json                # 项目配置
├── pnpm-lock.yaml              # pnpm 锁文件
├── tsconfig.json               # TypeScript 编译配置
├── vite.config.ts              # Vite 构建配置（端口 1420/1421）
├── tailwind.config.ts          # TailwindCSS 配置
├── postcss.config.js           # PostCSS 配置
│
├── scripts/                    # 脚本工具
│   └── check.mjs               #   完整性检测脚本
│
├── src/                        # React 前端源码
│   ├── main.tsx                #   应用入口
│   ├── App.tsx                 #   根组件（主题/字体/世界观测）
│   ├── router/
│   │   └── index.tsx           #   路由定义（懒加载）
│   ├── pages/                  #   页面组件
│   │   ├── LibraryPage.tsx     #     书库首页
│   │   ├── EditorPage.tsx      #     编辑器主页面
│   │   └── SettingsPage.tsx    #     设置页面
│   ├── components/             #   功能组件
│   │   ├── library/            #     书库：BookCard / NewBookDialog / CoverPicker
│   │   ├── editor/             #     编辑器：RichTextEditor / EditorToolbar / SnapshotPanel
│   │   ├── outline/            #     目录树：OutlinePanel
│   │   ├── worldbuilding/      #     世界观：WorldbuildingPanel / WorldCardEditor
│   │   ├── ai/                 #     AI 助手：AiSidePanel
│   │   ├── layout/             #     布局：EditorLayout / StatusBar
│   │   ├── diff/               #     版本对比视图（react-diff-viewer）
│   │   └── ui/                 #     通用 UI 组件
│   ├── stores/                 #   状态管理
│   │   ├── appStore.ts         #     Zustand 业务状态
│   │   ├── pluginStore.ts      #     Zustand 插件状态
│   │   └── uiAtoms.ts          #     Jotai UI 原子（13 个）
│   ├── plugins/                #   插件系统
│   │   ├── types.ts            #     类型定义
│   │   ├── PluginManager.ts    #     插件管理器
│   │   └── examples/           #     示例插件
│   ├── lib/                    #   工具库
│   │   ├── tauri-bridge.ts     #     Tauri IPC 桥接层
│   │   └── utils.ts            #     工具函数
│   ├── types/                  #   类型定义
│   │   └── index.ts            #     15 个核心类型
│   └── styles/                 #   样式
│       └── globals.css         #     全局样式（四套主题）
│
└── src-tauri/                  # Rust 后端
    ├── Cargo.toml              #   Rust 项目配置
    ├── tauri.conf.json         #   Tauri 应用配置
    ├── src/
    │   ├── main.rs             #     入口
    │   ├── lib.rs              #     主逻辑（插件初始化/数据库/IPC 注册）
    │   ├── db/mod.rs           #     数据库层（6 张表/7 个索引）
    │   ├── models/mod.rs       #     Serde 数据模型
    │   └── commands/           #     IPC 命令（8 个模块）
    │       ├── book.rs         #       书籍管理
    │       ├── volume.rs       #       卷管理
    │       ├── chapter.rs      #       章节管理
    │       ├── snapshot.rs     #       版本快照
    │       ├── world_card.rs   #       世界观卡片
    │       ├── ai.rs           #       AI 检索
    │       ├── io.rs           #       导入导出
    │       └── window.rs       #       多窗口管理
    ├── icons/                  #   应用图标
    └── capabilities/           #   权限配置
```

## 核心架构

```
前端 (React/TypeScript)
    │ invoke() IPC 调用
    ▼
tauri-bridge.ts (类型安全封装，8 个 API 模块)
    │
Tauri IPC 边界
    │
Rust 命令处理器 (commands/)
    │ r2d2 连接池
    ▼
SQLite (WAL 模式，6 张表 + 7 个索引)
```
