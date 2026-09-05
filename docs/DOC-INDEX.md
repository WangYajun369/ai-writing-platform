# 文档地图

> **最后更新**：2026-09-05　|　**当前版本**：`1.7.0`

本页是 TimeWrite 文档的**索引与维护规范**。如果你想找某篇文档、或想知道该如何新增/更新文档，从这一页开始。

---

## 一、按角色阅读

### 👤 我是用户（只想用这个软件）

| 我想…… | 去看 |
|--------|------|
| 快速上手 | [快速开始](user-guide/quick-start) |
| 管理作品与封面 | [书库管理](user-guide/library-management) |
| 记日记、看当日任务 | [日记与任务](user-guide/diary) |
| 管理日常任务与项目 | [任务卡 · 项目管理](user-guide/task-cards) |
| 背单词、管理生词本 | [英语字典·生词本](user-guide/vocabulary) |
| 写章节、插图、调格式 | [章节编辑](user-guide/chapter-editing) |
| 安静地码字 | [专注模式](user-guide/focus-mode) |
| 管理人物/设定 | [世界观资料库](user-guide/worldbuilding) |
| 用 AI 聊天、续写、润色 | [AI 助手](user-guide/ai-assistant) |
| 让 AI 自主完成复杂写作任务 | [Agent 自动化](user-guide/agent-panel) |
| 回退到旧版本 | [版本管理](user-guide/version-management) |
| 导出作品 / 备份与恢复 | [导入导出](user-guide/import-export)　·　[导入导出规范](development/import-export-spec) |
| 换主题、调字体 | [个性化设置](user-guide/personalization) |
| 查问题 | [常见问题](FAQ) |

### 🧑‍💻 我要改代码

| 我想…… | 去看 |
|--------|------|
| 了解目录与分层 | [项目结构](development/project-structure) |
| 查 IPC 命令 | [IPC 命令速查](development/ipc-api) |
| 了解用了哪些技术 | [技术栈](development/tech-stack) |
| 改状态相关逻辑 | [状态管理](development/state-management) |
| 写插件 | [插件系统](development/plugin-system) |
| 看日志、排查问题 | [调试控制台](development/debug-console) |
| 了解 CI/CD | [GitHub 集成](development/github-integration) |
| 改备份/导入导出 | [导入导出规范](development/import-export-spec) · [开发计划](development/import-export-plan) |
| 提 PR | [贡献指南](development/contributing) |

### 🏗️ 我要理解架构

| 我想…… | 去看 |
|--------|------|
| 整体长什么样 | [架构总览](architecture/overview) |
| 深入每个模块 | [代码架构深度分析](architecture/code-architecture) |
| 改 AI 对话 / RAG | [AI 模块架构](architecture/AI-architecture) |
| 改 Agent / Skill / 记忆 | [Agent 引擎架构](architecture/agent-architecture) |

### 📋 我要看项目状态

- [功能清单](features/feature-list) — 已实现什么、路线图
- [更新日志](CHANGELOG) — 每个版本的变更
- [优化报告](meta/optimization-report) — 已知问题与改进项（含处理状态）

---

## 二、文档清单

### 根级

| 文档 | 职责 |
|------|------|
| `Home.md` | Wiki 首页：产品简介、技术栈、应用信息 |
| `DOC-INDEX.md` | 本页：文档地图与维护规范 |
| `CHANGELOG.md` | 版本更新日志 |
| `FAQ.md` | 常见问题（使用 / Agent / 开发） |
| `_Sidebar.md` | Wiki 侧边栏导航 |
| `_Footer.md` | Wiki 页脚 |

### `user-guide/`（13 篇）

`quick-start` · `library-management` · `diary` · `task-cards` · `vocabulary` · `chapter-editing` · `focus-mode` · `worldbuilding` · `ai-assistant` · `agent-panel` · `version-management` · `import-export` · `personalization`

### `features/`（2 篇）

`feature-list` · `ai-assistant`

### `development/`（10 篇）

`project-structure` · `ipc-api` · `tech-stack` · `state-management` · `plugin-system` · `debug-console` · `github-integration` · `import-export-spec` · `import-export-plan` · `contributing`

### `architecture/`（4 篇）

`overview` · `code-architecture` · `AI-architecture` · `agent-architecture`

### `architecture/adr/`（4 篇）

`README`（ADR 机制与索引）· `ADR-001-tauri-rust-backend` · `ADR-002-agent-bridge-readonly` · `ADR-003-dual-state-management`

> ADR 通过 `adr/README` 索引页访问，不在侧边栏逐一列出，避免导航臃肿。

### `meta/`（1 篇）

`optimization-report`

---

**合计 40 篇**（根级 6 + `user-guide/` 13 + `features/` 2 + `development/` 10 + `architecture/` 4 + `architecture/adr/` 4 + `meta/` 1）

---

## 三、维护规范

### 3.1 文档元信息

每篇文档开头应包含适用版本与核对日期：

```markdown
> **适用版本**：`1.7.0`　|　**最后核对**：2026-09-05
```

无法确认版本的文档应标注：

```markdown
> ⚠️ 本文档可能已过时，请以代码为准。
```

### 3.2 版本号单一真源

**应用版本以 `package.json` 与 `src-tauri/tauri.conf.json` 为准**，文档中的版本号必须与其一致。

发版时必须同步：

1. `package.json` 的 `version`
2. `src-tauri/tauri.conf.json` 的 `version`
3. `docs/CHANGELOG.md` 新增条目
4. `docs/Home.md` 与 `README.md` 的「当前版本」
5. 受影响文档头部的「适用版本」

### 3.3 新增文档清单

1. 在对应子目录创建 `.md`（**使用 ASCII 小写文件名 + 连字符**，避免中文文件名在 Wiki URL 中的编码问题）
2. 在 `_Sidebar.md` 的对应板块加入链接
3. 更新本文档的「文档清单」
4. 若涉及新子目录，**无需修改 GitHub Actions** —— `deploy-wiki.yml` 会动态扫描 `docs/` 下所有子目录

### 3.4 内部链接写法

GitHub Wiki 不支持子目录页面，同步脚本会做两件事：

| 步骤 | 仓库中 | 同步到 Wiki 后 |
|------|--------|--------------|
| 文件扁平化 | `docs/user-guide/quick-start.md` | `user-guide-quick-start.md` |
| 链接改写 | `user-guide/quick-start` | `user-guide-quick-start` |

**因此：文档内部链接一律写成「相对 `docs/` 根」的路径（含 `/`）**，脚本会自动转换。

### 写法规则（唯一标准）

| 链接目标位置 | 写法 | 示例 |
|------------|------|------|
| `docs/` 根级页面 | 直接写文件名 | `CHANGELOG`、`FAQ`、`Home`、`DOC-INDEX` |
| `docs/<子目录>/` 下的页面 | 写完整的子目录路径 | `user-guide/quick-start`、`architecture/adr/README` |

关键约束：

- **不要写 `../`**（如 `../development/ipc-api`）—— 脚本只匹配 `(<子目录>/`，`../` 前缀无法转换，同步到 Wiki 后失效。
- **不要写同级裸文件名**（如 `docs/architecture/overview.md` 里写 `agent-architecture`）—— 在仓库内浏览会解析成 `docs/architecture/agent-architecture`，与 Wiki 扁平化规则不一致，必须写成 `architecture/agent-architecture`。
- **不要手动写成扁平化形式**（`user-guide-quick-start`）—— 脚本无匹配可转换，且仓库内浏览会失效。

> 2026-09-05 全量核对时统一了这一规则：此前混用 `../` 与同级裸文件名，导致仓库与 Wiki 各有一批链接失效。

### 自检方法

改动链接后，按「扁平化」规则验证：把 `docs/a/b.md` 映射为 `a-b`，把链接 `a/b` 映射为 `a-b`，确认该名字存在于页面集合中。

### 3.5 同步机制

`docs/**` 变更推送到 `main` 分支后，`.github/workflows/deploy-wiki.yml` 自动同步到 GitHub Wiki：

```
验证 docs/ 目录（≥10 个 .md）
  → 克隆 Wiki 仓库
  → 清空 → 复制（子目录扁平化）
  → 修正内部链接
  → 强制推送
  → 验证关键页面 HTTP 200
```

### 3.6 写作约定

| 项 | 约定 |
|----|------|
| 标题层级 | 每篇一个 `#` 一级标题，`##` 分节 |
| 代码引用 | 标注**文件路径**，不写行号（行号易失效） |
| 数据口径 | 与代码常量保持一致，如命令数、atom 数、表数量 |
| 中文排版 | 中英文之间加空格；使用全角标点 |
| 状态标记 | ✅ 已实现 · 🔜 规划中 · ⚠️ 需注意 · ❌ 未修复 |

---

## 四、已知的历史文档问题（v1.0.0 整理时修复）

以下问题已在 2026-08-31 的文档重构中处理，记录在此以避免回退：

| 问题 | 处理方式 |
|------|---------|
| 版本标注混乱（0.9.4 / 0.6.0 / 1.0.0 并存） | 统一为 `1.0.0`，CHANGELOG 补 v1.0.0 条目 |
| v1.7.0 发布后文档仍停留 `1.6.0` | 2026-09-05 全量核对并统一为 `1.7.0`，补齐 v1.7.0 的导入导出 v2 说明 |
| `PROJECT_STRUCTURE.md` 与 `development/project-structure.md` 重复 | 拆分合并为 `project-structure.md` + `ipc-api.md` |
| 三份 AI 文档描述同一主题 | 合并为 `architecture/AI-architecture.md` + `features/ai-assistant.md` |
| 1.0.0 的 Python Agent 特性零覆盖 | 新增 `architecture/agent-architecture.md` + `user-guide/agent-panel.md` |
| 优化报告为「死文档」，未标注处理状态 | 移入 `meta/optimization-report.md`，逐条标注状态、补充 Agent 相关问题 |
| Wiki 同步脚本硬编码 4 个子目录 | 改为动态扫描，支持任意层级子目录 |
| 文档无元信息规范 | 建立本文档的「维护规范」章节 |
