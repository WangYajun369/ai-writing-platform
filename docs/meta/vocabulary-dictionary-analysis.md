# 英语字典 · 生词本 —— 深度分析报告

> **适用版本**：`1.22.0`（`package.json`）　|　**分析日期**：2026-10-15　|　**分析范围**：`src-tauri/src/{commands,service,repository,db}` 的 vocab 模块 + `src/components/vocabulary/**` + `src/plugins/dictionary/**` + `src/stores/vocabStore.ts`
> **综合评级**：⭐ **88 / 100（A-）** → 优化后 **96 / 100（A+）**（2026-10-15 已实施，见[第九节](#九优化实施记录-2026-10-15)）
>
> 架构分层干净、AI 兜底健壮、关联网络设计精巧；原主要失分项（**数据不进备份**、**核心 SM-2 算法零单测**、**ECDICT 全表扫描**、**形态检查模型名不存在**）已全部修复。

---

## 一、总体画像

| 维度 | 数据 |
|------|------|
| 代码规模 | **6,654 行**（Rust 3,077 + 前端组件 3,421 + 插件/Store 156） |
| 文件数 | Rust 6 个（`commands/vocab.rs` / `commands/vocab_dict.rs` / `service/vocab_service.rs` / `service/vocab_relation_service.rs` / `repository/vocab_repo.rs` / `repository/vocab_relation_repo.rs`）；前端 13 个组件 + 2 个插件文件 + 1 个 Store |
| IPC 命令 | **23 个**（`vocab_*` 18 + `dict_*` 5，另有窗口命令 3 个） |
| 数据表 | **3 张业务表**：`vocab_words`（词条）、`vocab_reviews`（复习日志）、`vocab_word_relations`（关联网络） |
| 外部依赖 | ECDICT 离线词库（可选，只读 SQLite）、DeepSeek/OpenAI 兼容端点（AI 释义）、豆包 seed-tts（朗读） |
| 单测覆盖 | Rust **16 项**（全部集中在关联网络层）；前端 **1 个测试文件 / 9 用例**（仅图谱视图纯函数） |
| 运行形态 | 独立窗口（`?vocabwin=1`）+ 首页 `home-header` 插件入口（角标 = 今日待复习数） |

### 代码地图

```
src-tauri/src/
├── commands/vocab.rs                243 行  18 个命令（CRUD / SM-2 / 关联）
├── commands/vocab_dict.rs           760 行  5 个命令（离线查词 / 导入 / AI 释义 / 形态检查）
├── service/vocab_service.rs         569 行  SM-2 调度、收录、统计（⚠️ 零单测）
├── service/vocab_relation_service.rs 848 行 关联自动同步 / 词族 / 图谱构图（9 单测）
├── repository/vocab_repo.rs         330 行  纯 SQL
├── repository/vocab_relation_repo.rs 327 行 纯 SQL（7 单测）
└── utils.rs                           —     dict_db_path / open_dict_db（词典只读连接）

src/
├── components/vocabulary/         3,421 行  VocabularyWindow（壳）+ 3 Tab + 5 Dialog + 3 公共件
├── plugins/dictionary/               65 行  home-header 插件 + 窗口激活/角标状态
├── stores/vocabStore.ts              91 行  stats / words / due / relationCounts + refreshAll
└── test/wordGraph.test.ts           123 行  图谱缩放 / fit 纯函数
```

---

## 二、架构分层与调用链

严格遵循项目 4 层架构，**无越界**：

```
前端 invoke（tauri-bridge.ts → vocabApi / dictApi）
   ↓
commands/（参数解析 + 委派，无 SQL、无业务）     ← vocab.rs / vocab_dict.rs
   ↓
service/（业务规则、校验、事务边界、SQL 审计）    ← vocab_service.rs / vocab_relation_service.rs
   ↓
repository/（纯 SQL，接收 &Connection）           ← vocab_repo.rs / vocab_relation_repo.rs
   ↓
rusqlite（r2d2 池，max_size=10）
```

✅ **亮点**：`commands` 层零 SQL 零业务，DTO 全部用专用 struct + `camelCase` rename，符合项目规范；`repository` 不依赖 Tauri State，可直接用内存库单测（这一点直接换来了 16 项 Rust 单测）。

跨窗口同步链路：

```
任意写操作（add/update/review/delete/set_status）
   → emit_due_updated(app) → Tauri 事件 "vocab-due-updated"
   → ① 词典窗口 useTauriEvent → refreshAll()
   → ② 首页 HomeHeaderPlugins → pullState()（另有 20s 兜底轮询 + 窗口关闭事件）
```

---

## 三、数据模型

| 表 | 关键字段 | 设计评价 |
|----|---------|---------|
| `vocab_words` | `word UNIQUE`、`meanings`(JSON)、`ai_details`(JSON 精讲)、SM-2 五参数（`repetition`/`interval_days`/`ease_factor`/`next_review_at`/`last_review_at`）、`status`(`learning`/`mastered`/`suspended`)、`review_count`/`correct_count`、`source` | ⭐ 优秀。JSON 字段承载 AI 富知识，避免多表扩散；状态机简洁 |
| `vocab_reviews` | `word_id`(FK CASCADE)、`review_date`、`rating`、`repetition`/`interval_days`/`ease_factor` 快照 | ⭐ 快照式日志，统计曲线与详情时间线都够用 |
| `vocab_word_relations` | `word_id`(FK CASCADE)、`related_word`(文本，可未收录)、`relation_type`(5 类)、`source`(`ai`/`ecdict`/`manual`)、`UNIQUE(word_id, related_word, relation_type)` | ⭐ 精妙：**以文本而非 id 记录关联**，因此"未收录的潜在关联"也能持久化，为后续反向激活埋点；三元组唯一约束天然幂等 |

**状态机**：`learning` ⇄ `suspended`（手动暂停）→ `mastered`（手动标记 或 SM-2 自动：`repetition ≥ 7 && interval ≥ 30`）→ 手动回 `learning`。

---

## 四、六大能力拆解

### 1. 收录链路（三级降级，设计最出色的一环）

```
输入单词
 ├─ ① 离线词典自动带出（450ms 防抖，dict_lookup）→ 标「离线词库带出」绿标
 ├─ ② 点「DeepSeek 翻译」
 │    ├─ 2.1 生词本查重（已收录 → 回填表单 + toast 提示，不重复计费）
 │    ├─ 2.2 形态检查 check_word_ai（轻量模型）→ word / inflected / abbreviation / acronym / not_a_word
 │    │      → 变形词自动替换为原型（如 worked → work），并 toast 解释
 │    └─ 2.3 主模型生成完整学习卡片（音标 / 词性释义 / 例句+中译 / 词根词缀 / 近反义 / 词组 / 动词变形 / 按词性例句）
 └─ ③ 全程失败可手动录入
```

**AI 返回解析健壮性（值得单独点赞）**：
- `extract_json_payload` 剥 ``` 围栏 → 首 `{` 到末 `}` 定位，兼容前后说明文字；
- 失败自动重试一次，第二次强制 `response_format: json_object` + 输出上限 4096 → 8192；
- `finish_reason == "length"` 时追加"被截断"原因；错误回显原始内容头尾各 200/160 字符便于排查；
- 日志**只记 api_key 长度**（`api_key_len=`），不落明文 ✅；
- HTTP 状态码分级提示：401/403 → Key 失效；402/429 → 余额/限流；400 含 model 关键词 → 模型不存在。

### 2. SM-2 复习调度（`vocab_service.rs:71-108`）

| 自评档位 | 质量分 q | 行为 |
|---------|---------|------|
| 忘记 | 0 | `repetition=0`、`interval=1` 天、EF 保持不变 |
| 模糊 | 3 | 按公式推进，EF 微降 |
| 记得 | 4 | 按公式推进，EF 微升 |
| 轻松 | 5 | 按公式推进，EF +0.1 |

间隔序列（EF 恒 2.5 时）：1 → 6 → 15 → 38 → 95 → 238 → 594 天；EF 下限 1.3 硬约束。
新词收录时 `next_review_at = today + 1`（次日首次复习，符合艾宾浩斯起点）。
复习写入走 **显式事务**（`uow.begin_transaction()` + `update_review_state` + `insert_review_log`），保证状态与日志原子一致 ✅。

前端复习会话：忘记的词回队尾重测 1 次（`revisit < 1`）、掌握词出队、四档计数结果页、空格/Enter 翻面、1-4 键快捷评分、可把关联词"顺带复习"拉入本轮队列。交互完成度高。

### 3. 单词关联网络（全项目最精巧的设计）

三步自动同步（`sync_auto_relations`，尽力而为不阻断收录）：

| 步骤 | 行为 | 来源标记 |
|------|------|---------|
| ① AI 近/反义 | AI 精讲中的 synonym/antonym 提取英文词 → 潜在关联（**不论是否已收录**） | `ai` |
| ② 反向激活 | 存量关系中 `related_word` 指向本词的 → 为本词补建反向关系（近义↔近义、反义↔反义） | 沿袭原 source |
| ③ 变形家族 | ECDICT `exchange` 的 `0:` 原型聚族，**仅当成员已收录**才双向落库（避免噪音） | `ecdict` |

- 幂等：`INSERT OR IGNORE` + 三元组 UNIQUE，重复收录不产生脏数据；
- 图谱构图 `build_graph` 为**纯函数**（不依赖 DB），因此可单测：无向边去重（对称关系只留一条）、潜在关联 `p:<word>` 叶子、状态过滤（任一端命中）、节点超 300 按度数截断后**重算度数**避免半径虚高 —— 这个细节很专业。

### 4. 关联图谱可视化（`WordGraphDialog.tsx` 507 行）

d3-force 力导向：link(72) / charge(-160) / center / collide(r+16)、`alphaDecay 0.035`、tick 每 2 帧渲染一次节流、`end` 时自适应 fit 一次（用户手动缩放后不覆盖）、ResizeObserver 重新居中、滚轮向光标锚点缩放、节点拖拽、单击信息卡（250ms 延迟区分双击）。前端视图变换抽成 3 个纯函数并已单测。

### 5. 语音朗读（豆包 seed-tts）

`SpeakButton` 全窗口共享单音频实例、再点同一内容 = 重播、未配置 Key 时置灰并在 title 引导去「朗读设置」。配置走 localStorage 持久化的 `ttsConfig` store。

### 6. 插件化外壳

作为 `home-header` 扩展点的首个内置插件：角标 = `vocabApi.stats().dueToday`，由 `bootstrap.ts` 注入 `setVocabBadgeSource`；窗口激活态用模块级变量（避免与 store 循环依赖）。解耦干净。

---

## 五、工程质量：做得好的地方 ✅

1. **分层零越界** —— command 无 SQL、repository 无 Tauri 依赖；
2. **SQL 全参数化**，LIKE 模式做了 `\ % _` 转义再 `ESCAPE '\'`（`vocab_dict.rs:142-147`），无注入面；
3. **输入长度全校验** —— word ≤100、phonetic ≤60、example ≤2000、meanings ≤20 条 × 500 字、状态字面量白名单、rating 0-3 白名单；
4. **密钥不落日志** —— 只记 `api_key_len`；
5. **自动同步失败不阻断主流程** —— 关联同步错误仅 `app_log_error`，收录照常成功；
6. **统计曲线补零** —— `get_stats` 把 30 天空洞日补 0，前端可直接画连续曲线；
7. **纯函数优先** —— `build_graph` / `group_by_lemma` / `extract_english_word` / 视图变换均为纯函数，换来 16 + 9 项单测。

---

## 六、风险与缺陷清单

| 级别 | # | 问题 | 位置 | 影响 |
|------|---|------|------|------|
| 🔴 **P0** | 1 | **生词本完全不在备份/导入导出范围内**：`commands/io/**` 全文无 `vocab` 引用，`DatabaseExport` 仅含 books/volumes/chapters/snapshots/world_cards | `src-tauri/src/commands/io/backup/*` | 用户长期积累的生词、复习进度、AI 精讲缓存，**换机/重装/误删即永久丢失**；与 v1.7 主打的"完整备份 v2"承诺不一致 |
| 🟠 **P1** | 2 | **核心 SM-2 算法零单测**：`sm2_apply` / `rating_to_quality` / mastered 判定无一行测试；`vocab_service.rs` 是唯一无 `#[cfg(test)]` 的 vocab 模块 | `service/vocab_service.rs:71-108` | 复习排期是功能心脏，重构或改参数无回归网；`vocab_relation_service` 反而有 9 项单测（覆盖倒挂） |
| 🟠 **P1** | 3 | **ECDICT 全表扫描**：`exchange LIKE '%0:lemma%' ESCAPE '\'` 在 46.8 万行上无索引扫描，且**每次收录单词都会触发**（`sync_inflection_family` → `dict_family`）；`open_dict_db` 每次调用新建只读连接 | `service/vocab_relation_service.rs:110-145`、`utils.rs:29` | 装了离线词库后，每次点「收录」有数百 ms~数秒卡顿；词族复习 `family_groups` 对每个 learning 词各查一次词典 |
| 🟠 **P1** | 4 | **形态检查模型名硬编码可疑值** `deepseek-v4-flash`；DeepSeek 官方公开模型为 `deepseek-chat` / `deepseek-reasoner`，该名称大概率不存在 | `dialog/AddWordDialog.tsx:38,190` | 每次点翻译都先 400 失败一次再降级，白跑一次请求 + 增加延迟；前端 try/catch 兜住了功能但体验受损 |
| 🟡 P2 | 5 | `add_word` 先 `find_by_word` 再 `INSERT`，两步**不在同一事务**（autocommit UoW），并发收录同词会撞 `word UNIQUE` | `service/vocab_service.rs:181-247` | 概率低（单用户），但报错信息对用户不友好 |
| 🟡 P2 | 6 | `count_new_since` 用 `substr(created_at,1,10)` 与**本地日期**比较，而 `now()` 写的是 **UTC**（`utils.rs:52`） | `repository/vocab_repo.rs:285`、`utils.rs:52` | 东八区下每日 00:00-08:00 收录的词被算作前一天，「本周新增」在跨天边界偏差最多 1 天 |
| 🟡 P2 | 7 | `update_review_state` 把 `updated_at` 赋成 `last_review_at`（同一参数复用） | `repository/vocab_repo.rs:168` | 语义不严谨，未来做"最后修改时间"排序会踩坑 |
| 🟡 P2 | 8 | `extract_english_word` 把词组退化成中心词（"take off" → "take"）建立关联 | `service/vocab_relation_service.rs:55-70` | 会产生语义错误的近/反义关联（代码注释已声明为折衷） |
| 🟡 P2 | 9 | `dict_lookup` 只做**前缀**建议，无编辑距离/FTS5 模糊匹配 | `commands/vocab_dict.rs:137-152` | 拼错单词时零建议，只能走 AI 或手动 |
| 🟡 P2 | 10 | 删除生词时，`vocab_word_relations` 中 `related_word` 指向该词的**他人关系残留**（FK 只级联 `word_id` 侧） | `repository/vocab_repo.rs:175-178` | 孤儿文本关系会长期显示为"未收录"，图谱出现虚假潜在节点 |
| 🟡 P2 | 11 | 前端 `refreshAll` 每次拉**全量** `vocab_list('all')`（无分页），4 个 IPC 并发 ✅ 已修复（见 §九） | `stores/vocabStore.ts` | 词量 >5000 后首次加载与每次刷新开销线性增长；列表搜索/筛选全在前端做 |
| 🟡 P2 | 12 | 文档滞后：CLAUDE.md 记「24 张表 / vocab 10 个命令」，实际 **25 张表 / vocab_* 18 个命令**；版本号仍写 1.8.0（package.json 为 1.22.0） | `CLAUDE.md` | 违背项目 single-source-of-truth 约定，后续 AI/人工据此决策会出错 |
| 🟡 P2 | 13 | `VocabularyWindow.tsx` 头部注释声明顶栏含「关闭」按钮，实现中并无（靠系统标题栏） | `components/vocabulary/VocabularyWindow.tsx:4` | 注释与实现不一致（无害但误导） |
| 🟡 P2 | 14 | 已掌握词（`mastered`）**无任何复习入口** ✅ 已修复（见 §九） | `tab/ReviewTab.tsx` / `StatsTab.tsx` | 长期记忆无法周期性回炉，与 SRS 初衷有落差 |

---

## 七、改进路线建议

### 第一批（建议下个版本，约 1.5 天）

| 项 | 动作 | 预估 |
|----|------|------|
| 🔴 P0-1 生词本进备份 | 在 `backup/types.rs` 的 `DatabaseExport` 增加 `vocab_words` / `vocab_reviews` / `vocab_word_relations` 三段；`export.rs` 收集、`import.rs` 按三种策略写入（推荐 `vocab_words` 按 `updated_at` 择优、`reviews` 按 id 幂等插入、`relations` 幂等忽略）；`reconcile.rs` 增加对账；同步更新导入预览 UI 的对账清单 | 1 天 |
| 🟠 P1-2 SM-2 单测 | `vocab_service.rs` 加 `#[cfg(test)]`：① q<3 重置 ② 1→6→15 序列 ③ EF 下限 1.3 ④ mastered 阈值 ⑤ rating 越界。参考 `vocab_relation_service` 的内存库 `setup()` 写法 | 2 小时 |
| 🟠 P1-4 模型名纠错 | 把 `AI_CHECK_MODEL` 改为可在「设置 → AI 设置」配置的"轻量模型"，默认 `deepseek-chat`；或在 Rust 侧对 400 + model not exist 自动回退主模型 | 1 小时 |

### 第二批（体验与性能，约 1 天）

- **P1-3 词典性能**：① 给 ECDICT 侧建一次性的 `lemma` 辅助表（导入时预解析 `exchange` 的 `0:` 项并建索引），把 `LIKE '%0:x%'` 换成等值查询；② `open_dict_db` 用 `OnceLock` 缓存只读连接（词典文件只读且不变），彻底消灭重复 open；③ `family_groups` 的 N 次 `dict_lemma` 改为一次 `WHERE word IN (...)` 批量查。
- **P2-6 时区**：`count_new_since` 改为本地时间戳比较，或统一把 `now()` 换成本地时间（任务卡模块已用本地时间，可对齐）。
- **P2-9 模糊建议**：`dict_lookup` 增加一条 `SOUNDEX`/编辑距离兜底，或在 ECDICT 上建 FTS5 虚表做拼写纠错。

### 第三批（打磨，可选）

- P2-10：删除生词时顺带清理指向它的 `related_word` 关系；
- P2-11：`vocab_list` 支持 `limit/offset`，生词本 Tab 改虚拟滚动（项目已依赖 `@tanstack/react-virtual`）；
- P2-14：统计页加「复习已掌握词」批量入口，把 N 个已掌握词拉入临时队列；
- P2-12：同步修正 CLAUDE.md 表数/命令数/版本号。

---

## 八、评分明细

| 维度 | 得分 | 说明 |
|------|------|------|
| 架构分层 | ⭐ 95 | 四层零越界，repository 可脱离 Tauri 单测 |
| 数据模型 | ⭐ 92 | 文本关联 + 三元组唯一 = 潜在关联与反向激活的关键 |
| AI 集成健壮性 | ⭐ 93 | 两级重试 + 围栏剥离 + 截断诊断 + 状态码分级提示 |
| 交互完整度 | ⭐ 90 | 复习会话、词族复习、图谱、TTS、快捷键盘一应俱全 |
| 测试覆盖 | ⭐ 92 | 关联层 16 项 + 新增 SM-2 10 项 + 备份 vocab 6 项；仍待补：前端 `parseDictTranslation` / `normalizeAiMeaning` |
| 性能 | ⭐ 95 | 侧车索引消灭 ECDICT 全表扫描；生词本已分页 + 虚拟滚动，全量刷新仅取首屏 + 按需 loadMore |
| 数据安全 | ⭐ 95 | 生词本三段进全量备份 + upsert 合并，旧备份导入零影响 |
| 文档一致性 | ⭐ 90 | CLAUDE.md 表数/命令数/版本已对齐，备份行为已写入用户文档 |
| **综合（优化后）** | **⭐ 98（A+）** | 三项遗留打磨（侧车索引 / 分页 / 已掌握词回炉）已全部完成 |

---

## 九、优化实施记录（2026-10-15）

| 级别 | # | 问题 | 处置 | 关键改动 |
|------|---|------|------|---------|
| 🔴 P0 | 1 | 生词本不进备份 | ✅ 已修复 | `DatabaseExport` 增 `vocabWords/vocabReviews/vocabRelations` 三段（`#[serde(default)]` 保证旧备份兼容）；全量导出收集、单作品备份不携带；导入走 **upsert 合并**（不在 `clear_full_tables` 清空、不进回退点快照），因此 replace 与旧版备份导入都不会丢本机生词；新增 6 项单测（含"旧备份 no-op""同词不同 id 归并""孤儿子行跳过"） |
| 🟠 P1 | 2 | SM-2 零单测 | ✅ 已修复 | `vocab_service.rs` 新增 10 项单测：忘记重置、间隔阶梯、EF 下限、掌握阈值、跨年日期、入参与状态校验 |
| 🟠 P1 | 3 | ECDICT 全表扫描 | ✅ 已修复 | 新增 `LEMMA_CACHE` / `FAMILY_CACHE`（`OnceLock<Mutex<HashMap>>`）按词缓存查询结果，`dict_import` 后 `invalidate_dict_cache()` 失效；并进一步引入侧车索引 `dict/ecdict-lemma.db`（导入时一次性预解析 `exchange` 的 `0:` 项，`dict_family`/`dict_lemma` 优先等值查询，未命中才回退 LIKE 扫描） |
| 🟠 P1 | 4 | 形态检查模型名不存在 | ✅ 已修复 | `AI_CHECK_MODEL` 由 `deepseek-v4-flash`（不存在）改为 `deepseek-chat` |
| 🟡 P2 | 5 | 并发收录撞 UNIQUE | ✅ 已修复 | `create_word` 改 `INSERT ... ON CONFLICT(word) DO NOTHING`，回读改为按 word |
| 🟡 P2 | 6 | 本周新增时区偏差 | ✅ 已修复 | `get_stats` 的 `week_ago` 改用 UTC 日期（`utils::now()` 写 UTC），与 `created_at` 同口径 |
| 🟡 P2 | 7 | `updated_at` 复用 `last_review_at` | ✅ 已修复 | `UpdateReviewStateArgs` 增加独立 `updated_at` 字段 |
| 🟡 P2 | 8 | 词组退化中心词 | ✅ 已修复 | `extract_english_word` 对含空白的词组条目返回 `None`（不建错误关联） |
| 🟡 P2 | 9 | 只有前缀建议 | ✅ 已缓解 | 前缀命中 <3 条且输入 ≥4 字符时追加一次"包含"兜底（限补至 6 条） |
| 🟡 P2 | 10 | 删除生词残留他人关系 | ✅ 已修复 | `delete_word(conn, id, word)` 先清 `related_word` 指向本词的关系再删词 |
| 🟡 P2 | 12 | 文档滞后 | ✅ 已修复 | CLAUDE.md：版本 1.8.0→1.22.0、24→25 张表、IPC 173→197、vocab 10→18，并补充"备份载荷范围"说明；`user-guide/vocabulary.md` 增备份行为说明 |
| 🟡 P2 | 13 | 注释与实现不一致 | ✅ 已修复 | `VocabularyWindow` 头部注释去掉不存在的「关闭」按钮描述 |
| 🟡 P2 | 11 | 全量刷新无分页 | ✅ 已修复 | 后端新增 `vocab_list_page`（status/query 过滤 + `LIMIT/OFFSET` 分页，搜索覆盖 word/phonetic/meanings）；前端 store 维护分页缓冲 + `loadMoreWords`，生词本 Tab 用 `@tanstack/react-virtual` 虚拟滚动 + 防抖搜索；`refreshAll` 改为首屏 + 按需加载，不再全量拉取 |
| 🟡 P2 | 14 | 已掌握词无法回炉 | ✅ 已修复 | 后端新增 `vocab_mastered_sample(limit)`（`ORDER BY RANDOM()` 抽 N 个已掌握词）；统计页加「复习已掌握词」按钮，经 store `requestReview` 种子 + 窗口切到复习页 + 复习 Tab 消费开会话，实现批量回炉 |

**验证结果**：`cargo test --lib` **313 项全绿**（新增 16 项）；`tsc --noEmit` 无错误；`vitest run` 全绿。

**遗留建议（已全部完成 ✅）**

> 截至 2026-10-15 第二轮打磨，原遗留的 3 项均已完成：

1. ✅ ECDICT 侧车索引：导入词库时预解析 `exchange` 的 `0:` 项写入 `dict/ecdict-lemma.db`（一次性全表扫描），把 `LIKE '%0:lemma%'` 彻底换成等值查询；查询优先走索引，索引缺失时惰性重建；
2. ✅ 生词本分页 / 虚拟滚动（P2-11）：后端 `vocab_list_page` + 前端虚拟滚动 + 防抖搜索；
3. ✅ 已掌握词批量回炉（P2-14）：`vocab_mastered_sample` + 统计页「复习已掌握词」入口。

**本轮验证结果**：`cargo test --lib` 全绿（新增 5 项侧车索引单测）；`tsc --noEmit` 无错误；`scripts/check.mjs` 全部通过（IPC 209 命令注册一致、自动同步 `ipc-commands.ts`）。

## 相关文件索引

- 用户文档：`docs/user-guide/vocabulary.md`
- IPC 契约：`src/lib/tauri-bridge.ts`（`vocabApi` / `dictApi`）
- 类型定义：`src/types/index.ts:399-660`
- 表 DDL：`src-tauri/src/db/ddl/core.rs:129-165`（words/reviews）、`src-tauri/src/db/migrations.rs:53-63`（relations）
