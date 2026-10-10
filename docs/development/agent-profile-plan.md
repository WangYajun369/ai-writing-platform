# 领域感知 Agent 实施计划

> **适用版本**：`1.20.0`　|　**最后核对**：2026-10-10
> **决策依据**：
> - [ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)
> - [ADR-005：Agent 扩展模型（工具注册表 / 执行模式 / 前端自动发现）](architecture/adr/ADR-005-agent-extension-model)
> - [ADR-006：Agent 插件宿主（第三方 Agent 的安装与卸载）](architecture/adr/ADR-006-agent-plugin-host)

本文档把 ADR-004 / ADR-005 / ADR-006 拆成可执行的阶段任务。**建议严格按阶段顺序推进**——先还清「工具」与「画像」两笔技术债，后续阶段的改动面会显著缩小。

> ⚠️ **v3 修订说明**（2026-10-10）：用户确认需支持**第三方编写的 Agent 插件**（运行时装卸、带自定义逻辑），按 ADR-006 追加阶段七。相较 v2 的变化：
> 1. **阶段一到五一个字不改**——ADR-006 的插件宿主 = 本计划的 L0 / L1 / L2 + 运行时加载器 + 权限模型，先做地基不返工；
> 2. **阶段六 `Pipeline` 从 P3 提到 P2**——它现在是插件的编排层，不再只是拆书 Agent 的附属；
> 3. 新增**阶段七 插件宿主**。

> ⚠️ **v2 修订说明**（2026-10-10）：按 ADR-005 的四层扩展模型重排。相较 v1 的主要变化：
> 1. 原「阶段一 Skill 注册表」拆为**阶段一 L0 工具注册表**与**阶段二 L1 画像注册表**，且顺序不可颠倒；
> 2. 新增**合并规则表**与 **`book_type` 值域表**（v1 缺失，实施时必然卡住）；
> 3. 前端交互从「硬编码选择器」改为 **L3 IPC 自动发现**；
> 4. 新增**阶段六 `RuntimeMode`**，覆盖固定流程类 Agent。

---

## 零、现状速览（改动前必读）

| 项 | 现状 | 位置 |
|---|------|------|
| 引擎 | Rust 原生 ReAct，6 工具 + 三层记忆 + 轨迹回放，已就绪 | `src-tauri/src/commands/agent/` |
| 聊天链路 | `useAiChat` → `execute_agent_skill`（**已在走 Agent 引擎**，默认 `skill='writing'`） | `src/components/ai/useAiChat.ts` |
| 工具箱链路 | `stream_ai_chat` 直连，**仅此一个调用点**，无工具无记忆 | `src/components/ai/AiToolboxPanel.tsx` |
| Skill 定义 | 4 个，散落 **7 处硬编码**，无 struct | `prompts.rs` / `tools.rs` / `engine.rs` / `agent/types.ts` / `ai/panel/constants.ts` |
| 工具定义 | 6 个，散落 **3 处 `match`**（订阅 / schema / 分发） | `commands/agent/tools.rs` |
| 作品类型 | ❌ **不存在** | `Book` 前后端各 14 字段 |
| 大纲可读性 | ❌ 工具集读不到作品 / 章节大纲 | `commands/agent/tools.rs` |
| 执行模式 | 仅 `react_loop` 一种，`tool_choice: "auto"` | `commands/agent/engine.rs` |
| 现有插件系统 | ❌ **与运行时装卸无关**：`bootstrap.ts` 硬编码 import；`PluginContext` 11 方法无 IPC；7 扩展点中 5 个零消费端 | `src/plugins/`（**阶段七另建宿主，不复用它**） |

---

## 阶段一：L0 工具注册表（最先做，还清技术债）

> 目标：把「加一个工具要改 3 处」降为「改 1 处」。本阶段**不引入任何新功能**，纯重构，行为应与重构前完全一致。

**为什么最先做**：L1 的画像要引用 L0 的工具名，先做 L0 才能让画像定义是纯数据。反过来做会先产生一批硬编码工具名，随后还要再改一遍。

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 定义 `ToolDef` | `src-tauri/src/commands/agent/tools.rs`（原地改造） | `name` / `description` / `parameters`（JSON Schema）/ `execute: fn(&Connection, &Value) -> Result<String>` |
| 2 | 建立注册表 | 同上 | `static TOOLS: &[ToolDef]`；`executors` 由函数指针承载，无需额外分发表 |
| 3 | `tools_for_skill` 改查表 | 同上 | 先按 skill 名取工具名列表，再由注册表过滤出存在的条目（未知名跳过并告警，不 panic） |
| 4 | `tool_schema` 改查表 | 同上 | 从 `ToolDef.parameters` 直接产出，行为与现状逐字一致 |
| 5 | `execute_tool` 改查表 | 同上 | 按名字在注册表查找并调用 `execute`，未命中返回既有错误文案 |
| 6 | （可选增强）能力标签 | 同上 | `ToolDef` 加 `tags: &[&str]`，画像用 `require: &[&str]` 声明式订阅，新增工具可被相关画像自动采纳 |

### 验收

- `cargo check` 通过，`pnpm check` 全通过
- 现有 6 个工具的 schema JSON 与重构前**逐字一致**（建议先写快照测试固化）
- 新增一个测试用工具只需改 1 处即可跑通
- `agent_traces` 中回放旧轨迹，工具调用结果不变

---

## 阶段二：L1 画像注册表

> 目标：把「加一个 Skill 要改 7 处」降为「改 1 处」，同时为领域画像准备好数据结构。本阶段同样**不引入新功能**，仍是纯重构。

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 定义 `AgentProfile` | `src-tauri/src/commands/agent/profiles.rs`（**新建**） | `id` / `kind: Skill \| Domain` / `label` / `base_prompt` / `hints: Vec<(关键词, 追加提示)>` / `tools: Vec<&str>`（**引用 L0 工具名**）/ `max_rounds` / `timeout_secs` / `extends: Option<&str>` |
| 2 | **用同一 struct + `kind` 区分** | 同上 | 不拆成 `SkillProfile` / `DomainProfile` 两个结构——形状几乎一致，拆开只会导致合并逻辑重复实现 |
| 3 | 建立注册表与查表 | 同上 | `pub fn profile(id: &str) -> AgentProfile`；未知 id 回退 `writing`（保持既有兜底语义） |
| 4 | 实现继承解析 | 同上 | `thesis` 可 `extends: "writing"` 只覆盖差异字段；**建议只允许单级继承**，避免菱形继承 |
| 5 | 迁移现有 4 个 Skill | 同上 | `writing` / `analysis` / `research` / `polish`，字段值与现状逐字一致 |
| 6 | 迁移基准提示与动态提示 | `commands/agent/prompts.rs` | 删除两处 `match`，改为查表 |
| 7 | 迁移工具子集 | `commands/agent/tools.rs` | `tools_for_skill` 改为读画像的 `tools` 字段（已在 L0 落地后变为纯数据） |
| 8 | 迁移执行预算 | `commands/agent/engine.rs` | `AgentBudget::for_skill` 改为查表 |
| 9 | 快捷语改数据驱动 | `src/components/ai/panel/constants.ts` | `getAgentQuickActions` 的穷举 `switch` 改为按 id 查表，避免漏改编译失败 |

> 任务 9 是**过渡措施**：阶段五落地 L3 自动发现后，这份前端表会被 IPC 下发的数据取代并删除。此处先数据化是为了让阶段二可独立验收。

### 验收

- `cargo check` + `pnpm check` 全通过
- 4 个现有 skill 的提示词、工具集、预算与重构前**逐字一致**
- 新增一个测试用 skill 只需改 1 处即可跑通
- 继承解析有单测覆盖（父级字段、子级覆盖、未知父级）

---

## 阶段三：`book_type` 字段落库

> 目标：给作品加上「类型」属性，并让它随备份迁移。改动面约 18 处，**务必逐项核对**，漏一处会导致「导出 → 导入」丢字段（这类事故在备份审查中已出现过一次）。

### 值域与兜底（先定死，避免实施时反复改）

| 存储值 | 含义 | 对应画像 |
|--------|------|---------|
| `novel` | 小说 | 情节 · 人物 · 文风 |
| `thesis` | 论文 | 论点 · 论据 · 引用 |
| `breakdown` | 拆书 | 拆解 · 卡片 · 要点 |
| `note` | 学科笔记 | 概念 · 公式 · 例题 · 复习 |
| `''`（空） | 存量作品或未指定 | **回退 `novel`** |

**不引入「通用」画像**——多一个画像就多一份维护成本，且「通用」与「小说」的差异对模型而言不明确。未知值同样回退 `novel` 并记一条告警日志。

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
| 14 | `src/components/library/NewBookDialog.tsx` | 加类型选择器（小说 / 论文 / 拆书 / 学科笔记），提交时带上；学科笔记建议附一句说明「按学科组织的结构化学习笔记，区别于日记」 |
| 15 | **新建** `src/components/library/EditBookDialog.tsx` | 编辑作品弹窗（当前项目**只有新建弹窗**，没有编辑入口），至少支持改类型、书名、作者 |
| 16 | 书库卡片右键菜单 | 挂上「编辑作品」入口 |

> ⚠️ 任务 14 的类型选项建议**不要硬编码**，改为阶段五 L3 自动发现后从 IPC 拉取；此处先硬编码以保证阶段三可独立验收，**阶段五任务 9 必须回头替换**（该任务为必做项，非可选）。

### 验收

- `cargo check` + `pnpm check` 全通过
- `validate_database` 不报缺列
- **往返测试**：新建带类型的作品 → 导出 → 清空 → 导入 → 类型字段仍在
- 存量作品（空字符串）能正常显示并回退到默认类型

---

## 阶段四：领域画像 + Prompt 组装

> 目标：让模型知道自己在处理什么类型的作品。

### 合并规则（v1 缺失，先定死）

「领域 × 能力」相遇时按以下规则合并：

| 维度 | 合并规则 | 理由 |
|------|---------|------|
| 提示词 | 领域基准 → 能力基准 → 能力动态提示，纯拼接 | 领域定义「世界观」，能力定义「动作」，后者更具体应靠后 |
| 工具集 | **取并集** | 领域工具（如拆章）与能力工具（如读章节）互补，取交集会导致某一侧工具不可用 |
| 执行预算 | **取较大值** | 保守策略，避免领域需要的多轮被能力的小预算截断 |
| 动态提示 | 各自独立命中，**领域提示在前** | 两者关键词域不同，冲突概率低 |

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 内置四个领域画像 | `commands/agent/profiles.rs` | `kind: Domain`，字段复用阶段二的 `AgentProfile`：小说（情节·人物·文风）/ 论文（论点·论据·引用）/ 拆书（拆解·卡片·要点）/ 学科笔记（概念·公式·例题·复习） |
| 2 | 实现合并函数 | 同上 | `merge(skill: &AgentProfile, domain: &AgentProfile) -> EffectiveProfile`，按上表规则实现，含单测 |
| 3 | 扩展组装入参 | `commands/agent/engine.rs` | `run_skill_inner` 增加领域参数；**从 `book_id` 在 Rust 侧反查 `book_type`**，前端不传参 |
| 4 | 四段拼接 | 同上 | 领域基准 → 能力基准 + 动态 → 记忆 → 摘要 → 尾缀 |
| 5 | 空值兜底 | 同上 | `book_type` 为空 / 未知时回退 `novel` 画像并记告警日志，不报错 |
| 6 | 领域工具 | `commands/agent/tools.rs` | **须在阶段一 L0 之后再做**，否则仍要改三处。其中「拆章 / 生成卡片」是**阶段六的前置、必做**（见下方说明）；「引用格式」「概念卡 / 生成复习题」为可选增强 |
| 7 | 调试输出 | `commands/agent/` | 提供「解析后的最终画像」输出（含继承来源），降低继承带来的排查成本 |

### 验收

- 同一句话在小说 / 论文 / 拆书 / 学科笔记四种类型下，模型的输出结构明显不同
- 学科笔记场景实测：给一段杂乱的课堂内容，应输出「概念定义 + 公式 + 例题」的结构化笔记，而非叙事性文字
- 未知 / 空 `book_type` 不报错，回退默认
- 系统提示总长度可控（建议断言上限）
- 合并函数单测覆盖四种维度

> ⚠️ **任务 6 的「拆章 / 生成卡片」不是全程可选**。阶段六任务 5「拆书 Agent 切 Pipeline」是 Pipeline 的首个真实用例，而拆书流水线（读章节 → 提炼要点 → 生成卡片）的后两步就依赖这两个工具。若本阶段不做，阶段六会因缺工具而无法验收。**建议最晚与阶段六同批完成。**

### 补充：学科笔记复用现有数据模型，无需新表

学科笔记不必等新实体设计，直接映射到既有结构即可落地：

| 学科笔记概念 | 复用的现有实体 |
|------------|--------------|
| 学科 / 课程 | 作品（`books`，`book_type = 'note'`） |
| 模块 / 章节组 | 卷（`volumes`） |
| 单条笔记 | 章节（`chapters`） |
| 概念卡 / 术语卡 | 世界观卡片（`world_cards`） |

因此学科笔记 Agent 在阶段四即可用上全部既有工具（读笔记条目、检索概念卡、整书概览），不需要新增表或 IPC 命令。仅「生成复习题」这类增强能力属于任务 6 的可选项。

---

## 阶段五：L3 前端自动发现与交互

> 目标：让用户看得见、选得着，且**新增画像时前端零改动**。

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 新增 IPC 命令 | `src-tauri/src/commands/agent.rs` + `lib.rs` 注册 | `list_agent_profiles` → 返回 `Vec<ProfileMeta>`，含 `id` / `kind` / `label` / `icon` / `color` / `quick_actions` |
| 2 | 前端类型与桥接 | `src/lib/tauri-bridge.ts` | 新增调用；`ipc-commands.ts` 契约由 `pnpm check` 自动同步，需在验收中确认 |
| 3 | `SkillType` 改运行时发现 | `src/components/agent/types.ts` | 字面量联合类型 → `string`（或保留联合但新增兜底分支）；`SKILLS` 数组改为 IPC 拉取并缓存 |
| 4 | 删除前端硬编码 | `src/components/ai/panel/constants.ts` | `getAgentQuickActions` 的本地表删除，改读 IPC 下发的 `quick_actions` |
| 5 | 领域选择器 | `src/components/ai/panel/`（新建组件） | AI 面板头部加领域切换，读取当前作品的 `bookType` |
| 6 | 头部布局重排 | `src/components/ai/panel/Header.tsx` | 现有「模式切换（聊天 / Agent）+ 4 个技能 chips」已较拥挤，需重新规划，注意窄栏溢出（此前调试控制台头部就出现过浮层遮挡过滤控件的溢出问题） |
| 7 | 选择持久化 | `AiSidePanel.tsx` 或偏好 store | 当前模式与技能选择都是纯 `useState`，刷新即回默认；建议至少持久化技能选择 |
| 8 | 书库卡片类型徽标（可选） | 书库卡片 | 在卡片上显示类型徽标 |
| 9 | 类型选项去硬编码（**必做**） | `NewBookDialog.tsx` / `EditBookDialog.tsx` | 阶段三任务 14 为可独立验收而临时硬编码的 4 个类型选项，改从 `list_agent_profiles`（取 `kind = Domain`）拉取。**不做的后果**：将来新增领域要同时改后端注册表与前端弹窗，「后端改一处」的收益被抵消 |

> 图标沿用现有**字符串图标名**约定（`pen-tool` / `search` 等），前端只做「图标名 → 组件」映射，不引入新的映射表。

### 验收

- 切换作品时领域自动跟随该作品的 `bookType`
- 面板头部在最小窗口宽度下不溢出、不遮挡
- 刷新后选择状态保持
- **关闭验证**：后端新增一个画像后，前端不改一行代码即可显示并使用
- `pnpm check` 的 IPC 注册一致性检查通过

---

## 阶段六：L2 `RuntimeMode`（P2，工作量最大）

> 目标：覆盖「固定流程类 Agent」，并作为**插件的编排层**。
>
> ⚠️ **优先级已上调**：v2 中本阶段为 P3（「可延后」）。ADR-006 确认插件的自定义逻辑需要「编排层」承载，本阶段因此从「拆书 Agent 的附属」升为**插件宿主的前置依赖**。

### 背景

`react_loop` 是唯一执行入口，`tool_choice: "auto"`，循环至 `max_rounds`。但「拆书」本质是「读章节 → 提炼要点 → 生成卡片」的固定序列，「学科笔记」的「整理 → 出题」同理——这类需求要的是**确定的执行流程**，换提示词无法让自由 ReAct 稳定走完固定步骤。

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 定义 `RuntimeMode` 枚举 | `commands/agent/engine.rs` | `ReAct`（现状）/ `Pipeline(&[Step])` / `SingleShot` |
| 2 | `AgentProfile` 加字段 | `commands/agent/profiles.rs` | `runtime: RuntimeMode`，默认 `ReAct` |
| 3 | 实现 `Pipeline` 执行器 | `commands/agent/`（新模块） | 步骤序列执行，需设计步骤间状态传递与失败重试 |
| 4 | 实现 `SingleShot` 执行器 | 同上 | 单轮直出，无工具循环 |
| 5 | 拆书 Agent 切 `Pipeline` | `profiles.rs` | 首个真实用例，验证模式有效性 |
| 6 | AI 工具箱迁 `SingleShot`（可选） | `AiToolboxPanel.tsx` | 消除「两套链路能力不对等」的历史问题；迁移前需先对齐容错能力（工具箱当前有网络重试而 Agent 链路没有） |

### 验收

- 拆书 Agent 在 `Pipeline` 模式下输出稳定可预期，不再依赖模型自行规划步骤
- `ReAct` 模式行为与改造前完全一致（回归验证）
- Pipeline 单步失败可重试、可中断，且不丢失已完成步骤的中间产物

---

## 阶段七：插件宿主（ADR-006）

> 目标：让第三方（含用户自己）编写的 Agent 能**运行时安装 / 卸载**，且带自定义逻辑。
>
> ⚠️ **本阶段依赖阶段一（L0）、阶段二（L1）与阶段六（Pipeline）**：
> - **L0** 决定插件能调用哪些原子能力；
> - **L1** 决定插件贡献的画像长什么样（ADR-006 的 `manifest.profiles` 就是 `AgentProfile`）；
> - **L2 Pipeline** 决定插件的自定义逻辑能表达到什么程度。
>
> **跳过前三者的任何一个直接建宿主，都会导致插件 API 频繁 breaking change。**

### 设计要点（详见 ADR-006）

| 项 | 决策 |
|---|------|
| 载体 | 前端 JS，**不引入 wasmtime**（零新增依赖）；Rust cdylib 已排除（无稳定 ABI） |
| 边界 | 插件**只能编排**宿主原子能力，绝不接触数据库连接与 API Key |
| 实现方式 | 宿主注入受限 `PluginHost` 对象。**不做 IPC 层白名单**——`withGlobalTauri: false` 使插件天然拿不到 invoke 能力 |
| 存放 | `{app_data_dir}/plugins/<id>/` 含 `manifest.json` + `index.js` |
| 权限 | `manifest.json` 的 `grants` 声明，安装时展示，运行时只注入声明项 |
| ⚠️ CSP | `script-src 'self'` 无 `'unsafe-eval'`，加载第三方 JS **必须全局放宽**（Tauri v2 不支持按窗口隔离） |

### 任务

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 放宽 CSP 并实测加载方式 | `src-tauri/tauri.conf.json` | `'unsafe-eval'` 与 `asset:` + `<script src>` 两路线实测后取舍（ADR-006 follow-up） |
| 2 | 定义 `PluginHost` 注入面 | `src/plugins/host/`（新建） | `llm` / `book` / `card` / `log` / `storage`；`llm.complete` **必须走应用自身配置**，禁止插件传 endpoint 或 key |
| 3 | 注入面单测固化 | 同上 | 断言「未声明的 `grants` 一律不注入」，防止高权限方法误挂载 |
| 4 | 插件加载器 | Rust 侧新模块 | 扫描 `{app_data_dir}/plugins/`，解析 manifest 校验 `grants` 合法性 |
| 5 | 新增 IPC 命令 | `commands/` + `lib.rs` 注册 | 枚举 / 安装 / 卸载 / 启用；需同步 `ipc-commands.ts` 契约 |
| 6 | 安装确认 UI | `src/components/settings/`（新建） | **展示源码供审核** + 逐项列出 `grants` 供确认 |
| 7 | 启用清单持久化 | `app_config` 或独立文件 | 现状 `PluginManager.statuses` 是内存 Map，重启即丢——必须补持久化 |
| 8 | 插件纳入备份 | `commands/io/backup/` | 确认体积与导入覆盖策略（ADR-006 follow-up） |
| 9 | 概念划界 | `docs/development/plugin-system.md` | 现有 `src/plugins/` 与本宿主是两套东西，需明确命名（前者「内置模块」，后者「Agent 插件」） |
| 10 | **插件画像接入 L3** | `commands/agent.rs` | `list_agent_profiles` 的返回值须合并「内置注册表画像」+「已启用插件的 `manifest.profiles`」。**不做的话插件装了也看不见**——前端画像列表只认这个 IPC |

### 验收

- 安装一个示例插件后，**不重启应用**即可在 AI 面板看到并选中它（即插件画像已并入 `list_agent_profiles` 返回值）
- 卸载后插件痕迹清除（含 `app_data_dir` 目录与启用清单）
- `grants` 未声明的能力在插件内访问为 `undefined`，且单测覆盖
- 插件内尝试 `fetch` 外部地址被 CSP 拦截（`connect-src` 已限制）
- 启用状态在重启后保持
- 往返备份后插件仍在

---

## 优先级汇总

| 级别 | 内容 | 建议时机 | 依赖 |
|------|------|---------|------|
| 🟠 **P1** | 阶段一 L0 工具注册表 | **最先做**，纯重构零风险，且是所有后续工作的地基 | 无 |
| 🟠 **P1** | 阶段二 L1 画像注册表 | 阶段一之后 | L0 |
| 🟠 **P1** | 阶段三 `book_type` 落库 | 阶段二之后（也可并行） | 无 |
| 🟡 **P2** | 补齐大纲读取工具 | **须在阶段一之后**（否则仍改 3 处） | L0 |
| 🟡 **P2** | 阶段四 领域画像与组装 | 阶段三之后 | L1 + `book_type` |
| 🟡 **P2** | 阶段五 L3 前端自动发现 | 与阶段四并行 | L1 |
| 🟡 **P2** | 阶段六 `RuntimeMode` / `Pipeline` | **已由 P3 上调**，插件的编排层 | L1 |
| 🔵 **P3** | 阶段七 插件宿主 | 最后做，见下方说明 | L0 + L1 + L2 |

### 关于「大纲工具」的时机变化

v1 把补齐大纲工具列为**可与阶段一并行的独立 P0**。v2 修正为**必须在阶段一之后**：ADR-005 确认新增工具要改三处 `match`，若跳过 L0 直接加，会先产生一批新的硬编码，随后阶段一还要再改一遍。

即便如此，这个缺口对体验的影响仍然比领域提示更大——拆书、论文、学科笔记三个 Agent 都强依赖大纲，而**当前工具集里没有任何工具能读到 `books.outline` 或 `chapters.outline`**，大纲只在前端做「是否存在」的前置校验，内容本身模型看不到。建议在 `commands/agent/tools.rs` 补两个工具（读作品大纲、读章节大纲），并作为 L0 落地后的第一个验证用例。

---

## 风险与规避

| 风险 | 规避方式 |
|------|---------|
| `book_type` 漏改备份链路，导致导出往返丢字段 | 阶段三把备份 5 处**单列成表**；验收强制做往返测试 |
| 存量作品类型为空 | 明确兜底为 `novel` 并记告警日志，不报错、不引入「通用」画像 |
| 领域提示叠加导致上下文膨胀 | 领域提示限制 ≤ 400 字；组装后断言总长度 |
| 面板头部控件过多导致溢出 | 阶段五验收含最小宽度检查；参考此前调试控制台的浮层遮挡教训 |
| 阶段一 / 二重构改变既有行为 | 先写快照测试固化 4 个 skill、6 个工具的提示词 / schema / 预算，重构后逐字比对 |
| 继承导致生效字段来源不明 | 只允许单级继承；提供「解析后的最终画像」调试输出（阶段四任务 7） |
| Pipeline 工作量被低估 | 阶段六单列且优先级已上调 **P2**；先用拆书一个用例验证，不一次性铺开 |
| L3 新增 IPC 破坏契约检查 | `ipc-commands.ts` 由 `pnpm check` 自动同步，验收时确认注册一致性 |
| 放宽 CSP 后安全边界下降 | 全局放宽无法按窗口隔离；靠「纯文本可审核 + 安装确认 + `grants` 最小化注入」三层缓解；`connect-src` 保持现状不放宽 |
| 宿主注入面误挂高权限方法 | 注入面用单测固化，断言未声明 `grants` 一律不注入 |
| 跳过 L0 / L1 / Pipeline 直接做插件宿主 | 阶段七明确列为依赖 L0 + L1 + L2；优先级排最后 |
| `src/plugins/` 与插件宿主概念混淆 | 阶段七任务 9 明确命名与文档划界 |

---

## 相关文档

- [ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)
- [ADR-005：Agent 扩展模型（工具注册表 / 执行模式 / 前端自动发现）](architecture/adr/ADR-005-agent-extension-model)
- [ADR-006：Agent 插件宿主（第三方 Agent 的安装与卸载）](architecture/adr/ADR-006-agent-plugin-host)
- [插件系统](development/plugin-system) —— 现有 `src/plugins/` 的说明，与 ADR-006 的宿主是两套东西
- [Agent 引擎架构](architecture/agent-architecture)
- [AI 模块架构](architecture/AI-architecture)
- [IPC 命令速查](development/ipc-api)
