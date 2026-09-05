# 导入导出规范（Import / Export Spec）

> **适用版本**：`1.6.0（本规范目标落地版本：1.7.0）`　|　**制定日期**：2026-09-05
>
> **定位**：导入导出子系统的**设计与实现标准**。开发按 [开发计划](development/import-export-plan) 分阶段落地；本文档与代码不一致处，以「目标规范」为准、在计划中标注迁移步骤。

---

## 一、能力范围与术语

| 术语 | 含义 |
|------|------|
| `.tw` 备份文件 | AES-256-GCM 加密的 TimeWrite 数据迁移文件（`.tw`） |
| 全量备份 / `full` | 导出全部书籍、卷、章节、快照、世界观卡片、embedding 元数据与前端缓存 |
| 单作品备份 / `single` | 仅导出指定作品及其关联数据 |
| 格式导出 | 将单本书按 TXT / Markdown / HTML 导出为纯文本可读文件 |
| TXT 导入 | 将 `.txt` 纯文本按章节分隔规则导入为目标书籍章节 |
| 导入日志 `import_log` | 本机幂等判定的运行态表（记录成功导入的载荷指纹） |
| 对账 | 导入前比对「备份内容」与「目标库现状」，产出差异清单 |

代码位置：

- 后端：`src-tauri/src/commands/io/`（`backup.rs` / `crypto.rs` / `export.rs` / `import_txt.rs` / `mod.rs`）
- 数据库：`src-tauri/src/db/`、模型：`src-tauri/src/models/`
- Repository：`src-tauri/src/repository/`（`book_repo` / `chapter_repo` / `volume_repo` / `snapshot_repo` / `world_card_repo` / `embedding_repo`）
- 前端桥接：`src/lib/tauri-bridge.ts`（`importExportApi`）
- 前端交互：`src/pages/LibraryPage.tsx`、`src/components/library/BookCard.tsx`、编辑器/书库页的格式导出入口

---

## 二、`.tw` 文件格式规范

### 2.1 现状（v1.x，兼容保留）

```
[2 bytes : u16 BE = prefix_block 长度]
[prefix_block : encrypt_bytes("TimeWrite")]     # 引导标识
[data_block   : encrypt_bytes(JSON 载荷)]       # 实际数据
```

- 加密：AES-256-GCM；nonce[12] + ciphertext + tag[16]，nonce 每次随机。
- 密钥来源优先级（见 `crypto.rs`）：环境变量 `TIMEWRITE_BACKUP_KEY`（SHA-256 派生）→ `<app_data_dir>/backup.key`（0600）→ 启动时生成。
- 校验链：长度 ≥ 4 → prefix_len ≥ 28 → 解密 prefix → 字符串必须等于 `TimeWrite` → 解密 data → UTF-8 → JSON。

### 2.2 目标格式（v2，向后兼容）

```
[2 bytes : u16 BE = magic_block 长度]
[magic_block : encrypt_bytes("TimeWrite\0\x02")]   # 含版本字节 \x02
[data_block  : encrypt_bytes(JSON 载荷)]           # 载荷内含 manifest（见 §3）
```

- 版本字节进入引导标识：`\x01` = v1（当前），`\x02` = v2。解析器先解密 magic，按版本分流；**v1 文件继续可读**，v2 文件在旧版本 App 中给出「文件版本过高，请升级 App」的明确提示（可辨识错误，而非笼统的损坏）。
- 新字段在载荷层演进（见 §3），不改变容器结构，避免格式升级复杂化。

### 2.3 文件命名规范

| 场景 | 规则 | 示例 |
|------|------|------|
| 全量导出默认名 | `TimeWrite-全量备份-{yyyy-MM-dd_HH-mm-ss}.tw` | `TimeWrite-全量备份-2026-09-05_14-30-00.tw` |
| 单作品导出默认名 | `TimeWrite-{书名}-{yyyy-MM-dd_HH-mm-ss}.tw` | `TimeWrite-长安十二时辰-2026-09-05_14-30-00.tw` |
| 格式导出默认名 | `{书名}.{ext}`（前端 save 对话框给定） | `长安十二时辰.md` |

时间戳一律 `yyyy-MM-dd_HH-mm-ss`（UTC+8 本地时间），仅用 `-` 与 `_`，避免 Windows 保留字符。

---

## 三、载荷 JSON Schema

### 3.1 v1 顶层结构（现状）

```jsonc
{
  "version": "1.0",           // 载荷 schema 版本（字符串）
  "exportedAt": "RFC3339",    // 导出时刻
  "backupType": "full" | "single",
  "database": {
    "books":      [Book],
    "volumes":    [Volume],
    "chapters":   [ChapterExport],   // 含 content_html
    "snapshots":  [Snapshot],
    "worldCards": [WorldCard],
    "embeddings": [EmbeddingMeta]    // 不含向量 BLOB，仅元数据（可重算）
  },
  "cache": { }                 // 前端 localStorage 快照，键值任意 JSON
}
```

**字段语义约定（现行代码已隐含，现显式成文）：**

- `books` / `volumes` / `chapters`：**包含软删数据**（`deleted_at` 非空的行也导出），保证备份可完整还原回收站；恢复后保持 `deleted_at` 标记。
- `chapters.content_html`：富文本原始 HTML（图片为 data URL 或 asset URL）。
- `embeddings`：仅 `sourceType` / `sourceId` / `model` / `createdAt`，向量不落盘（尺寸与模型相关，恢复后按需重建）。
- `cache`：由前端在导出时收集的 `localStorage` 键值（`time-write-ai-config`、`time-write-preferences`、`time-write-editor-state`、`time-write-ai-conversations`、`time-write-ai-summaries`、`time-write-ai-tool-categories` 等），后端仅透传，不做业务解释。

### 3.2 v2 目标结构（新增字段，老字段保留）

```jsonc
{
  "version": "2.0",
  "schemaVersion": 2,          // 与 version 对应的数值型，便于比较
  "exportedAt": "RFC3339",
  "backupType": "full" | "single",
  "appVersion": "1.7.0",       // 导出时的 App 版本，便于排障
  "payloadHash": "sha256-hex", // 见 §4.2
  "database": { /* 同 v1 */ },
  "cache": { }
}
```

### 3.3 必填字段与类型（校验基准）

| 位置 | 字段 | 类型/约束 |
|------|------|-----------|
| 顶层 | `version` | string，可解析数值 |
| 顶层 | `exportedAt` | string（RFC3339 或 ISO，宽松解析） |
| 顶层 | `backupType` | 枚举 `full` / `single` |
| 顶层 | `database` | object |
| `database` | `books`/`volumes`/`chapters`/`snapshots`/`worldCards`/`embeddings` | 数组（可为空） |
| `books[]` | `id` | string，非空，**库内唯一** |
| `chapters[]` | `id`、`bookId` | string，非空 |
| `chapters[]` | `volumeId` | string 或 null；若非空，须在 `volumes` 中存在 |
| `chapters[]` | `createdAt`/`updatedAt` | string，非空 |
| `snapshots[]` | `chapterId` | string，须在 `chapters` 中存在 |
| `worldCards[]` | `bookId` | string，须在 `books` 中存在 |
| `embeddings[]` | `sourceId` | string，须在 `chapters` 或 `worldCards` 中存在 |

> 上述「引用完整性」为**目标校验项**（当前代码仅做结构校验），见 §5.3 与计划 Phase B。

---

## 四、指纹与幂等

### 4.1 目标：无「静默重复导入」

重复导入的判定**只用于给出默认建议**，绝不替代校验，也绝不静默跳过：

1. 同一备份文件再次导入（迁移、误操作、系统恢复后重放）
2. 同一内容重新导出生成的新文件（`exportedAt` 不同）再导入
3. 跨设备迁移到一台**已含部分数据**的机器

### 4.2 `payloadHash` 计算规则

- 计算对象：**解密后**载荷的 `database` 部分，经**规范化序列化**后取 SHA-256。
- 规范化：`serde_json` 结构序（键序固定为序列化时的字段序），**排除** `exportedAt`、`cache`、`appVersion`、`backupType`（同一作品 full/single 不互相判重）。
- 原因：内容指纹必须对「解密失败/密文差异」免疫，且不随导出时刻与前端缓存变化；hash 相同 ⇒ 数据库部分逐字节等价。
- v1 旧文件无此字段 ⇒ 无幂等判定，按新备份处理（合并策略本身幂等，仍安全）。

### 4.3 `import_log` 表（运行态，新增）

```
import_log(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_hash  TEXT NOT NULL,
  file_name     TEXT NOT NULL,     -- 原始文件名
  backup_type   TEXT NOT NULL,     -- full / single
  source_size   INTEGER NOT NULL,  -- 文件字节数（辅助判定）
  imported_at   TEXT NOT NULL      -- RFC3339
);
CREATE INDEX idx_import_log_hash ON import_log(payload_hash);
```

- **只在导入事务成功提交后写入**；失败回滚绝不落 log（失败重试不被误判）。
- 仅保留最近 20 条（滚动清理），是运行态表：不参与备份、不随作品删除。
- 判定：`payloadHash` 命中 且 `source_size` 一致 ⇒ 疑似重复，进入 §5.5 对账。

---

## 五、导入流程规范（核心）

### 5.1 总原则：先校验 → 后判重 → 判重后仍对账

任何一条不通过都不进入写入。**重复命中永远不短路「文件级 → 解密 → schema/引用 → 幂等判定 → 对账」任一环节。**

```
① 文件级校验 → ② 解密校验 → ③ schema/引用校验 → ④ 幂等判定(查 import_log) → ⑤ 目标库对账 → 写入
```

### 5.2 分层校验明细

| 层 | 校验点 | 失败提示（用户可理解） |
|----|--------|------------------------|
| ① 文件级 | 非空、长度 ≥ 4、magic_block 长度合法 | 「不是有效的 TimeWrite 备份文件」 |
| ② 解密 | prefix 解密后字符串 = `TimeWrite[\x01\|x02]`；data 解密；UTF-8 | 「文件已损坏，或使用了不同密钥/口令」 |
| ③ schema | §3.3 全部必填与类型、`backupType`、数组字段 | 列明缺失字段名 |
| ③ 引用 | `volumeId`/`bookId`/`chapterId` 悬空引用、`books` 内重复 `id` | 精确到 id 的清单 |
| ④ 幂等 | `payloadHash` × `source_size` 查 `import_log` | 命中 ⇒ 进对账（非跳过） |
| ⑤ 对账 | 备份行 vs 目标库行（见 §5.5） | 差异清单，UI 呈现 |

### 5.3 单作品备份附加校验（现状保留并加强）

- `backupType == "single"` 且 `database.books` **恰好 1 本**（现状已实现）。
- 该校验在事务**开始前**完成（现状正确，写入不可回滚的文件解析错误）。

### 5.4 导入写入策略（策略参数化）

> 现状：`full` = 清空全库重建；`single` = 删除目标作品后重建。**不保留目标库新增数据**，是主要数据丢失风险，见计划 Phase A/B。

目标将写入行为参数化为 `strategy`，导入前由 UI 选择：

| 策略 | 行为 | 适用 |
|------|------|------|
| `replace` | （保留现状语义）full：清全库；single：删目标作品再写。**执行前必须先自动快照回退点**（见 §5.6） | 全新迁移、明确想整体还原 |
| `merge` | upsert：行 id 存在 ⇒ 按 updated_at 择优更新（备份新则覆盖，目标新则保留，内容回写差异）；不存在 ⇒ 插入。软删行恢复保留 `deleted_at` | 缺省建议，日常使用 |
| `fill-gaps` | 只补**目标库缺失**的行；已存在行一律不动 | 部分数据丢失后的补回 |
| `skip` | 不写入（对账为零差异时的默认出口之一） | 重复导入确认无变化 |

- `single` 备份的 `merge`：仅对备份中该 `book_id` 的行做 upsert，**不删除**目标库同作品的其它行。
- `fill-gaps` 与 `merge` 必须通过**同一事务**完成，失败整体回滚。

### 5.5 对账报告（导入预览的结果）

逐实体比对（books / volumes / chapters / snapshots / worldCards / embeddings 元数据）后输出：

```
ImportReport {
  matched:     n,   // 与目标库完全一致（updated_at + 内容指纹同）
  missing:     n,   // 备份有、目标库无 → 可补
  targetStale: n,   // 目标库比备份旧 → 以备份覆盖才更新
  targetNewer: n,   // 目标库比备份新 → 默认保留目标库
  deletedInBackup… // 软删标记差异（目标库已删、备份未删等）
}
```

- 快速预判：`id + updated_at` 比对；`updated_at` 相同仍以**内容短 hash** 复核，避免手工改时间戳的场景。
- 内容全文 diff 仅在被判「需覆盖」且用户确认后执行，成本可控。

### 5.6 回退点（导入不丢数据兜底）

- `replace` 策略执行前，先把目标受影响范围（full = 全库；single = 该书）在**同一 SQLite 内**另存为内部恢复表 `import_rollback_{ts}`，事务提交后保留 24 小时（或保留最近 1 份），成功且用户未回滚则清理。
- `merge` / `fill-gaps` 因不删数据，无需回退点（事务即兜底）。
- 提供 `rollback_import(ts)` 命令与 UI 入口（错误提示中直接给「回滚」按钮）。

### 5.7 导入结果（命令返回契约）

`import_backup` 返回结构扩展（向后兼容：`cache` / `backupType` 保留）：

```jsonc
{
  "cache": { },
  "backupType": "full" | "single",
  "report": {
    "status": "applied" | "skipped",
    "strategy": "merge",
    "matched": 0, "missing": 3, "targetStale": 0, "targetNewer": 0,
    "books": 1, "volumes": 2, "chapters": 30, "snapshots": 5,
    "worldCards": 4, "rollbackTs": null
  }
}
```

### 5.8 缓存（cache）恢复

- 缓存的恢复放在导入事务**成功后**由前端执行（现状位置不变）。
- **前端恢复失败（如 localStorage 超限）不得让导入流程整体报失败**：数据库已提交，缓存恢复失败仅降级提示「备份数据已恢复，但本地偏好/AI 会话等缓存恢复失败」。现状缺陷（DB 已成功却 alert「导入失败」）必须修复。
- cache 键仅接受白名单内已知键（与导出收集的 6 个键一致），未知键忽略。

---

## 六、TXT 导入规范

代码：`src-tauri/src/commands/io/import_txt.rs`；入口：书库/编辑器「导入 TXT」。

### 6.1 分章规则（v2 目标规则，替换现状单一正则）

章节标题行匹配（自左第一个非空匹配行），命中后其后续正文归入该章：

```
^[ \t　]*第[零一二三四五六七八九十百千两\d]+[章节卷回篇][^\n]*$
^[ \t　]*Chapter\s+\d+[^\n]*$          （大小写不敏感）
^[ \t　]*序章|楔子|尾声|后记|番外[^\n]*$
```

- **正文误判防护**：仅当「候选标题行后存在 ≥ N 行非空正文」才确认为章节标题，否则视为正文（可配置 N=1，防「文中引用『第一章』」误分）。
- 连续标题行之间无正文 ⇒ 不产生空章节。
- 无任何命中 ⇒ 整文件作为单章「全文」导入（现状行为保留）。
- 头部在第一个标题前的引言：作为独立「前言/引言」章（正文非空时），不丢弃（现状丢弃）。

### 6.2 段落与内容保真

- 分段：`\n` 或 `\r\n` 均为分段符；连续空行不产生空 `<p>`，折叠为段间距。
- HTML 转义：正文中的 `<` `>` `&` 需转义后包裹 `<p>`，防止 HTML 注入与渲染错乱（现状直接拼 HTML，属待修复项）。
- 每章字数 = 非空白字符计数（现状正确）；保留首行缩进原文，不做智能归并。

### 6.3 重复导入去重（TXT）

判定：章节标题 + 归一化正文（去空白）的短指纹 `(bookId, fingerprint)`，导入**前**与库内章节比对：

- 全文一致 ⇒ 跳过该章（返回 `skipped`），不产生重复。
- 目标库存在同名但内容不同 ⇒ 视为不同版本，**重命名**（`标题（导入 2）`）后追加，防止「更新版」被误跳。
- 导入本身幂等：同一文件重复导入第二次应报「全部跳过，共 N 章与已有内容一致」。

### 6.4 规模与事务

- 文件大小上限：**20 MB**（超出直接拒绝，提示拆分）。
- 章节数上限：单文件 **2,000 章**。
- 全部章节写入与 `recalc_word_count` 在同一事务（现状为逐条提交，中途失败会留半批数据，属待修复项）。
- 超大文件（> 2 MB）分块读入，避免一次性整文件进内存。

---

## 七、格式导出规范

代码：`src-tauri/src/commands/io/export.rs`（`export_book`）；调用：`tauri-bridge.importExportApi.exportBook`。

| 格式 | 规则 |
|------|------|
| TXT | 书名行 → `作者：X` → 每章 `\n\n标题\n\n正文(纯文本)`；正文去 HTML 标签（`strip_html`），保留段落空行 |
| Markdown | `# 书名` → `> 作者：X` → 每章 `## 标题` → 正文转 Markdown（加粗/斜体/列表尽量保真，由富文本 AST 转换而非标签剥离） |
| HTML | 独立 `<!DOCTYPE html>`，含样式；图片内联 data URL 或外链 asset |

目标增强项（计划 Phase E，当前缺口）：

1. **卷结构表达**：TXT/MD 中在卷首插入卷标题注释/标题（如 `==== 第一卷 春 ====` 或 `# 第一卷`），现仅导出扁平章节。
2. **编码**：一律 UTF-8 无 BOM；文件名合法化（去掉 `\/:*?"<>|`）。
3. **进度与取消**：大书导出经事件通道上报进度（`export-progress`），可取消（引入与 Agent CancelToken 相同模式的取消令牌）。
4. **HTML 图片**：data URL 图片过大时（单图 > 5 MB）在导出报告中提示，可选项为剥离为占位。

---

## 八、导出（备份）规范

### 8.1 导出内容边界

- full：全部行（含软删）；single：仅目标书关联行。
- 导出在**只读**下进行（现状查询委托 repo，正确）；不要求导出一致性快照的写锁——但若目标库「正在保存」与导出并发，允许读到一致的单行（SQLite WAL 语义），不做额外锁。
- `cache` 由前端收集后 JSON 序列化传入；键白名单 6 个（与 §5.8 一致）。

### 8.2 载荷大小与失败

- 序列化前估算：单文件上限 200 MB（超出拒绝并提示分书导出）。
- 写出到目标路径前先写临时文件 `.tw.tmp`，成功后 rename（避免中断留下半截文件）。

---

## 九、安全与规模边界

| 项 | 规则 |
|----|------|
| 密钥 | 环境变量 > `backup.key`（0600）> 生成；密钥永不出现在导出文件或错误信息中 |
| 算法 | AES-256-GCM，nonce 随机；算法与密钥**不应**写入文档错误串 |
| 读入上限 | 备份文件 ≤ 200 MB；导入行数校验：books ≤ 10,000 / volumes ≤ 50,000 / chapters ≤ 100,000（超限拒绝并明确报错） |
| 注入面 | TXT 导入正文 HTML 转义（§6.2）；cache 键白名单（§5.8）；`file_path` 仅来自系统对话框 |
| 事务 | 所有导入写入（backup / TXT / 合并）单事务原子提交，失败回滚并返回「已回滚，原数据未受影响」 |
| 幂等日志 | `import_log` 仅在提交成功后写入（§4.3） |
| 并发 | 导入/导出命令执行期间，前端禁用重复触发（现状 `isImporting`/`isExporting` 保留）；后端可再加命令级互斥标志防双窗口并发导入 |

---

## 十、错误码约定

后端错误信息现统一封装为 `AppError::Business(String)`，前端起 `alert(err)`。目标：引入稳定的**错误前缀协议**，便于前端归类展示与自动化测试：

```
E_BACKUP_FILE     文件级校验失败（非备份文件/长度异常）
E_BACKUP_KEY      解密失败（损坏或密钥不匹配）
E_BACKUP_SCHEMA   JSON/schema 校验失败（含缺字段明细）
E_BACKUP_VERSION  文件版本高于当前 App 支持版本
E_BACKUP_TYPE     备份类型不支持 / single 书籍数 ≠ 1
E_BACKUP_TOO_LARGE 超过大小/行数上限
E_TXT_TOO_LARGE   TXT 超过大小上限
E_TXT_NO_CHAPTERS 未识别出任何章节内容（空文件）
E_IMPORT_ROLLBACK 导入已回滚（附原始错误）
E_CACHE_RESTORE   数据已导入但缓存恢复失败（降级警告，非失败）
```

- 错误消息约定：`{E_CODE}：{人类可读描述}`，描述不允许携带密钥/完整明文内容。
- 计划 Phase F 统一实施，前端 `alert` 收敛为 toast/对话框组件。

---

## 十一、兼容性与迁移

| 场景 | 行为 |
|------|------|
| v1 `.tw` 文件导入 v2 App | 正常导入（解析分流 §2.2），无幂等判定但合并安全 |
| v2 `.tw` 文件导入 v1 App | 明确报 `E_BACKUP_VERSION`，不写任何数据 |
| 旧密钥文件 | `backup.key` 长度非 32 ⇒ 重建（现状）；环境变量变化不迁移旧文件，提示重新导出 |
| 软删数据 | 备份含软删行；恢复后维持 `deleted_at`；回收站 UI 不因导入出现不可删除行（按现状逻辑） |
| sqlite-vec | 导入后 `rebuild_chunks_vec` 保证 embedding 镜像与事实源对齐（`backup.rs` 中已有调用点，规范要求 merge/fill-gaps 路径同样触发） |

---

## 十二、UI 交互规范（目标）

### 12.1 导入预览对话框

选择 `.tw` 文件后（替代现状的单次 `confirm`）：

```
[检测到该备份曾于 2026-09-05 12:00 导入（hash xxxx…）]   ← 幂等提示，无则省略

对账结果：12 条一致 · 3 章在目标库缺失 · 2 条目标库更新

策略：○ 合并（推荐，保留两方新内容）  ○ 补回缺失   ○ 以备份为准整体覆盖
     [本机将保留 24h 回退点]（覆盖时显示）

[取消]  [开始导入]
```

- 前置预检命令 `inspect_backup(file_path)`：只读完成 ①~⑤，返回 `ImportReport` + 幂等提示 + 校验错误。`import_backup` 增加 `strategy` 参数。
- full 导入在 UI 始终高亮提示「将覆盖本机全部现有数据（回退点 24h）」。
- 导入成功后展示结果摘要（`report`），不再裸 `alert`。

### 12.2 进度

- 导入/格式导出：事件 `import-progress` / `export-progress`（阶段 + 行数），前端进度条。
- 备份大文件写入同样上报（估算字节）。

---

## 附：规范条目 ↔ 计划阶段映射

| 规范章节 | 计划阶段 |
|----------|----------|
| §2.2 / §3.2 / §4 / §5 | Phase A/B/C（导入内核与重复校验） |
| §6 | Phase D（TXT 导入增强） |
| §7 / §8 | Phase E（导出增强） |
| §9 / §10 / §12 | Phase F（安全、错误码、UX 收口） |
