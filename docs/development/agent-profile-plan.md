# 领域感知 Agent 实施计划

> **适用版本`1.21.0`　|　**最后核对**：2026-10-12
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

## 进度总览

| 阶段 | 内容 | 状态 |
|------|------|------|
| 一 | L0 工具注册表 | ✅ **已完成**（2026-10-10） |
| 二 | L1 画像注册表 | ✅ **已完成**（2026-10-10） |
| 三 | `book_type` 落库 | ✅ **已完成**（2026-10-10） |
| 四 | 领域画像 + Prompt 组装 | ✅ **已完成**（2026-10-10） |
| 五 | L3 前端自动发现 | ✅ **已完成**（2026-10-10） |
| 六 | L2 `RuntimeMode` / Pipeline | ✅ **已完成**（2026-10-11；`SingleShot` 刻意未做，见该节决策 2） |
| 七 | 插件宿主 | ✅ **已完成**（2026-10-12；10 项全落地，含任务 2/3 前端编排运行时与任务 8 备份文件打包，见该节） |

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

## 阶段一：L0 工具注册表 ✅ 已完成

> 目标：把「加一个工具要改 3 处」降为「改 1 处」。本阶段**不引入任何新功能**，纯重构，行为应与重构前完全一致。

### 完成情况（2026-10-10）

三处 `match` 已全部消除，收敛为 `TOOLS: &[ToolDef]` 单一真相源：

| 改造点 | 改前 | 改后 |
|--------|------|------|
| schema 定义 | `tool_schema` 内 6 分支 `match` | 查 `ToolDef.description` + `parameters()` |
| 工具分发 | `execute_tool` 内 6 分支 `match` | 查 `ToolDef.execute` 函数指针 |
| 未注册名处理 | `build_tools_schema` 静默跳过 | 跳过 + `eprintln!` 告警（不 panic） |

顺带的收益：6 个工具只有 4 种参数形态（`params_book` / `params_book_chapter` / `params_book_chapter_chunk` / `params_book_query`），已提取共享，消除了逐工具重复的字面量。

**回归防线**：新增 `tool_schemas_match_pre_refactor_snapshot` 测试，用**重构前实际导出**的 6 条紧凑 JSON 做逐字断言；该测试同时断言快照条数 = `TOOLS.len()`，**将来新增工具必须同步补快照**，防止 schema 被无意改动。

**实证**：临时加过 `__probe_tool` 探针验证「只改 `TOOLS` 一处即可获得 schema 与执行能力」，通过后已移除。

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

## 阶段二：L1 画像注册表 ✅ 已完成

> 目标：把「加一个 Skill 要改 7 处」降为「改 1 处」，同时为领域画像准备好数据结构。本阶段同样**不引入新功能**，仍是纯重构。

### 完成情况（2026-10-10）

新建 `profiles.rs`，把原先散落在三处的 Skill 定义收敛为 `static PROFILES` 单一真相源：

| 改造点 | 改前 | 改后 |
|--------|------|------|
| 基准提示 + 场景提示 | `prompts.rs` 两处 `match` | 查 `AgentProfile.base_prompt` / `.hints` |
| 工具子集 | `tools.rs` 的 `tools_for_skill` `match` | 查 `AgentProfile.tools`（引用 L0 工具名） |
| 执行预算 | `engine.rs` 的 `AgentBudget::for_skill` `match` | 查 `AgentProfile.max_rounds` / `.timeout_secs` |
| 前端快捷语 | `constants.ts` 穷举 `switch` | `QUICK_ACTIONS` 查表 |

**⚠️ 一处关键发现：四处兜底语义并不一致**，不能统一「未知 id 回退 writing」：

| 调用点 | 未知 id 的兜底 |
|--------|---------------|
| 基准提示 | 回退 writing ✅ |
| 动态场景提示 | **空表**（不是 writing 的 5 条） |
| 工具子集 | 默认 5 项（恰等于 writing） |
| 执行预算 | **(15, 600)** —— 不是 writing 的 (5, 300) |

因此注册表提供 `find_profile`（精确查表，`None` 表示未找到）+ `profile_or_writing`（回退 writing），**由各调用点自行选择兜底**，避免统一回退改变行为。

**回归防线**：`profiles.rs` 内置重构前导出的基线（提示词字符数 / hints 条数 / 工具数 / 超时），并断言 `BASELINE.len() == PROFILES.len()`；另单测 hint 关键词顺序（决定「最多注入 3 条」的截断结果）、工具集、未知 id 语义，以及画像引用的工具名都存在于 L0 注册表。

**两处刻意延后**（已在 ADR-005 注明）：`kind`（能力 / 领域）与 `extends`（继承）**推迟到阶段四**。阶段二只有 4 个能力画像，`kind` 无第二个取值对象、`extends` 无使用者，提前加入即成死代码，会破坏「`cargo check` 零警告」。阶段四引入领域画像时两者同时落地。

### 任务（记录原始拆分，含延后项）

| # | 任务 | 文件 | 状态 |
|---|------|------|------|
| 1 | 定义 `AgentProfile` | `src-tauri/src/commands/agent/profiles.rs`（**新建**） | ✅ 完成（`id` / `base_prompt` / `hints` / `tools` / `max_rounds` / `timeout_secs`） |
| 2 | **用同一 struct + `kind` 区分** | 同上 | ⏸ **延后至阶段四**（当前只有能力画像，`kind` 无区分对象） |
| 3 | 建立注册表与查表 | 同上 | ✅ 完成（`find_profile` + `profile_or_writing`，兜底语义各调用点自定） |
| 4 | 实现继承解析 | 同上 | ⏸ **延后至阶段四**（当前无画像使用继承） |
| 5 | 迁移现有 4 个 Skill | 同上 | ✅ 完成，字段值与现状逐字一致 |
| 6 | 迁移基准提示与动态提示 | `commands/agent/prompts.rs` | ✅ 完成，两处 `match` 已删 |
| 7 | 迁移工具子集 | `commands/agent/tools.rs` | ✅ 完成 |
| 8 | 迁移执行预算 | `commands/agent/engine.rs` | ✅ 完成 |
| 9 | 快捷语改数据驱动 | `src/components/ai/panel/constants.ts` | ✅ 完成 |

> 任务 9 是**过渡措施**：阶段五落地 L3 自动发现后，这份前端表会被 IPC 下发的数据取代并删除。此处先数据化是为了让阶段二可独立验收。

### 验收

- `cargo check` + `pnpm check` 全通过
- 4 个现有 skill 的提示词、工具集、预算与重构前**逐字一致**
- 新增一个测试用 skill 只需改 1 处即可跑通
- 继承解析有单测覆盖（父级字段、子级覆盖、未知父级）

---

## 阶段三：`book_type` 字段落库 ✅ 已完成

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
| 13 | `src/types/index.ts` | `Book` 加 `bookType`；`CreateBookParams` / `UpdateBookParams` 同步加可选字段 |
| 14 | `src/components/library/NewBookDialog.tsx` | 加类型选择器（小说 / 论文 / 拆书 / 学科笔记），提交时带上；学科笔记附说明「按学科组织的结构化学习笔记，区别于日记」 |
| 15 | `src/components/library/EditBookDialog.tsx` | **改造**（原计划误写为「新建」）：加类型选择器，支持改类型 / 书名 / 作者 |
| 16 | 书库卡片右键菜单 | **无需改动**：`BookCard.tsx:106` 已有「编辑信息」入口 |

> ⚠️ 任务 14 的类型选项建议**不要在各弹窗内硬编码**，改为阶段五 L3 自动发现后从 IPC 拉取；此处先硬编码以保证阶段三可独立验收，**阶段五任务 9 必须回头替换**（该任务为必做项，非可选）。

### 完成情况（2026-10-10）

**原计划任务 15 / 16 的前提有误**——`EditBookDialog.tsx` 早已存在（commit `34e11d5`），且 `BookCard.tsx:106` 右键菜单已挂「编辑信息」入口，「项目只有新建弹窗、没有编辑入口」的判断不成立。故任务 15 改为改造既有弹窗，任务 16 取消。

落地改动：

| 层 | 文件 | 改动 |
|----|------|------|
| DB | `ddl/core.rs` / `ddl/migrations.rs` / `db/schema.rs` | `books` 加 `book_type TEXT NOT NULL DEFAULT ''`（建表 + 补列 + 列清单三处同步，否则 `validate_database` 误报缺列） |
| 模型 | `models/mod.rs` | `Book` 加 `pub book_type: String`，`#[serde(rename = "bookType", default)]` —— `default` 保证**旧备份 JSON 缺该字段时仍能反序列化** |
| 仓储 | `repository/book_repo.rs` | `BOOK_SELECT` 加列、`parse_book` 取值、`insert` 加第 9 参数 |
| 服务 | `service/book_service.rs` | `UpdateBookParams` 加 `Option<String>`，`upd.push("book_type", v)` |
| 命令 | `commands/book.rs` | `CreateBookParams` 加字段并透传 |
| 备份 | `backup/import.rs` | UPDATE 加 `?15`、两条 INSERT 加列（**丢字段事故重灾区**） |
| 备份 | `backup/reconcile.rs` | SELECT 加列 + 两处指纹数组同步（否则一致性比对永远「全匹配」） |
| 备份 | `backup/mod.rs`、`commands/agent/tools.rs` | 测试用建表语句补列 |
| 前端 | `types/index.ts` | `Book` / `CreateBookParams` / `UpdateBookParams` 三处 |
| 前端 | **`lib/book-types.ts`（新建）** | 值域表 + `normalizeBookType()` 归一化；作为阶段五 L3 的**唯一替换点** |
| 前端 | **`components/library/BookTypePicker.tsx`（新建）** | 两弹窗共用的类型选择控件，避免在两处重复硬编码 |
| 前端 | `NewBookDialog.tsx` / `EditBookDialog.tsx` | 接入选择器；编辑弹窗用 `normalizeBookType(book.bookType)` 初始化，存量空串显示為「小说」 |

**导出侧无需改动**：`export.rs` 走 `book_repo::list_all_include_deleted`，复用 `BOOK_SELECT`，新列自动带上。

**回归防线（新增 3 组测试）**：

- `book_type_survives_import_upsert` —— 覆盖备份 INSERT 与 UPDATE 两条路径，断言类型往返不丢
- `book_type_defaults_empty_for_legacy_backup` —— 旧备份缺 `bookType` 字段时导入不报错，回退空串
- `src/test/bookTypes.test.ts` —— 空串 / `undefined` / `null` / 未知值 / 大小写不一致均回退 `novel`

### 验收

- `cargo check` + `pnpm check` 全通过
- `validate_database` 不报缺列
- **往返测试**：新建带类型的作品 → 导出 → 清空 → 导入 → 类型字段仍在
- 存量作品（空字符串）能正常显示并回退到默认类型

---

## 阶段四：领域画像 + Prompt 组装 ✅ 已完成

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

### 完成情况（2026-10-10）

任务 1–5、7 已完成；**任务 6（领域工具）已按下方说明随阶段六补齐**——「拆章 / 生成卡片」两个工具于阶段六「任务 0」落地，详见该节。

#### 落地改动

| 文件 | 改动 |
|------|------|
| `profiles.rs` | 加 `ProfileKind`（`Ability` / `Domain`）；`AgentProfile` 加 `kind` 字段；新增 4 个领域画像（novel / thesis / breakdown / note，id 对齐 `book_type` 值域）；新增 `find_ability` / `find_domain` / `ability_or_writing` / `domain_or_novel`；新增 `EffectiveProfile` + `merge()` |
| `prompts.rs` | `get_dynamic_prompt(skill, msg)` → `compose_system_prompt(eff, msg)`；按「领域基准 → 能力基准 → 领域 hints → 能力 hints」四段拼接；两类 hints 各上限 3 条 |
| `engine.rs` | `run_skill_inner` 新增第 1 步：**从 `book_id` 反查 `book_type`**（走 `book_repo::find_by_id`，前端不传参）；预算改取 `AgentBudget::from_effective`；工具集改传 `eff.tools`；新增画像调试日志 |
| `tools.rs` | `build_tools_schema` 入参由 `skill: &str` 改为 `tool_names: &[&str]`（不再自行查表）；删除 `tools_for_skill` 与 `FALLBACK_TOOLS`（兜底语义改由 `merge` 承载） |
| `logging.rs` | 新增 `app_log_warn!` 宏（项目此前只有 `app_log!` / `app_log_error!`），用于未知 `book_type` 告警 |

#### ⚠️ 两处刻意偏离原计划

**1. `extends`（继承）不实现。** 原计划阶段二注明「`kind` 与 `extends` 推迟到阶段四一并加入」。实际只有 `kind` 落地：`extend` 会让四个平级的领域画像多一个**无人读取**的字段，即死代码，破坏「`cargo check` 零警告」。将来真出现「某领域继承自另一领域」时再补。

**2. 任务 6（领域工具）延后至阶段六。** 领域画像的 `tools` 恒为 `&[]`（领域定义世界观、不定义动作），合并取并集时等价于能力工具集。这样阶段四可独立验收，且阶段六新增领域工具时只需在登记表里追加。

> ✅ **已闭环**：阶段六补齐了 `split_chapter` / `create_note_card`，并把原先共用的空 `DOMAIN_TOOLS` 拆为「创作类领域不带工具 / 提炼类领域带 `EXTRACTION_TOOLS`」。

#### ⚠️ 关键发现：未知能力的兜底语义必须按维度分别保住

`merge()` 会把未知能力 id 兜底为 writing（基准提示需要内容），但这**不能**连带套用 writing 的个性化配置——否则两处行为会漂移：

| 维度 | 未知能力 id 的兜底 | 保护手段 |
|------|------------------|---------|
| 基准提示 | writing（必须有内容） | — |
| 工具集 | writing 的 5 项 | — |
| 执行预算 | **(15 轮 / 600s)**，不是 writing 的 (5 / 300) | `EffectiveProfile::ability_matched` |
| 动态 hints | **不注入** writing 的 hints | 同上 |

因此 `EffectiveProfile` 新增 `ability_matched: bool` 记录「能力 id 是否命中」——只看 `ability.id` 无法区分「显式选了 writing」与「未知 id 兜底成 writing」。两个维度各有单测锁死。

#### 顺带消除的 4 处死代码

改造后 `cargo check` 报出 4 个 `never used`（`AgentBudget::for_skill`、`FALLBACK_TOOLS`、`tools_for_skill`、`estimate_prompt_tokens`）——均为「改造后失去生产消费端」。按前两阶段的 YAGNI 教训逐个收敛：前三个删除或改由 `merge` 承载；`estimate_prompt_tokens` 则**接到调试日志里输出基准提示的估算 token 数**（任务 7 本就要求画像调试输出），既消除死代码又增加可观测性。

#### 测试

新增 12 条（`cargo test --lib` **199/199**）：拼接顺序、四类 hints 命中、关键词重叠时领域在前、每类 hints 上限 3 条、四种领域产出互不相同的提示词、工具并集、预算取大值、未知能力在预算与 hints 两个维度的兜底、`book_type` 值域覆盖、kind 隔离查找、全命中时提示词 token 上限（<2000）。

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

## 阶段五：L3 前端自动发现与交互 ✅ 已完成

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
| 9 | 类型选项去硬编码（**必做**） | `src/lib/book-types.ts` | 阶段三为可独立验收而硬编码的 4 个类型选项，改从 `list_agent_profiles`（取 `kind = Domain`）拉取。**替换点已收敛到单一文件**——阶段三新建了 `lib/book-types.ts` 集中值域、`components/library/BookTypePicker.tsx` 只渲染不定义，届时只需改 `book-types.ts`，两个弹窗无需改动。**不做的后果**：将来新增领域要同时改后端注册表与前端弹窗，「后端改一处」的收益被抵消 |

> 图标沿用现有**字符串图标名**约定（`pen-tool` / `search` 等），前端只做「图标名 → 组件」映射，不引入新的映射表。

### 验收

- 切换作品时领域自动跟随该作品的 `bookType`
- 面板头部在最小窗口宽度下不溢出、不遮挡
- 刷新后选择状态保持
- **关闭验证**：后端新增一个画像后，前端不改一行代码即可显示并使用
- `pnpm check` 的 IPC 注册一致性检查通过

### 完成情况（2026-10-10）

9 项任务全部完成（任务 8 原标「可选」，一并做了——它让领域画像的 `icon` / `color` 有了消费端）。

#### 落地改动

**Rust 侧**

| 文件 | 改动 |
|------|------|
| `profiles.rs` | `AgentProfile` 加 5 个展示字段（`label` / `description` / `icon` / `color` / `quick_actions`）；`ProfileKind` 加 `Serialize`（`rename_all = lowercase`）；新增 `ProfileMeta` + `profile_metas()`；快捷操作文案从前端 `constants.ts` 迁入注册表 |
| `skills.rs` | 新增 `list_agent_profiles` 命令（纯查常量，无需 DB / AppHandle） |
| `lib.rs` | 注册该命令 |

**前端侧**

| 文件 | 改动 |
|------|------|
| `types/index.ts` | 新增 `ProfileKind` / `ProfileMeta` |
| `lib/tauri-bridge.ts` | `agentApi.listProfiles()` |
| **`lib/agent-profiles.ts`（新建）** | 模块级缓存 + 飞行去抖 + `useSyncExternalStore` 订阅；图标名→组件映射（未知名回退 `BotIcon`） |
| `lib/book-types.ts` | 值域改为从 IPC 派生（`getBookTypes()` / `useBookTypes()`），任务 9 完成 |
| `components/agent/types.ts` | `SkillType` 由字面量联合改为 `string`；删除硬编码 `SKILLS` |
| `components/ai/panel/constants.ts` | 删除 `QUICK_ACTIONS` / `getAgentQuickActions` |
| `components/ai/panel/Header.tsx` | 接收 `abilities` / `domain`；领域徽标 + 技能 chips 同行（领域在前且 `shrink-0`）；未加载渲染骨架 |
| `AiSidePanel.tsx` | 加载画像、解析领域、技能选择持久化（localStorage）+ 失效校验 |
| `AgentInputArea` / `AgentMessageList` / `AgentMessageBubble` | 改用后端下发的元数据；删除气泡里的 emoji 硬编码映射 |
| `BookTypePicker` / 两个弹窗 | 类型列表由 `useBookTypes()` 提供 |
| `components/library/BookCard.tsx` | 封面左下角加类型徽标（左上角留给「更多菜单」按钮） |

#### ⚠️ 两处设计决策

**1. 「骨架」与「兜底表」按场景区分，不能一刀切。**

初版想统一「IPC 未就绪就回退硬编码表」，但那会让 L3 的目标落空——回退表里永远没有新增的画像。按控件性质分别处理：

| 场景 | 未就绪时 | 理由 |
|------|---------|------|
| AI 面板技能 chips | 渲染骨架 | 短暂空白可接受；回退表会让新画像永远不显示 |
| 新建 / 编辑弹窗的类型选择器 | 用内置兜底值 | 表单控件没有选项就无法渲染，必须保证可用 |

两者都在 IPC 返回后切换到后端值域，故「后端新增画像 → 前端零改动」均成立。

**2. 领域是「展示」而非「切换器」。**

原任务 5 写的是「领域切换」。实际做成**只读徽标**：领域由作品的 `book_type` 决定（阶段四已在 Rust 侧反查），用户改类型应去「编辑作品信息」。这样避免把面板上的一次误点变成写库操作，也符合「领域是作品属性」的建模。验收中的「切换作品时领域自动跟随」照常成立。

#### 顺带发现

- `observability::bus::tests::list_filters_by_kind` 是**偶发 flaky**（全局缓冲 + 多线程竞争）：单独跑通过，连跑三次全量也通过，但曾在某次全量中失败一次。与本次改动无关，记录备查。

#### 测试

- Rust `cargo test --lib` **202/202**（+3：元数据完整性、快捷操作文案比对、`ProfileMeta` 序列化后 `kind` 为小写且**不含提示词**）
- `pnpm check` **231/231**（`list_agent_profiles` 已由 check 脚本自动同步进 `ipc-commands.ts`）

---

## 阶段六：L2 `RuntimeMode`（P2，工作量最大）

> 目标：覆盖「固定流程类 Agent」，并作为**插件的编排层**。
>
> ⚠️ **优先级已上调**：v2 中本阶段为 P3（「可延后」）。ADR-006 确认插件的自定义逻辑需要「编排层」承载，本阶段因此从「拆书 Agent 的附属」升为**插件宿主的前置依赖**。

### 背景

`react_loop` 是唯一执行入口，`tool_choice: "auto"`，循环至 `max_rounds`。但「拆书」本质是「读章节 → 提炼要点 → 生成卡片」的固定序列，「学科笔记」的「整理 → 出题」同理——这类需求要的是**确定的执行流程**，换提示词无法让自由 ReAct 稳定走完固定步骤。

### 任务

| # | 任务 | 文件 | 说明 | 状态 |
|---|------|------|------|------|
| 0 | 补两个领域工具（阶段四遗留） | `tools.rs` / `profiles.rs` | `split_chapter` / `create_note_card` | ✅ |
| 1 | 定义 `RuntimeMode` 枚举 | **`profiles.rs`**（计划原写 `engine.rs`） | `ReAct` / `Pipeline(&[Step])` | ✅ |
| 2 | `AgentProfile` 加字段 | `profiles.rs` | `runtime: RuntimeMode` | ✅ |
| 3 | 实现 `Pipeline` 执行器 | **`pipeline.rs`**（新建） | 步骤序列、可中断、保留已完成产物 | ✅ |
| 4 | 实现 `SingleShot` 执行器 | — | 单轮直出，无工具循环 | ⬜ **刻意未做**，见决策 2 |
| 5 | 拆书 Agent 切 `Pipeline` | `profiles.rs` | 首个真实用例 | ✅ |
| 6 | AI 工具箱迁 `SingleShot`（可选） | `AiToolboxPanel.tsx` | 依赖任务 4 | ⬜ 随任务 4 一并搁置 |

### 完成情况

#### 任务 0：补齐两个领域工具（阶段四遗留的必做前置）

计划阶段四任务 6 已注明「最晚与阶段六同批完成」，本阶段先行补齐，否则流水线后两步无从落地。

| 工具 | 作用 | 要点 |
|------|------|------|
| `split_chapter` | 读：把章节按段落边界切成片段 | 三级递进切分（段落 → 句 → 按字数硬切），保证每段严格 ≤ `max_chars`；超过 12 段时后续只给预览并提示调大 `max_chars` |
| `create_note_card` | 写：把要点固化成卡片 | `card_type` **硬性校验**为前端 `WorldCardType` 的 6 个取值，越界返回结构化错误且不落库 |

工具经 `EXTRACTION_TOOLS` 引入，仅 `breakdown` / `note` 两个提炼类领域可见；`novel` / `thesis` 保持不带工具（严格门禁）。

#### 关键设计

| 项 | 决策 |
|----|------|
| `RuntimeMode` 归属 | 放 `profiles.rs`，是「画像声明自己怎么跑」的配置数据，与 L1 注册表同源；`engine` 依赖 `profiles`，反向不成立 |
| `Step` 形态 | `{ name, instruction, tools, max_rounds }`——一个**收窄了工具与轮数**的 ReAct |
| 与 ReAct 的关系 | 每步复用 `engine::react_loop`，只换工具表 / 轮数 / 指令。SSE 解析、取消竞争、trace 上报三条链路无第二套实现 |
| 合并规则 | 执行模式**领域优先、能力次之**：流程形状由「处理什么作品」决定，能力通常不固定流程 |
| 产物传递 | 每步独立构造消息（不带入上一步的工具往返），已完成产物以「## 前序步骤产物」用户消息喂给下一步 |
| 文本一致性 | 步骤头 / 占位 / 收尾经同一批函数生成，流式推送与最终渲染共用 → 前端累积文本与 IPC 返回值逐字一致 |
| 拆书三步 | ① 拆章节（`list_book_chapters`+`split_chapter`，4 轮）→ ② 提炼要点（**无工具**，1 轮）→ ③ 生成卡片（仅 `create_note_card`，8 轮） |

第 ② 步刻意不给工具：否则模型会绕开「先读后写」，边编边写——那正是自由 ReAct 的失败模式。

#### ⚠️ 三处刻意偏离

**1. `RuntimeMode` 放 `profiles.rs` 而非计划写的 `engine.rs`。**
计划让 `engine.rs` 定义枚举、`profiles.rs` 引用它。但 `AgentProfile` 要带 `runtime` 字段，等于 `profiles` 反过来依赖 `engine`——而 `engine` 已依赖 `profiles`。Rust 虽允许模块互引，但依赖方向会绕成环，读代码时无法判断谁是谁的上游。枚举属于「配置数据」，放在 L1 注册表里更贴合 ADR-005 的分层。

**2. `SingleShot` 未实现。**
计划中唯一的消费方是任务 6「AI 工具箱迁 `SingleShot`」，而该迁移本身标为**可选**，且需先对齐容错能力（工具箱有网络重试，Agent 链路没有）。在此之前加入只会是一个无人构造的枚举变体——与 `extends` 同样的取舍（见阶段四决策 1）。

**3. Pipeline 单步失败不自动重试。**
计划验收写的是「可重试」。实际**不做自动重试**：`create_note_card` 有副作用且不可重入，盲重试会造成重复卡片。改为「停下 + 保留已完成产物 + 文本里给出 `x/y` 结构化进度」，由人决定是否续跑。所需信息（哪步失败、失败原因、已完成部分）都在返回文本里。

### 验收

- ✅ 拆书 Agent 在 `Pipeline` 模式下按固定三步执行，顺序与工具边界由画像保证，不再依赖模型自行规划
- ✅ `ReAct` 模式行为与改造前完全一致：`run_skill_inner` 的 ReAct 分支构造 `engine::ReactCtx`（收拢 url / api_key / model / temperature / max_tokens / request_id / cancel_token / budget / skill 9 个运行时参数），传入新签名 `react_loop(app, pool, tools_schema, &mut messages, &mut full_response, &mut tool_rounds, ctx)`（原 15 参数收拢为 7，消除 `clippy::too_many_arguments` suppressions）
- ✅ Pipeline 可中断（每步开始前检查取消令牌，`react_loop` 内部亦有竞争点）
- ✅ 单步失败不丢失已完成步骤的中间产物（部分成功 + 结构化进度）

#### 顺带发现（P1，本次未修）

`WorldbuildingPanel.tsx:447` 的 `WORLD_CARD_TYPE_CONFIG[card.type].icon` **无兜底**，卡片 `type` 一旦是配置表外的值（旧备份导入、其他来源写入）即 `undefined.icon` 抛错，整个设定面板白屏。

`create_note_card` 已在**写入侧**硬性拦截（校验值域 + 不落库），堵住了本阶段新增的这条路径；但**渲染侧**的隐患仍在，属既有缺陷。建议后续加一行兜底：`WORLD_CARD_TYPE_CONFIG[card.type] ?? WORLD_CARD_TYPE_CONFIG.misc`。

#### 测试

- Rust `cargo test --lib` **219/219**（+17：领域工具行为 6、领域门禁与执行模式 4、流水线纯函数与渲染 7）
- 前端 `vitest run` **110/110**（本阶段未改前端，属回归验证）
- `pnpm check` **231/231**
- `cargo check --all-targets` **零警告**

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
| ⚠️ CSP | **已放宽**：`script-src 'self' 'unsafe-eval'`（Tauri v2 不支持按窗口隔离，放宽即全局）。放宽后已有真实消费端——前端编排运行时用 `new Function` 执行插件 JS 产出 plan（16 个单测覆盖） |
| 执行 | 插件 JS 只在**前端**跑一次产出 `plan`（步骤 / 指示 / 工具），plan 交 Rust 引擎执行；插件**不参与**逐轮工具循环 |

### 任务

| # | 任务 | 文件 | 说明 | 状态 |
|---|------|------|------|------|
| 1 | 放宽 CSP | `src-tauri/tauri.conf.json` | 取 `'unsafe-eval'`（放弃 `asset:` + `<script src>`：拿不到返回值、只能靠全局变量暴露、隔离性更差） | ✅ |
| 2 | 定义 `PluginHost` 注入面 | `src/agent-plugin/host.ts`（新建） | `llm` / `book` / `card` / `log` / `storage` | ✅ |
| 3 | 注入面单测固化 | `src/test/agentPluginHost.test.ts` | 断言「未声明的 `grants` 一律不注入」（16 个用例） | ✅ |
| 4 | 插件加载器 + 启用清单 | `src-tauri/src/plugin/`（新建） | 扫描 `{app_data_dir}/plugins/`、解析 manifest、校验 id / grants / 画像；`enabled.json` 持久化 | ✅ |
| 5 | 新增 IPC 命令 | `commands/plugin.rs` + `lib.rs` | `plugin_list` / `install` / `uninstall` / `set_enabled` / `source`（5 个，已同步 `ipc-commands.ts`） | ✅ |
| 6 | 安装确认 UI | `settings/PluginSection.tsx`（新建） | 展示源码供审核 + 逐项列出 `grants`；**装完默认未启用**，确认后才启用 | ✅ |
| 7 | 启用清单持久化 | `plugin/loader.rs` | 取**独立文件** `{app_data_dir}/plugins/enabled.json`（与插件目录同处，不动 `app_config` 四段注册链路） | ✅ |
| 8 | 插件纳入备份 | `commands/io/backup/files.rs`（新建） | 备份体系原本**不含任何文件**，已为其新增文件资产段（内嵌 base64），`plugins/` 与 `attachments/` 一并纳入 | ✅ |
| 9 | 概念划界 | `docs/development/plugin-system.md` | 已补「两套插件的划界」章节；ADR-006 四个 follow-up 已定稿 | ✅ |
| 10 | **插件画像接入 L3** | `commands/agent/skills.rs` + `engine.rs` | 列表侧合并内置 + 插件画像；**执行侧同样要改**，否则跑的仍是 writing | ✅ |

### 完成情况（2026-10-12）

**落地范围：声明式插件闭环。** 插件贡献 Agent 画像（提示词 / 工具 / 预算 / UI 元数据），
由 Rust 引擎执行，可完整跑 ReAct 与 Pipeline。安装、卸载、启用、持久化、审核 UI 均已可用。

**后续补做（同日）：** 任务 2/3（PluginHost 注入面 + 前端编排运行时）与任务 8（备份文件打包）
经用户定稿后一并补做，至此 10 项全部落地，详见下方两小节。

#### 三个计划前提经核查不成立

| # | 计划 / ADR 的假设 | 实际情况 |
|---|---|---|
| 1 | 任务 10 只是「合并返回值」 | `ProfileMeta` 的字段全是 `&'static str`，插件画像是运行时 `String`——整个结构需改为 owned；且**执行侧必须同步改**（`profiles::merge` 对未知 id 兜底 writing，不改则选了插件画像却跑 writing） |
| 2 | 「复用现有 `ID_PATTERN`」 | 它只在前端 `src/plugins/schema.ts`，Rust 侧没有；**字符集不含 `:` 与 `.`**，与 ADR 建议的 `<plugin-id>:<profile-id>` 前缀直接冲突——故改用「撞车即拒绝」而非加前缀 |
| 3 | 任务 8「插件纳入备份」 | 备份是**纯数据库内容的加密 JSON**（`ExportPayload`），**不含任何文件**——连 `attachments/` 都不在备份内。纳入插件等于给备份体系引入全新的文件打包能力。**已按用户定稿补做**：新增 `files` 段（内嵌 base64），`plugins/` 与 `attachments/` 一并纳入，见下 |

#### 两个关键设计决定

- **`grants` 必须覆盖插件声明的工具**（`grant_for_tool`）。插件画像是声明式的，
  由引擎代为执行、不跑插件 JS；若不把工具名映射回 `grants` 就校验，
  插件可绕过权限声明直接借 L0 的原子能力读写数据，`grants` 形同虚设。
- **`EffectiveProfile` 无需改结构**。工具名虽在 `Vec<String>` 里，但**值必在 L0 注册表内**
  （加载时校验过），可映射回 `&'static str`；`ability_matched: false` 连带两个正确后果：
  不注入 writing 的动态提示、预算不套用 writing 的 `(5, 300)`。

#### 刻意偏离

- **安装只复制 `manifest.json` + `entry` 两个文件**，不递归复制源目录——
  包格式本来就只定义这两个，多拷一个都是无谓的攻击面。
- **`log` 不列为 grant**：日志不读不写数据、无副作用，恒定注入；
  列为可选项只会让确认界面多一个无需决策的噪音项。
- **装坏的插件仍列出**（`status: "error"` + 原因），否则用户永远无法卸载它。

#### 任务 2 / 3：前端编排运行时（PluginHost 注入面）

识别出本 ADR 未考虑的架构约束：**Agent 引擎在 Rust 侧，无法回调前端 JS**。
用户定稿为「保留 CSP 放宽，做完整前端编排运行时」（而非回退放宽），落地形态：

- **职责切分**：插件 JS 只在前端跑**一次**，用受限 `host` 产出 `plan`（步骤 / 指示 / 工具 / 轮数）；
  plan 经 `execute_agent_skill` 的 `plan` 参数回传 Rust，由**原生引擎**执行逐轮工具循环。
  插件因此**不参与**逐轮循环 —— 既避开「前端再造一套引擎」的重复，
  也让 CSP 放宽有了真实消费端（`new Function`，不再是无收益的净风险）。
- **权限即字段存在性**：`host` 上未声明 grant 的能力**字段不存在**（不是返回 undefined 的空壳）；
  `card.search` 与 `card.create` 各自独立；`log` 恒定注入。
- **双保险**：前端校验 plan 只是 UX，Rust 侧 `plan_is_allowed` 在 IPC 边界**再校验一次**
  （IPC 入参不可信）。plan 失败/超时一律降级为 `null`，不让对话挂掉。
- `TOOLS_BY_GRANT` 是 Rust `grant_for_tool` 的前端镜像，两侧必须同步改（单测各自覆盖）。

#### 任务 8：备份文件打包

- **形态**：文件以 base64 内嵌进同一份 JSON（`files.items[].contentB64`），
  不走 tar/zip —— 加解密链路、`payloadHash` 语义、「临时文件 + rename」原子写出全部不用改，
  且零新增依赖（`base64` 已在依赖表中）。
- **仅全量备份携带**：插件与附件都不是作品级数据，与 `app_config` 同一条规则。
- **还原只写不删**：文件没有回退点（`rollback_import` 只恢复数据库），按 replace 语义
  先清空本地目录会导致「回滚了库但文件回不来」。故只写备份里有的文件，本地多余文件保留；
  `fill-gaps` 策略连同名文件也不覆盖（与「绝不触碰已有数据」一致）。
- **路径白名单**：`path` 来自不可信备份，必须落在 `plugins/` 或 `attachments/` 内，
  挡住 `../`、绝对路径与 `\`（单测覆盖）。收集时不追符号链接。
- **上限**：单文件 32 MB 跳过、文件段总量 64 MB 截断并置 `truncated`（留日志）。
  选截断而非报错，是因为附件动辄几十 MB，因它超标就拒绝整份备份代价太大。
- **兼容性**：版本号仍 `2.0`（加性扩展，旧版 App 忽略未知字段、新版读旧备份得 `None`）；
  `payloadHash` 仍只覆盖 `database`，不因文件段改变幂等判定。

> ⚠️ **已知缺口（用户知情后选定的取舍）**：`attachments/` 的文件进了备份，但
> `tasks` / `attachments` **两张表不在** `DatabaseExport` 里。因此在跨机迁移场景下，
> 还原出来的附件是没有库内引用的孤儿文件（会被每日孤儿清理删掉）。
> 要真正闭环需把 `tasks` / `subtasks` / `attachments` 一并纳入 DB 导出，属独立议题。

### 验收

- ✅ 安装插件后**不重启应用**即可在 AI 面板看到并选中它（画像已并入 `list_agent_profiles`）
- ✅ 卸载后插件痕迹清除（含 `app_data_dir` 目录与启用清单条目）
- ✅ 启用状态在重启后保持（`enabled.json`）
- ✅ 插件声明了未被 `grants` 覆盖的工具时**拒绝加载**并点明缺哪个 grant（单测覆盖）
- ✅ 插件画像 id 与内置画像撞车时拒绝加载（`E_PLUGIN_CONFLICT`，单测覆盖）
- ✅ `grants` 未声明的能力在 `host` 上**字段不存在**（16 个前端单测覆盖：llm / book / card 读写 / storage 各自独立）
- ✅ 插件 plan 声明越权工具时**两端都拒绝**（前端归一化 + Rust `plan_is_allowed` 再校验）
- ✅ 插件 JS 语法错 / 超时 / 抛异常时**对话不挂**（降级为 null，走内置编排）
- ✅ 插件内 `fetch` 外部地址被 CSP 拦截（`connect-src` 已限制）
- ✅ 往返备份后插件仍在（全量备份打包 `plugins/`，还原只写不删；含 7 个 Rust 单测）
- ✅ 旧版备份（无 `files` 段）与单作品备份照常导入

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
