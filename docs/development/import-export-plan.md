# 导入导出开发计划（Import / Export Plan）

> **适用版本**：`1.6.0`　|　**制定日期**：2026-09-05　|　**目标落地版本**：`1.7.0`
>
> **依据文档**：[导入导出规范](development/import-export-spec)（以下简称 Spec）。本计划的任务与验收标准均引用 Spec 章节，代码不一致处以 Spec 目标为准。

---

## 一、目标与范围

把「备份/恢复（`.tw`）+ TXT 导入 + 格式导出」升级为**安全、幂等、不丢数据、可预览**的子系统：

1. 导入不再破坏目标库新增数据（策略化：replace / merge / fill-gaps / skip）。
2. 重复导入必须校验：先完整校验 → 判重 → 判重后仍对账，绝不静默跳过或静默覆盖（Spec §4/§5）。
3. TXT 导入可去重、可保真、有边界（Spec §6）。
4. 导出增强卷结构表达、进度与取消（Spec §7）。
5. 统一错误码与 UI 交互（Spec §9/§10/§12）。

**不纳入本次范围**：EPUB / PDF 导出（沿用 roadmap Phase 3 计划）、跨账号云同步、多密钥口令 UI。

---

## 二、现状盘点（真实代码核对，2026-09-05）

### 2.1 已具备的基线

| 能力 | 代码 |
|------|------|
| AES-256-GCM 加密 `.tw`，密钥无硬编码、无密钥文件即生成 | `src-tauri/src/commands/io/crypto.rs` |
| 引导标识 + 长度头容器；解析失败逐层报错 | 同上（`parse_encrypted_file`） |
| 全量/单作品导出（含软删数据、embedding 元数据、cache 透传） | `src-tauri/src/commands/io/backup.rs`（`export_all_data` / `export_single_book`） |
| 统一导入自动识别 full/single，事务 + 回滚提示 | `backup.rs`（`import_backup`） |
| full/single 结构校验（字段存在性、类型、单书数量） | `backup.rs` + `crypto.rs::validate_payload_structure` |
| TXT 正则分章导入、字数重算 | `src-tauri/src/commands/io/import_txt.rs` |
| TXT/MD/HTML 格式导出 | `src-tauri/src/commands/io/export.rs` |
| 前端桥接与书库页导入导出入口（含防重复点击） | `src/lib/tauri-bridge.ts`、`src/pages/LibraryPage.tsx`、`src/components/library/BookCard.tsx` |
| vec0 镜像与事实源对齐（sqlite-vec 迁移后保留导入重建点） | `src-tauri/src/repository/embedding_repo.rs`、`backup.rs` |

### 2.2 核心缺陷与风险（按 Spec 归口）

| # | 缺陷 | 现状行为 | 风险等级 | Spec 归口 |
|---|------|----------|----------|-----------|
| G1 | full 导入 = 清空全库重建 | 两次导入间新增的书籍/章节会被**静默删除** | 🔴 P0 数据丢失 | §5.4 / §5.6 |
| G2 | single 导入 = 删除该书重建 | 目标库对同一作品的后续修改被覆盖丢弃 | 🔴 P0 数据丢失 | §5.4 |
| G3 | 无重复导入识别 | 同一 `.tw` 重导无法识别「已导入过」，对账缺失 | 🔴 P0 | §4 |
| G4 | 无引用完整性校验 | `volumeId`/`bookId`/`chapterId` 悬空、重复 id 直接入库 | 🟡 P1 | §3.3 / §5.2 |
| G5 | TXT 导入非事务、逐条提交 | 中途失败留半批章节 | 🟡 P1 | §6.4 |
| G6 | TXT 重复导入无去重 | 同一 TXT 导两次产生整份重复章节 | 🟡 P1 | §6.3 |
| G7 | TXT 正文未 HTML 转义直接拼接 | `<script>` 之类正文进入库中，渲染可注入 | 🔴 P0 | §6.2 |
| G8 | TXT 分章正则宽松 | 正文引用「第一章」行会误分章；开篇引言被丢弃 | 🟢 P2 | §6.1 |
| G9 | cache 恢复失败被当作导入失败 | DB 已提交但 localStorage 超限 → 前端 alert「导入失败」，状态与提示矛盾 | 🟡 P1 | §5.8 |
| G10 | 无回退点 | replace 语义下出错/误操作无法撤销 | 🟡 P1 | §5.6 |
| G11 | 无大小/行数上限 | 超大备份/超多行读入内存、超长事务 | 🟢 P2 | §9 |
| G12 | 错误均为裸字符串 | 前端无法归类，测试不可断言 | 🟢 P2 | §10 |
| G13 | 备份导入后未统一复核 embedding 镜像 | merge/fill-gaps 新路径若不触发重建会失同步 | 🟡 P1 | §11（迁移表） |
| G14 | 格式导出丢卷结构、无进度取消 | TXT/MD 仅扁平章节；大书导出无进度 | 🟢 P2 | §7 |
| G15 | `.tw` 容器无版本号 | 格式演进无解（只能靠载荷报错） | 🟢 P3 | §2.2 |
| G16 | 前端无预检/策略选择 | 导入前仅一次 confirm，无法预览差异与选策略 | 🟡 P1 | §12.1 |

---

## 三、分阶段实施计划

> 依赖顺序：A → B → C 必须串行；D / E 可与 C 并行；F 最后收口。
> 每个 Phase 结束需跑通对应验收标准（见每阶段末）并过 `cargo test` + `pnpm typecheck`。

### Phase A — 导入安全底线（防丢数据优先）　**✅ 已实施（2026-09-05）**

> **落地说明**：回退点快照采用事务内 `CREATE TABLE AS SELECT` 克隆表（元信息落 `import_rollback_log`，24h TTL，启动与导入成功后清理），命令 `rollback_import(ts)` 已注册；文件/行数上限在事务前拒绝；前端 cache 白名单 + 容错降级 + 撤销入口（`rollbackTs` → confirm → `rollbackImport`）已完成；TXT 正文逐行 `escape_html`（新增 `utils::escape_html`）。验证：`cargo test commands::io::backup` 4 项通过、`cargo check --all-targets` / `tsc --noEmit` / `pnpm check --fast`（199 项）全绿。手工矩阵待 `pnpm tauri dev` 回归。

**目标**：在改动合并逻辑之前，先消除「导入即删」的不可逆风险。

任务：

1. 新增自动回退点：`replace` 路径（`run_full_import` / `run_single_import` 所在事务前）将受影响范围写入内部表 `import_rollback_*`，提供 `rollback_import(ts)` 命令；提交后保留 24h（Spec §5.6）。
   - 文件：`src-tauri/src/commands/io/backup.rs`、`src-tauri/src/repository/`（新 `import_rollback_repo.rs` 或并入 backup）、`src-tauri/src/db/mod.rs`（表结构，运行态）
2. 规模上限：文件 ≤ 200 MB、行数上限（books ≤ 10,000 / volumes ≤ 50,000 / chapters ≤ 100,000），超限返回 `E_BACKUP_TOO_LARGE`（Spec §9）。
3. G9：前端 cache 恢复包独立 try/catch，失败降级警告不打断成功提示；未知 cache 键忽略。
   - 文件：`src/pages/LibraryPage.tsx`（`handleImportBackup`）
4. G7：TXT 正文 HTML 转义后分段。
   - 文件：`src-tauri/src/commands/io/import_txt.rs`

**验收**：
- 全量备份导入后误删数据可通过 UI「回滚」恢复（24h 内），`rollback_import` 冒烟测试通过。
- 200 MB+ 备份、超行数备份被明确拒绝且零写入。
- 手工向备份 cache 塞未知键与超大值：导入成功提示正常，未知键未写入 localStorage。
- TXT 含 `<b>` 原文导入后以纯文本显示，无 HTML 注入。

### Phase B — 导入内核：引用校验 + 事务化 + 策略写入　**✅ 已实施（2026-09-05）**

> **落地说明**：新增只读命令 `inspect_backup`（文件级 → 解密 → 结构 → 行数 → 引用完整性 → 规模摘要，幂等/对账报告字段随 Phase C `import_log` 追加）；`import_backup` 增加可选 `strategy` 参数（`replace` 默认 / `merge` / `fill-gaps`）；引用校验 `validate_references` 收集悬空 `bookId`/`volumeId`/`chapterId`/向量源与重复 id，错误精确到 id（`E_BACKUP_REFERENCE`，零写入拒绝）；非破坏性写入器 `apply_upsert_data`（merge 按 `updated_at` 择优、volumes/snapshots 存在即保留、fill-gaps 仅补缺、向量元数据忽略并保留本机索引），单事务 + 失败整体回滚，提交后三条路径统一触发 `rebuild_chunks_vec`；前端 `ImportStrategy`/`ImportWriteStats`/`BackupInspectReport` 类型与 `inspectBackup` 桥接、merge 结果统计摘要展示。验证：`cargo test`（backup 模块 9 项全绿：4 项引用/策略新用例 + Phase A 4 项 + 既有 1 项）、`cargo check --all-targets`、`tsc --noEmit`、`pnpm check --fast` 全绿。手工回归待 `pnpm tauri dev`。

任务：

1. 解耦「校验」与「写入」：抽出 `inspect_backup`（只读：文件级 → 解密 → schema → 引用完整性 → 幂等 → 对账），返回 `ImportReport`；`import_backup` 增加 `strategy` 参数（Spec §5.5 / §5.7 / §12.1）。
   - 文件：`backup.rs`（新增 `inspect` 与报告结构）、`lib.rs`（命令注册）
2. 引用完整性校验：`volumeId`/`bookId`/`chapterId` 悬空引用、books 内重复 id、snapshots.chapterId 存在性（Spec §3.3），产出精确到 id 的报错。
   - 文件：`backup.rs` 新增 `validate_references`；复用 `validate_payload_structure`
3. 策略写入 `merge` / `fill-gaps`：
   - 抽取统一的「逐表 upsert」写入器（与 `write_backup_data` 共存或替换），upsert 判定：id 存在 → `updated_at` 择优 → 覆盖则全字段更新（含内容），否则保留目标行（Spec §5.4）。
   - `fill-gaps`：仅插入目标库缺失行。
   - 均单事务；single 的 merge 不删目标书其它行。
   - 文件：`backup.rs`（`merge_backup_data` / `fill_gaps_backup_data`）、必要时 `src-tauri/src/repository/` 增加按 id upsert 的 repo 函数
4. vec0 镜像：merge / fill-gaps / replace 三条路径提交后统一触发 `rebuild_chunks_vec` 或增量同步（Spec §11，G13）。
   - 文件：`backup.rs` 提交点、`src-tauri/src/repository/embedding_repo.rs`
5. 导入回滚报告与前端绑定（`report.status`、`rollbackTs`）。
   - 文件：`src/lib/tauri-bridge.ts`、`src/pages/LibraryPage.tsx`

**验收**：
- 备份含悬空 `volumeId` → 导入被拒，错误清单精确到 id；目标库零变化。
- 目标库存在更新的章节时执行 `merge` → 保留目标库新版；执行 `replace` → 以备份为准且可回滚。
- `fill-gaps` 只补缺失，不触碰已有行（用行数差异断言）。
- single 备份 merge 到「目标库该书已有新增章节」的书 → 备份章节补齐，新增章节保留。
- 导入后 `chunks_vec` 行数与 `embeddings` 一致（现有 smoke test 扩展）。

### Phase C — 重复导入校验与对账（Spec §4/§5.5）　**✅ 已实施（2026-09-05）**

**目标**：重复导入必须完整校验 + 对账后给用户明确选择，绝不静默。

> **落地说明**：v2 载荷写入（version 2.0 + schemaVersion/appVersion + payloadHash，Phase E 任务 5 的载荷部分同步完成）；载荷指纹 `database_canonical_hash` = database 规范化 JSON 的 SHA-256（`serde_json::to_vec` 固定字段序，导入/导出双侧字节一致），`verified_payload_hash` 拒绝声明与内容不符的篡改文件（E_BACKUP_SCHEMA，零写入）；`db/mod.rs` 运行态新增 `import_log` 表（payload_hash/file_name/backup_type/source_size/imported_at，滚动保留最近 20 条），仅在导入事务**成功提交后**写入、v1 旧文件不写；`inspect_backup` 返回 `payloadHash`/`duplicateOf`（hash+类型+文件大小三条件命中）/逐表 `reconcile`；对账 `reconcile_*` 按 id+updated_at+内容指纹分类 matched/missing/targetStale/targetNewer（无内容时钟的卷/快照以指纹比对，冲突默认归 targetNewer=保留目标，与 merge 语义一致）；前端新组件 `ImportPreviewDialog.tsx`（概况/幂等提示/校验问题阻断/对账清单/策略单选，replace 覆盖时提示 24h 回退点），`LibraryPage` 导入流程改为「选文件 → inspect 预览 → 确认策略导入」。验证：`cargo test commands::io::backup` 13 项全绿（新增 payloadHash 规范化与篡改拒绝、import_log 记录/查询/滚动清理、对账跨表分类、同内容二次导入全 matched）、`cargo check --all-targets`、`tsc --noEmit`、`pnpm check --fast` 全绿。

任务：

1. 新增 `import_log` 表（Spec §4.3）与 `payloadHash` 计算：
   - `payloadHash = SHA-256(规范化 database JSON)`，排除 `exportedAt` / `cache` / `backupType`（Spec §4.2）。
   - 文件：`src-tauri/src/commands/io/crypto.rs`（规范化序列化工具）、`db/mod.rs`（建表，运行态）、`backup.rs` 导入提交成功后写入 log、导出时写入 `payloadHash`（v2 载荷，Spec §3.2）
2. 幂等判定接入 `inspect_backup`：命中（hash + source_size）→ `ImportReport` 附 `duplicateOf { importedAt, fileName }`。
3. 对账实现：`id + updated_at + 内容短 hash` 快速预判，产出 `matched / missing / targetStale / targetNewer`（Spec §5.5）。
   - 文件：`backup.rs`（`reconcile_*` 系列，按表逐一比对；查库用 repo 只读函数）
4. UI：导入预览对话框（Spec §12.1）——幂等提示 + 对账清单 + 策略单选 + 覆盖时的回退点提示；`inspect_backup` 先行调用，`import_backup(strategy)` 在确认后调用。
   - 文件：`src/pages/LibraryPage.tsx` 或新组件 `src/components/library/ImportPreviewDialog.tsx`、`tauri-bridge.ts`
5. 边界：v1 旧文件无 hash → 不判重但照常对账；同一备份覆盖导入后再次 inspect 应显示「全部 matched / 建议 skip」；hash 相同但文件被篡改（密文变 → 解密失败或 hash 变）不会被误判为重复（Spec §4.2）。

**验收**（含用户重点强调的「重复导入也要做校验」）：
- 同一 `.tw` 连续导入两次：第二次 inspect 报告全部 matched、提示「曾于 xx 导入」；选择 skip 后数据库行数与文件数**零变化**。
- 导入后手动删除 1 章再 inspect 同一备份：报告 missing=1；`fill-gaps` 补回该章成功。
- 目标库某章比备份新：报告 targetNewer=1；默认 merge 保留目标库新内容。
- 导入成功后 `import_log` 恰好 1 条；失败（损坏文件/引用校验不过）时 `import_log` 零新增。
- 篡改备份文件 1 字节 → 解密报错（`E_BACKUP_KEY` 类），不触发任何写入与 log。

### Phase D — TXT 导入增强（可与 C 并行）　**✅ 已实施（2026-09-05）**

> **落地说明**：`import_txt.rs` 按 Spec §6 重写——①分章规则行级化：中文「第X章（回/卷/篇）」/ Chapter（不区分大小写）/ 序章楔子尾声后记番外，标题须「后续 ≥ 1 非空行」才成立（防文中引用误判），开篇引言保留为独立「前言」章，孤立结尾标题按正文处理、连续标题间无正文不产生空章；②段落折叠：空行不产生空 `<p>`、正文逐行 HTML 转义；③去重（Spec §6.3）：以「书名 + 正文指纹」对照库内章节，全文一致跳过、同名不同文追加「（导入 N）」，同一 TXT 二次导入全跳过；④单事务写入（分章 + `recalc_word_count` 原子提交），`sort_order` 从库内 MAX 续接避免覆盖既有章节排序；⑤规模：≤ 20 MB（E_TXT_TOO_LARGE）/ ≤ 2,000 章 / 空文件 E_TXT_NO_CHAPTERS，按行流式读取（BufReader，> 2 MB 不一次性整文件入内存）；⑥返回值扩展 `{ chaptersCreated, chaptersSkipped, chaptersRenamed }`（tauri-bridge 类型同步）。验证：`cargo test commands::io::import_txt` 9 项全绿。

任务（全部落点 `src-tauri/src/commands/io/import_txt.rs`）：

1. 分章规则升级（Spec §6.1）：中文章节词扩展 + 正文误判防护 + 开篇引言保留。
2. 重复去重与幂等（Spec §6.3）：`(bookId, 标题, 正文指纹)` 预比对 → 全文一致跳过 / 同名不同文重命名追加。
3. 段落折叠与空行处理（Spec §6.2）。
4. 事务化整批写入 + `recalc_word_count` 同事务（Spec §6.4，G5）。
5. 规模上限：20 MB / 2,000 章，超限 `E_TXT_TOO_LARGE`；> 2 MB 分块读入。
6. 返回值扩展：`{ chaptersCreated, chaptersSkipped, chaptersRenamed }`，前端据此提示去重结果。
   - 文件：`src/lib/tauri-bridge.ts`、书库/编辑器导入入口提示

**验收**：
- 同一 TXT 导入两次：第二次 `chaptersSkipped = N`，库内无重复章节。
- 正文含「第一章（引用语）」且后续正文 < 1 行时不误分章。
- 含 `<`/`>` 的正文以纯文本入库并正确渲染。
- 导入中途断电/异常（注入失败点）→ 全量回滚，库内无半批章节。
- 20 MB+ TXT 被拒绝；> 2,000 章拒绝。

### Phase E — 导出增强（可与 C 并行）　**✅ 已实施（2026-09-05）**

> **落地说明**：任务 5（v2 载荷）随 Phase C 完成；其余于本次落地——`chapter_repo::list_export_with_volume` 带卷导出查询（LEFT JOIN volumes，无卷章节在前，卷/章序排列）；`export_book` 重写为逐章流式写出临时文件 `*.tmp` + rename 原子替换（不产生半成品），TXT 卷标题行 `==== 卷名 ====`、MD `# 卷名`、HTML `<h3>`（HTML 卷标题转义）；进度事件 `export-progress`（phase/done/total，每 25 章节流）+ 进程级取消令牌：新命令 `cancel_book_export`（幂等），取消即清临时文件并返回 `E_EXPORT_CANCELED`；桥接层新增 `ExportProgress` 类型与 `cancelBookExport`；备份写出同做原子化：`build_and_write_payload` 先写 `.tw.tmp` 再 rename，序列化后估算 > 200 MB 直接拒绝（E_BACKUP_TOO_LARGE，提示分书导出）。验证：`cargo test commands::io::export` 4 项全绿（卷标题 txt/md/html、卷只出现一次且顺序正确、文档框架无 BOM、取消令牌生命周期）、`commands::io` 共 26 项全绿、`cargo check --all-targets` / `tsc --noEmit` / `pnpm check --fast` 通过。HTML 图片超大提示（Spec §7 第 4 项）与 Markdown 富文本 AST 保真属后续（当前沿用 strip_html）。

任务：

1. 卷结构表达（Spec §7）：TXT/MD 卷标题行；由 `list_titles_and_content` 扩展为带回卷信息的导出查询。
   - 文件：`export.rs`、`src-tauri/src/repository/chapter_repo.rs`（新只读函数或复用现有）
2. 文件名合法化与编码固定 UTF-8（Spec §7）；前端默认名已符合 §2.3，补后端兜底清洗。
3. 导出进度与取消：`export-progress` / `export_book` 携带 CancelToken 模式。
   - 文件：`export.rs`、`src-tauri/src/lib.rs`（事件）、`tauri-bridge.ts`、书库导出入口进度态
4. 备份写出原子化：`.tw.tmp` 成功后 rename（Spec §8.2）；导出载荷 200 MB 上限。
   - 文件：`backup.rs`（`build_and_write_payload`）
5. v2 载荷：导出端写入 `payloadHash` / `schemaVersion` / `appVersion`（Spec §3.2），与 Phase C 后端读取对接。

**验收**：
- TXT/MD 导出含卷标题分隔，卷归属正确（每章能对应其卷）。
- 含非法文件名符号的书名导出：默认名不含 `\/:*?"<>|`。
- 大书导出出现进度事件并可在中途取消，取消后不产生半成品文件。
- 全量备份导出文件为合法 v2 载荷（`payloadHash` 存在且与库内容匹配）。

### Phase F — 安全、错误码与 UX 收口　**🟡 部分落地（2026-09-05，余项见下）**

> **已落地**：任务 3（命令级互斥——`commands/io/mod.rs` 原子锁 `E_IO_BUSY`，双窗口防重，RAII 释放，已接入备份导入/导出/回滚、TXT 导入、格式导出；`inspect_backup` 只读不占用）；任务 1 完整（`error.rs` 演进为 `{ code, message }` 结构化序列化，`code()` 优先提取消息内 `E_` 前缀、无前缀按变体归默认码；io 目录 40+ 内部错误按表补全 `E_BACKUP_SERIALIZE/CACHE/WRITE/READ/FILE/TYPE/TXN/ROLLBACK/REFERENCE/SCHEMA`、`E_TXT_READ/TXN/QUERY/COMMIT/TOO_LARGE/NO_CHAPTERS`、`E_EXPORT_WRITE/CANCELED/FORMAT` 等前缀；错误消息不含密钥/全文内容；新增 3 项协议单测）；任务 2 完整（前端新增 `src/lib/errors.ts`——`parseError / errText / adviceFor / showError` 统一解析对象/字符串/Error，toast 扩展动作按钮（`toast.action` + `ToastContainer` 渲染，`shell:allow-open` 已配），导入导出及其余 18 处 `alert` 全量收敛为 toast，后端错误对象化连带 60+ 处错误呈现升级 `errText` 防 `[object Object]`，`E_BACKUP_VERSION` 等按 code 建议动作并附「前往更新」跳 GitHub Releases）；任务 4 结论（当前容器无版本 magic 字节，v2 以 JSON 内 `version: "2.0"` 表达且保留 v1 字段 → 旧 App 可安全读入新文件，无需 magic 分流；「旧 App 读 v2 提示」属旧版本发布侧变更，不在本仓库代码范围）；任务 5 部分（CHANGELOG v1.6.1 条目已写）。验证：`cargo test` 32 项 + doctest 全绿、`cargo check --all-targets` 零警告、`tsc --noEmit` / `pnpm check --fast` 全绿。
>
> **余项**：③ 文档同步 `docs/user-guide/import-export.md`（用户视角，待 UI 入口全貌稳定后统一编写）与 Spec 「已落地」标记逐条核对、Spec §10 码表登记；④ UI 手工回归矩阵（§11 v1/v2 互导等）。

任务：

1. 错误码协议落地（Spec §10）：`AppError` 增加 `code` 字段（或 `E_` 前缀约定），后端全部导入导出错误按表归类；消息中不出现密钥/全文内容。
   - 文件：`src-tauri/src/error.rs`、`commands/io/*`
2. 前端错误呈现收敛：`alert`/`console` 统一为 toast/对话框（导入导出路径），按 code 显示建议动作（如「文件版本过高，请升级 App」→ 打开更新页）。
3. 导入/导出命令互斥：后端命令级原子锁，双窗口防重（Spec §9 并发）。
4. v2 容器与向后兼容回归（Spec §2.2 / §11）：magic 版本字节 `\x01/\x02` 分流；旧 App 读 v2 文件给出明确提示（此条依赖 Phase E 先产出 v2 文件后再实现读取分流——**顺序：E 写 → F 读**，或合并到一个 Phase 完成）。
5. 文档同步：更新 `docs/user-guide/import-export.md`（用户视角）、`docs/CHANGELOG.md`、Spec 中「已落地」标记。

**验收**：
- 所有导入导出错误路径返回 `E_` 前缀 code；前端对 `E_BACKUP_VERSION` 等做专项提示。
- 并发触发两次导入：仅一次生效，第二次立即返回冲突提示。
- v1 与 v2 文件互导矩阵（§11）在 UI 手工回归通过。

---

## 四、整体验收矩阵（发布前）

| 场景 | 期望 |
|------|------|
| 全新机器 full 导入 | 数据完整（含软删），可打开书、目录/世界观/版本正常 |
| 含数据机器 full 导入（merge） | 两库按 updated_at 择优合并，新增内容不丢 |
| 含数据机器 full 导入（replace） | 全量覆盖，24h 内可回滚 |
| 同一备份重复导入 | 完整校验 + 对账，默认 skip；删数据后重导可补缺 |
| 损坏 / 密钥不符 / 版本过高文件 | 各自明确报错，零写入、无 import_log 污染 |
| TXT 重复导入 | 去重跳过；更新版重命名追加 |
| TXT 含特殊字符 / 空文件 / 超大文件 | 转义正确 / 明确报错 / 明确拒绝 |
| 单书备份导入到已有该书数据 | 可合并保留新增，可替换 + 回滚 |
| 导出大书 | 进度可见、可取消、无半成品文件 |
| 缓存恢复 | 数据库成功提示与缓存降级提示分离，无「假失败」 |

---

## 五、风险与对策

| 风险 | 对策 |
|------|------|
| merge 的 updated_at 择优对「手工改时间戳」失效 | 内容短 hash 复核（Spec §5.5） |
| 回退点占空间/泄露旧数据 | 24h 自动清理、内容与主库同库受同权限保护、不随备份导出 |
| 对账在全量库上慢 | 按表分批 + `updated_at` 索引；预览默认只查行级摘要，全文 diff 延后 |
| import_log 误判（导出时刻不同但内容同） | payloadHash 排除时间戳/cache，保证语义「内容指纹」（Spec §4.2） |
| 旧 App 读新文件 | v2 解析分流 + 明确升级提示（§2.2），禁止静默降级读取 |
| TXT 误分章引发大量脏章 | 误判防护 + 去重指纹 + 分章前预览（Phase D 追加一个「预览前 N 章标题」提示） |
| 代码量大、回归面广 | 严格按 Phase 顺序 + 每个阶段独立验收项 + 冒烟测试扩展；导入内核优先以「纯函数」组织便于单测 |

---

## 六、测试策略

- 后端：在 `backup.rs` / `crypto.rs` 内嵌 `#[cfg(test)]` 冒烟（延续 sqlite-vec smoke 风格）：加密往返、v1/v2 magic 分流、引用校验命中、merge 择优、fill-gaps、import_log 成功/失败语义、TXT 去重与转义。
- 前端：`tauri-bridge.ts` 契约类型单测（返回结构）、ImportPreviewDialog 状态单测（Vitest 现有配置沿用）。
- 手工回归：§四 矩阵逐行执行，记录于版本发布检查单。

---

## 附：改动文件清单（预估）

**后端**：`src-tauri/src/commands/io/backup.rs`、`crypto.rs`、`export.rs`、`import_txt.rs`、`mod.rs`、`src-tauri/src/commands/io/` 下新增（如 `inspect.rs` 视组织而定）、`src-tauri/src/error.rs`、`src-tauri/src/db/mod.rs`、`src-tauri/src/repository/embedding_repo.rs`（及新增 repo 函数）、`src-tauri/src/lib.rs`（命令注册/事件/启动建表）。

**前端**：`src/lib/tauri-bridge.ts`、`src/pages/LibraryPage.tsx`、`src/components/library/BookCard.tsx`、新增 `src/components/library/ImportPreviewDialog.tsx`、书库/编辑器 TXT 导入提示、进度 toast 组件复用现有 UI 基建。

**文档**：`docs/user-guide/import-export.md`、`docs/CHANGELOG.md`、本计划与 Spec 的状态标记更新。
