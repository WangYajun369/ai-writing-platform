# ADR-005：Agent 扩展模型（工具注册表 / 执行模式 / 前端自动发现）

> **状态**：提议
> **日期**：2026-10-10
> **影响范围**：Agent 引擎 / IPC 契约 / 前端 AI 面板
> **适用版本**：`1.20.0`　|　**最后核对**：2026-10-10
> **相关**：[ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)

## 背景

[ADR-004](architecture/adr/ADR-004-domain-aware-agent-profiles) 解决了「领域与能力正交分层」，但审计其方案时发现：它只收敛了**画像**这一条扩展轴，另外三条仍会拖累后续扩展。本 ADR 处理这三条。

### 审计发现的三处遗留

**一、工具这条扩展轴完全没被收敛。**

新增一个工具需要同时改三处 `match`，外加一个实现函数：

| 位置 | 作用 |
|------|------|
| `tools.rs` 的 `tools_for_skill` | 声明哪些 skill 能用到它 |
| `tools.rs` 的 `tool_schema` | 定义 JSON Schema |
| `tools.rs` 的 `execute_tool` | 按名字分发执行 |

而 ADR-004 的 follow-up 与实施计划都要新增多个工具（大纲、拆章、概念卡、复习题），每一个都要在这三处之间来回改。

**二、执行模式只有一种。**

`engine.rs` 的 `react_loop` 是唯一的执行入口，`tool_choice: "auto"`，循环至 `max_rounds` 为止——**没有流水线或编排的概念**。

但「拆书」的本质是「读章节 → 提炼要点 → 生成卡片」的固定序列，「学科笔记」的「整理 → 出题」同理。这类需求要的是**确定的执行流程**，不是让模型自由发挥。换提示词无法让自由 ReAct 稳定地走完固定步骤。

**三、前后端双份维护。**

同一份语义存在三处：Rust 的 `match` 分支（行为）、前端 `agent/types.ts` 的 `SKILLS`（UI 元数据）、`ai/panel/constants.ts` 的 `getAgentQuickActions`（快捷语）。且 `SkillType` 是**字面量联合类型**，新增一个 skill 前端必须改——「前端零改动」因此不可能实现。

### 一个被忽略的有利事实

工具系统其实**已经是准注册表形态**：`react_loop` 中唯一的执行调用是 `tools::execute_tool(&conn, &tc.name, &args)`，只按**名字字符串**派发；而 `build_tools_schema` 已能从名字列表自动生成 schema。

也就是说工具层只差临门一脚：把三处 `match` 合并为一个 `ToolDef` 数组。**改造阻力远小于画像层**，应当最先做。

## 备选方案

### 扩展机制载体

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. Rust 静态注册表（struct 数组） | 类型安全；可写快照测试；执行体可直接是函数指针 | 改定义需重新编译 |
| B. `app_config` 动态配置 | 运行时可改 | 工具执行体无法序列化，只能配置提示词；长文本编辑体验差 |
| C. 复用**现有前端插件系统** | 已有 PluginManager 基建 | ❌ 不可行：`'ai-prompt'` 扩展点**无任何消费端**；`PluginContext` 无 IPC / 数据库能力；且 `bootstrap.ts` 是编译期硬编码 `import`，**根本不支持运行时装卸**。复用它需重建整套后端桥接，成本高于收益 |

> ⚠️ 本项排除的是「复用 `src/plugins/` 这套前端插件系统」，**不是排除插件化本身**。用户后续确认需要支持第三方编写的 Agent 插件，该诉求由 [ADR-006：Agent 插件宿主](architecture/adr/ADR-006-agent-plugin-host) 单独承载，且本 ADR 的 L0 / L1 / L2 正是它的前置地基。

### 执行模式

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 只保留 ReAct | 零改动 | 固定流程类 Agent 做不出稳定效果 |
| B. 引入 `RuntimeMode` 枚举（ReAct / Pipeline / SingleShot） | 覆盖三类需求；`SingleShot` 可顺带把 AI 工具箱纳入同一套 | Pipeline 需全新实现，是最大工作量项 |
| C. 外挂工作流引擎（如 LiteFlow） | 表达力强 | 过重，与「单用户桌面应用」定位不符；引入新依赖 |

## 决策

采用 **A + B**，即**四层扩展模型**：

| 层 | 内容 | 解决什么 |
|----|------|---------|
| **L0** | 工具注册表 `ToolDef[]`：`{ name, description, parameters, execute }` | 加工具 3 处 → 1 处 |
| **L1** | 画像注册表 `AgentProfile[]`：以 `kind: Skill \| Domain` 区分能力与领域，**引用 L0 的工具名**，支持继承与增量覆盖 | 加画像 7 处 → 1 处 |
| **L2** | `RuntimeMode` 枚举：`ReAct`（现状）/ `Pipeline(&[Step])`（固定步骤序列）/ `SingleShot`（单轮直出） | 覆盖固定流程类 Agent |
| **L3** | IPC `list_agent_profiles` 连 UI 元数据一并下发，前端运行时发现 | 消灭前后端双份，前端零改动 |

补充三条设计约定：

1. **L1 用同一 struct + `kind` 字段**，不拆成 `SkillProfile` / `AgentProfile` 两个结构——两者形状几乎一致，拆开只会导致合并逻辑重复实现。
2. **支持继承**：`thesis` 可继承 `writing` 只覆盖差异字段，避免每次都抄一遍完整定义。
3. **工具用「能力标签」声明式订阅**（可选增强）：工具声明 `tags: ["chapter", "read"]`，画像声明 `require: ["chapter"]` 自动匹配。这样新增工具会被相关画像自动采纳，不必回头改 N 个画像的工具列表。

**实施分两步**（2026-10-10 阶段二落地时确定）：约定 1 的 `kind` 与约定 2 的 `extends` **延后到阶段四**，不在阶段二引入。原因是阶段二只迁移 4 个能力画像——`kind` 无第二个取值对象、`extends` 无使用者，提前加入即成死代码（本项目要求 `cargo check` 零警告）。阶段四引入领域画像时两者同时落地，`kind` 立即有 `Skill` / `Domain` 两类实例。

## 理由

1. **L0 阻力最小、收益最直接**。工具已按名字派发，合并三处 `match` 是纯重构、零行为变化，却让后续所有新增工具（ADR-004 已列出至少 4 个）从「改 3 处」降为「改 1 处」。
2. **L2 是需求真实性的倒逼**。ADR-004 自己把「拆书」定义为「章节拆解 → 要点提炼 → 卡片化输出」，这已经是流水线的描述。只做提示词差异化，等于让模型自己猜流程，稳定性无法保证。
3. **L3 是「扩展方便」的闭环**。只要前端还硬编码 `SkillType` 字面量联合与 `SKILLS` 数组，新增任何画像都必然要动前端，「后端改一处」的收益就被抵消一半。
4. **不复用现有前端插件系统**。审计确认 `'ai-prompt'` 扩展点无消费端、`PluginContext` 无后端能力，且它是编译期硬编码的静态容器、不支持运行时装卸。第三方 Agent 插件的诉求改由 [ADR-006](architecture/adr/ADR-006-agent-plugin-host) 另建宿主演进——本 ADR 的 L0（原子能力清单）与 L2（编排层）正是它的地基。

## 后果

### 正面

- 新增一个画像：后端改 1 处，前端 **0 处**
- 新增一个工具：改 1 处（现 3 处）
- 固定流程类 Agent（拆书、学科笔记出题）有确定的执行语义，输出可预期
- `SingleShot` 模式可把 AI 工具箱（当前走 `stream_ai_chat` 的独立链路）纳入同一套画像体系，消除「两套链路能力不对等」的历史问题
- 注册表是纯数据，可写快照测试断言每个画像的提示词 / 工具 / 预算，防止误改

### 负面 / 代价

- **Pipeline 模式是最大新增工作量**，当前完全没有，且需要设计步骤间的状态传递与失败重试
- **L3 需要新增 IPC 命令**并改造前端面板，`ipc-commands.ts` 契约会自动同步，需在验收中确认
- **Rust 静态注册表改定义需重新编译**（与 ADR-004 一致的取舍；若将来用户有强自定义需求，再在 L1 之上加 `app_config` 覆盖层，本 ADR 不预先引入）
- **继承带来排查成本**：画像实际生效的字段可能来自父级，需要提供一个「解析后的最终画像」调试输出

### 需要 follow-up 的事项

- 🔜 `Pipeline` 的步骤 schema 如何定义（步骤内是否可有自己的工具子集与预算）—— 本 ADR 未定。**这是阶段六的设计前置，不是远期事项**：该阶段已因 ADR-006（插件编排层）由 P3 上调 P2，步骤 schema 需在实现 `Pipeline` 执行器**之前**定稿，否则会阻塞。参见 [实施计划阶段六](development/agent-profile-plan)
- 🔜 `SingleShot` 是否要立刻把 AI 工具箱迁进来 —— 工具箱当前有网络重试而 Agent 链路没有，迁移前需先对齐容错能力
- 🔜 画像继承的层级上限（建议只允许单级继承，避免菱形继承）
- ⚠️ L3 下发 UI 元数据后，前端仍需处理「图标名 → 组件」的映射，建议沿用现有字符串图标名约定（`pen-tool` / `search` 等）以免引入新映射表

## 相关文档

- [ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)
- [ADR-006：Agent 插件宿主（第三方 Agent 的安装与卸载）](architecture/adr/ADR-006-agent-plugin-host) —— 本 ADR 的 L0 / L1 / L2 是其前置地基
- [领域感知 Agent 实施计划](development/agent-profile-plan)
- [Agent 引擎架构](architecture/agent-architecture)
