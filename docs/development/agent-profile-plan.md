# 领域感知 Agent 实施计划

> **适用版本**：`1.20.0`　|　**最后核对**：2026-10-09
> **决策依据**：[ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)

本文档把 ADR-004 拆成可执行的阶段任务。**建议严格按阶段顺序推进**——阶段一还清技术债后，阶段二、三的改动面会显著缩小。

---

## 零、现状速览（改动前必读）

| 项 | 现状 | 位置 |
|---|------|------|
| 引擎 | Rust 原生 ReAct，6 工具 + 三层记忆 + 轨迹回放，已就绪 | `src-tauri/src/commands/agent/` |
| 聊天链路 | `useAiChat` → `execute_agent_skill`（**已在走 Agent 引擎**，默认 `skill='writing'`） | `src/components/ai/useAiChat.ts` |
| 工具箱链路 | `stream_ai_chat` 直连，**仅此一个调用点**，无工具无记忆 | `src/components/ai/AiToolboxPanel.tsx` |
| Skill 定义 | 4 个，散落 **7 处硬编码**，无 struct | `prompts.rs` / `tools.rs` / `engine.rs` / `agent/types.ts` / `ai/panel/constants.ts` |
| 作品类型 | ❌ **不存在** | `Book` 前后端各 14 字段 |
| 大纲可读性 | ❌ 工具集读不到作品 / 章节大纲 | `commands/agent/tools.rs` |

---

## 阶段一：Skill 注册表收敛（还清技术债）

> 目标：把「加一个 Skill 要改 7 处」降为「改 1 处」。本阶段**不引入任何新功能**，纯重构，行为应与重构前完全一致。

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 定义 `SkillProfile` 结构体 | `src-tauri/src/commands/agent/profiles.rs`（**新建**） | 字段：`id` / `base_prompt` / `hints: Vec<(关键词, 追加提示)>` / `tools: Vec<&str>` / `max_rounds` / `timeout_secs` |
| 2 | 建立注册表与查表函数 | 同上 | `pub fn profile(skill: &str) -> &'static SkillProfile`，未知 id 回退 `writing`（保持既有兜底语义） |
| 3 | 迁移基准提示与动态提示 | `commands/agent/prompts.rs` | 删除两处 `match`，改为查表 |
| 4 | 迁移工具子集 | `commands/agent/tools.rs` | `tools_for_skill` 改为查表 |
| 5 | 迁移执行预算 | `commands/agent/engine.rs` | `AgentBudget::for_skill` 改为查表 |
| 6 | 前端元数据收口 | `src/components/agent/types.ts` | `SKILLS` 数组保留（前端需要图标 / 颜色等 UI 属性），但补充注释指向 Rust 侧为单一真相源 |
| 7 | 快捷语改为数据驱动 | `src/components/ai/panel/constants.ts` | `getAgentQuickActions` 的穷举 `switch` 改为按 skill 查表，避免漏改编译失败 |

### 验收

- `cargo check` 通过，`pnpm check` 228 项全通过
- 4 个现有 skill 的提示词、工具集、预算与重构前**逐字一致**（建议先写快照测试固化）
- 新增一个测试用 skill 只需改 1 处即可跑通

---

## 阶段二：`book_type` 字段落库

> 目标：给作品加上「类型」属性，并让它随备份迁移。改动面约 18 处，**务必逐项核对**，漏一处会导致「导出 → 导入」丢字段（这类事故在备份审查中已出现过一次）。

### 任务

**Rust 侧**

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src-tauri/src/db/ddl/core.rs` | `books` 建表加 `book_type TEXT NOT NULL DEFAULT ''` |
| 2 | `src-tauri/src/db/ddl/migrations.rs` | 追加 `("books", "book_type", "TEXT NOT NULL DEFAULT ''")` 补列（不同步会导致 `validate_database` 误报缺列） |
| 3 | `src-tauri/src/db/schema.rs` | `books` 列清单加 `"book_type"` |
| 4 | `src-tauri/src/models/mod.rs` | `Book` 加 `pub book_type: String` |
| 5 | `src-tauri/src/repository/book_repo.rs` | `BOOK_SELECT` 常量加列名；`parse_book` 加取值；`insert` 加列与参数 |
| 6 | `src-tauri/src/service/book_service.rs` | `UpdateBookParams` 加 `book_type: Option<String>`；更新实现加 `upd.push` |
| 7 | `src-tauri/src/commands/book.rs` | `CreateBookParams` 加字段 |

**备份链路（易漏，单独列出）**

| # | 文件 | 改动 |
|---|------|------|
| 8 | `commands/io/backup/export.rs` | SELECT 列清单 |
| 9 | `commands/io/backup/import.rs` | INSERT / UPDATE 列与参数 |
| 10 | `commands/io/backup/reconcile.rs` | SELECT 列 + 一致性比较字段 |
| 11 | `commands/io/backup/mod.rs` | 兼容用建表语句 |
| 12 | `commands/io/backup/types.rs` | 备份数据结构加字段 |

**前端侧**

| # | 文件 | 改动 |
|---|------|------|
| 13 | `src/types/index.ts` | `Book` 加 `bookType` |
| 14 | `src/components/library/NewBookDialog.tsx` | 加类型选择器（小说 / 论文 / 拆书），提交时带上 |
| 15 | **新建** `src/components/library/EditBookDialog.tsx` | 编辑作品弹窗（当前项目**只有新建弹窗**，没有编辑入口），至少支持改类型、书名、作者 |
| 16 | 书库卡片右键菜单 | 挂上「编辑作品」入口 |

### 验收

- `cargo check` + `pnpm check` 全通过
- `validate_database` 不报缺列
- **往返测试**：新建带类型的作品 → 导出 → 清空 → 导入 → 类型字段仍在
- 存量作品（空字符串）能正常显示并回退到默认类型

---

## 阶段三：领域画像 + Prompt 组装

> 目标：让模型知道自己在处理什么类型的作品。

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 定义 `AgentProfile` | `commands/agent/profiles.rs` | `id` / `label` / `domain_prompt`（≤ 400 字）/ `tools`（领域专属工具）/ 领域动态提示 |
| 2 | 内置三个画像 | 同上 | 小说（情节·人物·文风）/ 论文（论点·论据·引用）/ 拆书（拆解·卡片·要点） |
| 3 | 扩展组装入参 | `commands/agent/engine.rs` | `run_skill_inner` 增加领域参数；**从 `book_id` 在 Rust 侧反查 `book_type`**，前端不传参 |
| 4 | 四段拼接 | 同上 | 领域基准 → 能力基准 + 动态 → 记忆 → 摘要 → 尾缀 |
| 5 | 空值兜底 | 同上 | `book_type` 为空时回退「通用 / 小说」画像，不报错 |
| 6 | 领域工具（可选） | `commands/agent/tools.rs` | 拆书 Agent 的「拆章 / 生成卡片」、论文 Agent 的「引用格式」等，可二期做 |

### 验收

- 同一句话在小说 / 论文 / 拆书三种类型下，模型的输出结构明显不同
- 未知 / 空 `book_type` 不报错，回退默认
- 系统提示总长度可控（建议断言上限）

---

## 阶段四：前端交互

> 目标：让用户看得见、选得着。

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 领域选择器 | `src/components/ai/panel/`（新建组件） | AI 面板头部加领域切换，读取当前作品的 `bookType` |
| 2 | 头部布局重排 | `src/components/ai/panel/Header.tsx` | 现有「模式切换（聊天 / Agent）+ 4 个技能 chips」已较拥挤，需重新规划，注意窄栏溢出（此前调试控制台头部就出现过浮层遮挡过滤控件的溢出问题） |
| 3 | 选择持久化 | `AiSidePanel.tsx` 或偏好 store | 当前模式与技能选择都是纯 `useState`，刷新即回默认；建议至少持久化技能选择 |
| 4 | 书库侧联动（可选） | 书库卡片 / 编辑弹窗 | 在卡片上显示类型徽标 |

### 验收

- 切换作品时领域自动跟随该作品的 `bookType`
- 面板头部在最小窗口宽度下不溢出、不遮挡
- 刷新后选择状态保持

---

## 优先级汇总

| 级别 | 内容 | 建议时机 |
|------|------|---------|
| 🟠 P1 | 阶段一 Skill 注册表收敛 | **最先做**，无风险且降低后续成本 |
| 🟠 P1 | 阶段二 `book_type` 落库 | 阶段一之后 |
| 🟡 P2 | 阶段三 领域画像与组装 | 阶段二之后 |
| 🟡 P2 | 阶段四 前端交互 | 与阶段三并行 |
| 🔴 **P0（独立）** | **补齐大纲读取工具** | 可与阶段一并行 |

### 关于 P0：大纲工具比领域提示更关键

拆书 Agent 与论文 Agent 都强依赖大纲，但**当前工具集里没有任何工具能读到 `books.outline` 或 `chapters.outline`** —— 大纲只在前端做「是否存在」的前置校验，内容本身模型看不到。

也就是说，即使加好了领域提示，模型仍然读不到大纲，只能靠用户手动粘贴。建议在 `commands/agent/tools.rs` 补两个工具（读作品大纲、读章节大纲），这个缺口对体验的影响比领域提示更大，且不依赖前四个阶段的任何改动。

---

## 风险与规避

| 风险 | 规避方式 |
|------|---------|
| `book_type` 漏改备份链路，导致导出往返丢字段 | 阶段二把备份 5 处**单列成表**；验收强制做往返测试 |
| 存量作品类型为空 | 明确兜底为默认画像，不报错 |
| 领域提示叠加导致上下文膨胀 | 领域提示限制 ≤ 400 字；组装后断言总长度 |
| 面板头部控件过多导致溢出 | 阶段四验收含最小宽度检查；参考此前调试控制台的浮层遮挡教训 |
| 阶段一重构改变既有行为 | 先写快照测试固化 4 个 skill 的提示词 / 工具 / 预算，重构后逐字比对 |

---

## 相关文档

- [ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)
- [Agent 引擎架构](architecture/agent-architecture)
- [AI 模块架构](architecture/AI-architecture)
- [IPC 命令速查](development/ipc-api)
