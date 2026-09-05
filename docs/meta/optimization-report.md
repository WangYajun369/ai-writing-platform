# TimeWrite（智写时光）深度优化分析报告

> **适用版本**：`1.0.0`　|　**分析日期**：2026-06-XX　|　**状态复核**：2026-09-02（v1.2）
>
> **分析范围**：全部代码（排除 `docs/` 和 `product/`），涵盖 Rust 后端 42 个 `.rs` 文件、React 前端 65+ 个 `.tsx`/`.ts` 文件、配置与构建系统。

---

## 处理状态图例

| 标记 | 含义 |
|------|------|
| ✅ **已修复** | 代码中已落实，可在对应文件验证 |
| 🟡 **部分修复** | 已采取缓解措施但未彻底解决 |
| ❌ **未修复** | 代码中仍存在，附可验证的文件位置 |
| ⚪ **待确认** | 需人工复核代码细节 |

> 本报告原为一次性分析产物，现纳入文档体系并持续复核。**已知 P0 安全问题（问题 7/8/9/10/11）截至 v1.0.0 仍未修复**，见 [CHANGELOG 已知问题](CHANGELOG)。
>
> **v1.2 复核更新（2026-09-02）**：Agent 已迁移为 Rust 原生引擎。涉及 Python Agent /
> tiny_http Bridge / 端口 9876/9877 的条目（问题 27/28/30 等）已随迁移**整体解决**，
> 正文中对应「未修复/待处理」状态以本注记为准（保留原文作为历史记录）。
>
> **v1.5.0 复核更新（2026-09-05）**：数据一致性收尾 —— **问题 1**（写操作事务保护）与
> **问题 21**（构建命令 npm → pnpm）已**全部解决**，正文对应状态与 Phase 2 路线图已同步更新。
>
> **2026-09-05 复核更新（sqlite-vec 落地）**：**问题 13**（向量全量加载内存爆炸）已通过
> sqlite-vec vec0 KNN 镜像彻底解决（SQLite 内检索，O(k) 内存），正文问题 13、P1 汇总清单
> 与 Phase 2/4 路线图已同步更新。
>
> **2026-09-05 复核更新（Phase 2 收口）**：**问题 27**（Bridge 9876 无鉴权）复核确认已随 v1.1
> Rust 原生引擎迁移**整体删除**（src-tauri 无任何 TcpListener/HTTP server 残留，仅存注释）；
> **问题 28**（skills/cancel 占位）已实现 `CancelToken` 即时中断（AtomicBool + tokio::Notify +
> tokio::select!，SSE 读取与 HTTP 发送均可即时打断，取消不再补发 done）。**Phase 2 全部关闭**，
> 正文与矩阵状态已同步。

---

## 一、总体评价

### 优点

- **清晰的三层架构**（Commands → Service → Repository），职责分明
- **良好的类型安全** — TypeScript `strict: true`，Rust 强类型 + 统一 Serde camelCase
- **双状态管理策略**（Zustand 持久业务 + Jotai 瞬时 UI），分工合理
- **IPC 桥接层**统一封装所有 `invoke` 调用，禁止散落使用
- **FTS5 + 向量搜索**双轨检索，灵活适配
- **自动迁移策略**考虑增量升级

### 核心短板

- **数据一致性**：多个写操作缺少事务保护
- **安全漏洞**（v1.0.1 已修复 5/6）：硬编码加密密钥 ✅、CSP 策略过宽 ✅、更新签名未配置 ✅、`withGlobalTauri` ✅、fs 权限无作用域 ✅；剩余 Bridge Server 无鉴权（问题 27）
- **代码重复**：动态 SQL 构建、FTS5 模式多处实现

---

## 二、架构层面优化建议

### A. 数据一致性 — 🔴 高优先级

#### 问题 1：`save_chapter` 等写操作无事务保护

```rust
// 当前 chapter_service.rs 中的 save_chapter：
chapter_repo::save_content(conn, chapter_id, content_html, word_count)?;
book_repo::update_word_count_by_chapter(conn, book_id, word_count_delta)?;
let book_wc = book_repo::word_count_by_chapter(conn, book_id)?;
```

三步操作不在同一事务中。如果 `update_word_count` 失败，`save_content` 已提交（rusqlite 默认自动提交），导致章节字数与书籍总字数不一致。

**影响范围：**

- `save_chapter`
- `delete_chapter`（soft_delete + update_word_count）
- `restore_chapter`
- `hard_delete_chapter`
- `restore_snapshot`

> **状态**：✅ 已修复（2026-09-05，v1.5.0 复核）。影响范围内全部多步写路径已事务化：
> - `chapter_service.rs`：`save_chapter` / `delete_chapter` / `restore_chapter` / `hard_delete_chapter` 均在**同一事务**内完成（保存/软删/恢复 + 字数聚合 → 原子提交，任一步失败自动回滚）
> - `volume_service.rs`：`delete_volume`（repo 层 `soft_delete` 已内置 `BEGIN IMMEDIATE/COMMIT/ROLLBACK` 显式事务）、`hard_delete_volume`（service 层 `conn.transaction()` 包装）
> - `snapshot_service.rs`：`restore_snapshot` 事务化（快照内容回写 + 字数重算原子提交，窗口刷新事件移至提交成功之后）
> - `book_service.rs`：`hard_delete_book` / `clear_book_trash` 事务化（级联删除/清空 + 孤立 embedding 清理原子提交）
> - `world_card_service.rs`：复核结论为**无需事务** —— 三个写操作（insert/update/delete）均为单条 SQL，FTS5 索引同步由数据库触发器原子完成，无多步写不一致风险点

**建议方案：**

```rust
pub fn save_chapter(db: &AppDb, chapter_id: &str, content_html: &str, word_count: i64) -> Result<SaveChapterResult, AppError> {
    let mut conn = db.pool.get()?;
    let tx = conn.transaction()?;  // 开启事务

    let result = tx.execute(/* save content */)?;
    tx.execute(/* update book word_count */)?;
    let book_wc = /* query within tx */;

    tx.commit()?;  // 原子提交
    Ok(SaveChapterResult { word_count, book_word_count: book_wc })
}
```

#### 问题 2：前端乐观更新与后端无原子保证

`OutlinePanel.tsx` 中删除/恢复章节时先调用 API，成功后直接更新 Zustand：

```typescript
await chapterApi.delete(chapterId)
updateChapter(chapterId, { deletedAt: new Date().toISOString() })
```

如果 API 成功但前端崩溃/刷新，状态不同步。

**建议**：关键操作后调用 `loadBookTree()` 全量刷新，或在 API 层面返回完整状态。

---

### B. 状态管理 — 🟡 中优先级

#### 问题 3：Zustand store 职责过重

`AppState` 接口包含 172 行类型定义，涵盖 6 个完全不相关的领域（书籍、AI、偏好、插件、编辑器状态、AI 工具分类）。单一 store 导致：

- 任何字段变化都触发 `AppState` 类型检查扩散
- `useAppStore()` 调用让组件订阅了不必要的数据

**建议方案：** 拆分为独立 store：

```typescript
// stores/bookStore.ts
export const useBookStore = create<BookSlice>(...)

// stores/aiStore.ts
export const useAiStore = create<AiSlice>(...)

// stores/preferencesStore.ts
export const usePreferencesStore = create<PreferencesSlice>(...)
```

当前 Slice 模式只是代码组织层面的拆分，未真正实现状态隔离。

#### 问题 4：AI 对话持久化写放大严重

每次 `addAiMessage` / `updateAiMessage` 都立即写 `localStorage`：

```typescript
addAiMessage: (bookId, message) =>
  set((s) => {
    const conversations = { ...s.aiConversations, [bookId]: [...(s.aiConversations[bookId] ?? []), message] }
    saveAiConversations(conversations)  // 同步写 localStorage！
    return { aiConversations: conversations }
  }),
```

流式对话期间每秒可能触发数十次更新，每次序列化整个 conversations 对象到 localStorage。

**建议：** 使用防抖持久化，仅在流式结束或页面卸载时写入：

```typescript
// 仅在 streaming 结束后持久化
if (!streaming) {
  debouncedSaveAiConversations(conversations)
}
```

---

### C. 组件架构 — 🟡 中优先级

#### 问题 5：`OutlinePanel.tsx` 过于庞大

1048 行，包含 6 个子组件定义在同一个文件中：

- `DraggableVolume`
- `DraggableChapter`
- `DroppableUnassignedZone`
- `VolumePreview`
- `ChapterPreview`
- 两个对话框

**建议：** 将 `DraggableVolume`、`DraggableChapter`、对话框拆分为独立文件。

> **状态**：🟡 部分修复。v0.9.1 已抽出 `DraggableChapter` / `DraggableVolume` / `OutlineDialogs` / `OutlineDragDrop` / `OutlineRecycleBin` 子组件，文件由 1048 行降至 **842 行**，仍属大文件。

#### 问题 6：`useAiChat.ts` 函数过大

589 行的 hook，`handleSend` 包含 200+ 行业务逻辑，涵盖前置校验、章节总结、RAG 检索、流式对话、错误处理、对话压缩。违反单一职责原则。

**建议：** 拆分为独立的自定义 hook：

- `useChapterValidation` — 前置校验
- `useChapterSummary` — 章节总结缓存逻辑
- `useStreamChat` — 流式对话 + RAF 缓冲
- `useConversationCompression` — 滑动窗口 + 摘要

> **状态**：❌ 未修复。文件由 589 行降至 **483 行**，但仍为单一 hook，未按上述方案拆分。

---

## 三、功能实现层面优化建议

### A. 安全 — 🔴 高优先级

#### 问题 7：硬编码 AES 加密密钥

```rust
// src-tauri/src/commands/io/crypto.rs:15
const ENCRYPTION_KEY: &[u8; 32] = b"TimeWrite2024SecretKey!MirageInk";
```

任何获取二进制文件的人都能提取密钥，备份加密形同虚设。

> **状态**：✅ 已修复（v1.0.1 安全加固：密钥不再硬编码）。
> 算法本身为 **AES-256-GCM**（nonce[12] + ciphertext + tag[16]），算法选型正确。

**实际采用方案**（`crypto.rs`）：

1. 环境变量 `TIMEWRITE_BACKUP_KEY`（任意长度 → SHA-256 派生 32 字节）—— 优先级最高，适合 CI / 高级用户
2. 持久化密钥文件 `<app_data_dir>/backup.key` —— 首次启动生成随机密钥（Unix 权限 0600），之后自动加载

应用启动时经 `init_backup_key` 初始化，加密/解密函数从全局缓存读取。密钥泄露面从「二进制内静态常量」降为「本机文件权限保护」。

#### 问题 8：CSP 策略过宽

```json
"csp": "img-src 'self' asset: https:; connect-src 'self' ipc: http://ipc.localhost"
```

- `img-src https:` — 允许任意 HTTPS 图片源，可被用于用户追踪
- `connect-src http://ipc.localhost` — 允许明文 HTTP，应改为 `https://ipc.localhost`

> **状态**：✅ 已修复（v1.0.1：`img-src` 移除 `https:` 通配，仅保留 `asset:` + `data:`；`connect-src` 按实际需要增加 `https://api.github.com`；新增 `base-uri 'self'` / `form-action 'self'` / `frame-ancestors 'self'` 收紧）。
>
> ⚠️ 说明：`ipc:` / `http://ipc.localhost` 是 **Tauri 内部 IPC 协议**（非真实网络请求），不能改为 `https://`，否则 IPC 调用会被 CSP 阻断。AI 请求全部在 Rust 侧（`reqwest`）发起、不经过 WebView，因此无需在 CSP 中放行 AI 服务商域名。

#### 问题 9：Updater 签名未配置

```json
"pubkey": "TODO: 生成密钥对并填入公钥..."
```

**必须立即修复**：执行 `pnpm tauri signer generate -w ~/.tauri/myapp.key` 并填入公钥。

> **状态**：✅ 已修复（v1.0.1：已生成 minisign 签名密钥对，公钥已填入 `tauri.conf.json` 的 `pubkey`）。
>
> ⚠️ 使用须知：私钥保存在 `~/.tauri/timewrite.key`，口令见 v1.0.1 加固记录（**请妥善保管并尽快自行更换**）。发布 CI 需在 GitHub 仓库配置两个 Secret：`TAURI_PRIVATE_KEY`（私钥内容）与 `TAURI_PRIVATE_KEY_PASSWORD`（私钥口令），否则构建产物无法签名、更新校验将失败。

#### 问题 10：`withGlobalTauri: true`

将 Tauri API 暴露到全局作用域（`window.__TAURI__`），增加 XSS 攻击面。

**建议：** 设为 `false`，仅在需要时通过 `@tauri-apps/api` 显式导入。

> **状态**：✅ 已修复（v1.0.1：`withGlobalTauri` 已设为 `false`。已核实前端零使用 `window.__TAURI__`，所有 IPC 均经 `@tauri-apps/api` 显式导入）。

#### 问题 11：文件系统权限无作用域限制

```json
"permissions": ["fs:allow-read", "fs:allow-write", ...]
```

所有文件系统操作全局允许。

> **状态**：✅ 已修复（v1.0.1：12 项 fs 权限均已限定 `$APPDATA/**`、`$RESOURCE/**` 路径作用域；`assetProtocol.scope` 同步收窄。用户通过系统对话框选择的路径由 dialog 插件**动态授权**，不影响导入导出 / 插图功能）。

**修复方式**：

```json
{
  "identifier": "fs:allow-read",
  "scope": ["$APPDATA/**", "$RESOURCE/**"]
}
```

---

### B. 性能 — 🟡 中优先级

#### 问题 12：每次启动重建 FTS5 索引

```sql
INSERT OR REPLACE INTO chapters_fts(rowid, title, content)
    SELECT rowid, title, content_html FROM chapters WHERE deleted_at IS NULL;
```

大数据量下拖慢启动。

**建议**：仅在新数据插入时通过触发器增量更新，启动时只检查 `chapters_fts` 和 `chapters` 行数是否一致。

> **状态**：✅ 已修复。`db/mod.rs` 已建立 6 个 `CREATE TRIGGER`（chapters / world_cards 各 3 个，INSERT/UPDATE/DELETE 自动同步 FTS5）。

#### 问题 13：向量搜索全量加载到内存

```rust
all_rows.extend(embedding_repo::list_chapter_embeddings(conn, book_id)?);
all_rows.extend(embedding_repo::list_world_card_embeddings(conn, book_id)?);
```

数千章节时内存爆炸。

**建议：**

- 短期：限制 `LIMIT` 加载数量
- 长期：使用 sqlite-vss 扩展或 LanceDB 嵌入

> **状态**：✅ 已修复（2026-09-05，sqlite-vec 迁移落地）。
> - 新增 vec0 虚拟表 `chunks_vec`（rowid ↔ `embeddings.id`）作为 KNN 索引镜像，经 `sqlite3_auto_extension` 进程级注册 sqlite-vec 扩展（静态编译，bundled SQLite 直接可用，无 load_extension 权限问题）。
> - 语义检索改为 SQLite 内完成：`embedding MATCH ? ORDER BY distance LIMIT k`（cosine），内存占用 O(k)（k≤2000），彻底移除旧实现「全书向量读入内存 + Rust 逐条余弦」的 O(n·d) 路径；`bytes_to_floats` / `cosine_similarity` 已删除。
> - `embeddings` 表保持为唯一事实来源（备份/清理/统计兼容）；`db/mod.rs::ensure_chunks_vec` 启动幂等对齐（维度探测，旧库自动回填），`rebuild_chunks_vec` 在 trigger_embedding / 导入后全量重建；孤儿清理、单书/全量备份导入均同步删除 vec 镜像行。
> - 维度变化（更换 embedding 模型）自动重建镜像表；`search_service` 向量无命中或出错时降级 FTS5 关键词搜索，不再抛错。
> - sqlite-vec crate 锁定 `0.1.9` 稳定版（0.1.10-alpha.x 的 crates.io 包缺失 `sqlite-vec-diskann.c` 无法编译）。
> - 新增冒烟测试 `db::tests::sqlite_vec0_knn_cosine_smoke` 覆盖建表 / 插入 / cosine KNN / rowid 删除。

#### 问题 14：`OutlinePanel` 虚拟化实现缺陷

`overscan: activeId ? 9999 : 10` — 拖拽时渲染全部条目，大目录树会卡顿。

**建议**：使用 `@dnd-kit` 的 `rectIntersection` 碰撞检测算法，保持 `overscan: 20`，避免全量渲染。

#### 问题 15：React 缺少 Memoization

以下组件未使用 `React.memo`，每次父组件更新都重渲染：

- `OutlinePanel` 中的 `flatItems` 用 `useMemo` 但组件本身未 `memo`
- `RichTextEditor` 直接使用 `useCurrentChapter()` 返回新引用

**建议：** 对 `DraggableVolume`、`DraggableChapter`、`MessageBubble` 等列表项使用 `React.memo`。

#### 问题 16：Vite 未拆 `react`/`react-dom` chunk

`vite.config.ts` `manualChunks` 中缺少 react 相关 vendor chunk：

```typescript
if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
  return 'react-vendor'
}
```

这是最大的 vendor chunk，应单独拆出。

> **状态**：✅ 已修复。`vite.config.ts:95` 已精确匹配 `node_modules/react/` / `react-dom/` / `scheduler/` 输出为 `react-vendor`，并另拆 tiptap / lucide / state / router / markdown / utils / virtual / highlight / katex / dnd-kit / tauri-vendor 等 chunk。

---

### C. 代码质量 — 🟢 低优先级

#### 问题 17：Rust 动态 SQL 重复

`book_service.rs` 和 `world_card_service.rs` 中几乎完全相同的动态 UPDATE 构建逻辑：

```rust
let mut set_clauses: Vec<String> = Vec::new();
let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
// 逐个字段检查...
let sql = format!("UPDATE {} SET {} WHERE id=?", table, set_clauses.join(", "));
```

**建议：** 提取为宏或泛型函数：

```rust
macro_rules! build_update {
    ($table:expr, $id:expr, { $($field:ident: $col:expr),* $(,)? }) => { ... }
}
```

#### 问题 18：FTS5 搜索模式不一致

`search_service.rs` 先 FTS5 后 LIKE 降级，`world_card_service.rs` 仅在 `fts_query` 为空时才降级 LIKE。硬编码 limit 值不同（20 vs `top_n`）。

**建议：** 统一为 trait 或通用函数 `fn search(query, limit) -> Vec<T>`。

#### 问题 19：`parse_world_card` 使用列索引

```rust
// world_card_repo.rs — 脆弱
let title: String = row.get(0)?;
// vs
// book_repo.rs — 推荐
let title: String = row.get("title")?;
```

列索引在 schema 变更时极易错位。

#### 问题 20：`check-versions.ts` 锁版本解析不工作

`readLockVersions` 函数中的正则匹配逻辑不完整，实际锁版本解析是空操作。

#### 问题 21：`beforeDevCommand` 使用 `npm` 而非 `pnpm`

```json
"beforeDevCommand": "npm run dev",
"beforeBuildCommand": "npm run build"
```

项目使用 `pnpm`，应改为 `pnpm run dev` / `pnpm run build`。

> **状态**：✅ 已修复（2026-09-05）：`tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 已改为 `pnpm run dev` / `pnpm run build`，与项目 pnpm 包管理一致。

---

### D. 缺失功能 — 🟡 中优先级

#### 问题 22：缺少离线/草稿保护机制

如果应用崩溃，未保存的内容丢失。

**建议**：利用 TipTap 的 `content` + `sessionStorage` 在每次编辑时备份草稿。

#### 问题 23：缺少快捷键系统

仅实现了 `Ctrl+S` 保存。写作软件应有丰富的快捷键（加粗/倾斜/标题/撤销等）。

**建议**：使用 `useEffect` 监听全局 keydown，或使用 TipTap 内置快捷键。

> **状态**：❌ 未修复。仍仅有 `Ctrl/Cmd + S` 保存与 `Esc` 退出专注模式，格式快捷键由 TipTap 内置提供，无全局自定义快捷键系统。

#### 问题 24：缺少写作统计面板

`Book` 类型有 `dailyTarget`、`todayCount`，但前端无进度可视化。

**建议**：在 `StatusBar` 添加日更进度条。

#### 问题 25：AI 对话缺少导出功能

对话记录仅在 localStorage，无法导出备份。

**建议**：添加导出为 Markdown/JSON 功能。

#### 问题 26：缺少 Linux 构建目标

`tauri.conf.json` 仅配置了 `dmg`（macOS）和 `nsis`（Windows）。

**建议**添加 `deb` 和 `AppImage`。

---

### E. Agent 子系统（v1.0.0 新增，原报告未覆盖）

> 原报告分析于 Agent 子系统引入之前，以下为 2026-08-31 补充。

#### 问题 27：Bridge Server（9876）无鉴权 🟡 P1

`python/bridge.rs` 启动的 tiny_http 服务监听 `127.0.0.1:9876`，提供 `read_chapter` / `list_chapters` / `search_world_cards` / `book_context` 四个路由，`tools/db_tools.py` 直接 `POST /agent/{endpoint}` 调用，无 Token 校验。

任何本机进程均可读取用户全部作品内容。虽然绑定 localhost 缓解了远程风险，但多用户机器或恶意本地软件仍可窃取数据。

**建议**：Bridge 启动时生成随机 Token 写入临时文件，Python 侧读取后置于 `Authorization` 头；Rust 侧校验。

> **状态**：✅ 已消除（2026-09-05 复核确认）。v1.1 Agent 迁移为 Rust 原生引擎时，Python
> Agent(9877) 与 tiny_http Bridge(9876) 已**整体删除**：`src-tauri` 无任何 TcpListener/HTTP
> server 残留（仅存注释），无跨进程 HTTP 回调，Agent 同进程经 repository 层直查 SQLite——
> 本问题的本地数据泄露攻击面已不存在，正文保留为 v1.0 历史记录。

#### 问题 28：`/skills/cancel` 为占位实现 🟡 P1

`server/routes.py:124-128` 的 `cancel_skill` 仅返回 `{"status": "cancelled"}`，未真正中断正在执行的任务。前端「停止生成」按钮调用 `cancel_agent_skill` 后，Python 侧 LangGraph 流仍在继续消耗 Token。

**建议**：引入任务注册表（requestId → asyncio.Task），cancel 时 `task.cancel()` 并触发 SSE `cancelled` 事件。

> **状态**：✅ 已修复（2026-09-05）。Rust 引擎取消升级为 `CancelToken`（AtomicBool +
> tokio::Notify）：`cancel_agent_skill` 置位并 `notify_waiters()`，引擎在 SSE 流读取与 HTTP
> 发送两个阻塞点经 `tokio::select!` **即时中断**——不再等待 60s 行超时或下一个 chunk；被放弃
> 的流读取随即 drop、连接关闭，服务端停止生成；取消路径不再补发 `done` 事件（`engine.rs`
> 可验证）。

#### 问题 29：记忆库无容量上限与过期清理 ❌ 🟢 P2

`memory/store.py` 的 `memories` 表无行数上限，`relevance_score` 随时间衰减但从不删除。长期使用会产生大量低分记忆，拖慢检索（每次取 50 条候选全量打分）。

**建议**：定期清理 `relevance_score` 低于阈值且超过 N 天未命中的记忆；或按 (book_id, skill_type) 限制上限。

> **状态**：❌ 未修复。

#### 问题 30：Agent 端口硬编码 🟢 P3

9877（Agent）/ 9876（Bridge）散落于 `config.py`、`bridge.rs`、`manager.rs` 及 CSP 配置（`tauri.conf.json:28`）。虽支持环境变量覆盖，但前端 CSP 中的端口是硬编码的，改端口需同步修改多处。

**建议**：统一由 Rust 侧动态分配空闲端口并注入 Python 环境变量，CSP 改用运行时注入。

> **状态**：✅ 已消除（2026-09-05 复核）。9876/9877 随 v1.1 Rust 原生引擎迁移全部删除，
> 当前无任何端口监听/CSP 端口条目，本问题前提已不存在。

#### 问题 31：Agent 依赖管理 ✅

`agent/` 已提供 `pyproject.toml` + `uv.lock`，配合 `scripts/setup-agent.ts` 创建 `.venv` 并校验，依赖可复现。

> **状态**：✅ 已满足。

---

## 四、优化优先级矩阵

> 「状态」列为 2026-08-31 复核 + v1.0.1 安全加固后的结果（✅ 已修复 / 🟡 部分修复 / ❌ 未修复 / ⚪ 待确认）。

| 优先级 | 问题 | 领域 | 影响 | 状态 |
|--------|------|------|------|------|
| 🔴 P0 | 硬编码加密密钥（问题 7） | 安全 | 备份数据完全可破解 | ✅ |
| 🔴 P0 | Updater 签名未配置（问题 9） | 安全 | 更新包可被篡改 | ✅ |
| 🔴 P0 | 写操作无事务保护（问题 1） | 数据一致性 | 字数统计错乱 | ✅ |
| 🔴 P0 | CSP/权限策略过宽（问题 8、11） | 安全 | XSS/信息泄露风险 | ✅ |
| 🟡 P1 | `withGlobalTauri: true`（问题 10） | 安全 | XSS 攻击面增大 | ✅ |
| 🟡 P1 | Bridge Server 无鉴权（问题 27） | 安全 | 本地数据泄露 | ✅ 已消除 |
| 🟡 P1 | `/skills/cancel` 占位实现（问题 28） | 功能缺陷 | 无法中断，浪费 Token | ✅ |
| 🟡 P1 | Zustand 单 store 过重（问题 3） | 架构 | 性能/可维护性 | 🟡 |
| 🟡 P1 | AI 对话写放大（问题 4） | 性能 | localStorage 频繁序列化 | 🟡 |
| 🟡 P1 | 前端乐观更新无验证（问题 2） | 数据一致性 | 状态可能不同步 | ⚪ |
| 🟡 P1 | 向量搜索全量加载（问题 13） | 性能 | 大库内存爆炸 | ✅ |
| 🟡 P1 | 缺少快捷键系统（问题 23） | 功能缺失 | 用户体验 | ❌ |
| 🟡 P1 | 缺少写作统计面板（问题 24） | 功能缺失 | 用户激励 | 🟡 |
| 🟢 P2 | 动态 SQL 重复（问题 17） | 代码质量 | 可维护性 | ⚪ |
| 🟢 P2 | `useAiChat` 过大（问题 6） | 代码质量 | 可读性 | ❌ |
| 🟢 P2 | React.memo 缺失（问题 15） | 性能 | 渲染效率 | ⚪ |
| 🟢 P2 | FTS5 搜索不一致（问题 18） | 代码质量 | 可维护性 | ⚪ |
| 🟢 P2 | 列索引访问（问题 19） | 代码质量 | Schema 变更风险 | ⚪ |
| 🟢 P2 | 缺少 Linux 构建（问题 26） | 部署 | 用户覆盖面 | ❌ |
| 🟢 P2 | 记忆库无清理机制（问题 29） | 性能 | 检索退化 | ❌ |
| 🟢 P3 | `OutlinePanel` 过大（问题 5） | 代码质量 | 可读性 | 🟡 |
| 🟢 P3 | `check-versions.ts`（问题 20） | 代码质量 | 工具链 | ⚪ |
| 🟢 P3 | `beforeDevCommand`（问题 21） | 构建 | 一致性 | ❌ |
| 🟢 P3 | 缺少离线草稿（问题 22） | 功能缺失 | 数据安全 | ❌ |
| 🟢 P3 | AI 对话导出（问题 25） | 功能缺失 | 数据迁移 | ❌ |
| 🟢 P3 | Agent 端口硬编码（问题 30） | 可维护性 | 配置分散 | ✅ 已消除 |
| — | FTS5 每次启动重建（问题 12） | 性能 | 大库启动慢 | ✅ 已修复 |
| — | Vite chunk 拆分（问题 16） | 构建 | 首屏加载 | ✅ 已修复 |

---

## 五、建议修复路线图

> 路线图已按 2026-08-31 复核结果重排：**只保留仍未关闭的问题**，已完成的（FTS5 触发器、Vite chunk、OutlinePanel 初步拆分）不再占用排期。

### Phase 1（✅ 已于 2026-08-31 关闭）：P0 安全问题

| 问题 | 处理 |
|------|------|
| 9 Updater 签名 | ✅ 已生成密钥对并配置 pubkey |
| 8 CSP 收紧 | ✅ 已修复 |
| 11 fs 权限作用域 | ✅ 已修复 |
| 10 withGlobalTauri | ✅ 已修复 |
| 7 硬编码密钥 | ✅ 已修复 |

> 剩余与安全相关的未决项：**Bridge Server（9876）Token 鉴权**（问题 27，需代码改动 + 协议变更，已移至 Phase 2）。

### Phase 2（✅ 已于 2026-09-05 关闭）：Agent 收尾与一致性

1. ~~为 Bridge Server（9876）增加 Token 鉴权（问题 27）~~ ✅ **已消除**：v1.1 迁移 Rust 原生引擎时 Bridge(9876)/Python(9877) 整体删除，无端口服务残留（2026-09-05 复核）
2. ~~补齐 `book_service` / `world_card_service` / `snapshot_service` 的事务保护（问题 1 收尾）~~ ✅ **已完成**（2026-09-05，v1.5.0）
3. ~~实现 `/skills/cancel` 真正的任务中断（问题 28）~~ ✅ **已完成**（2026-09-05）：CancelToken（Notify + select）即时中断，取消不再补发 done
4. ~~`beforeDevCommand` / `beforeBuildCommand` 改为 `pnpm run …`（问题 21）~~ ✅ **已完成**（2026-09-05，v1.5.0）
5. ~~向量搜索加 `LIMIT` 分页加载（问题 13 缓解）~~ ✅ 已由 sqlite-vec KNN 方案（O(k)）取代（2026-09-05）

### Phase 3（中期 — 2-4 周）

1. 拆分 `useAiChat`（483 行）为 4 个职责单一的 hook（问题 6）
2. 将 Zustand 的 slice 模式升级为真正独立的 store（问题 3 收尾）
3. 全局快捷键系统（问题 23）
4. 离线草稿保护：TipTap content → sessionStorage（问题 22）
5. `DraggableVolume` / `DraggableChapter` / `MessageBubble` 加 `React.memo`（问题 15）
6. 记忆库容量上限与过期清理（问题 29）

### Phase 4（长期）

1. 动态 SQL 构建抽取为宏/泛型函数（问题 17）
2. ~~sqlite-vec / LanceDB 迁移，彻底解决向量检索内存问题（问题 13）~~ ✅ **已完成**（2026-09-05，vec0 镜像 + KNN）
3. AI 对话导出为 Markdown / JSON（问题 25）
4. Linux 构建目标（deb / AppImage）（问题 26）
5. 写作统计面板：日更进度条、连续天数、字数曲线（问题 24）
6. ~~Agent 端口动态分配（问题 30）~~ ✅ **已消除**：9876/9877 已随 v1.1 迁移全部删除，无端口可分配

---

## 附录：项目架构概览

```
MirageInk/
├── src/                          # React 前端
│   ├── components/
│   │   ├── ai/                   # AI 助手组件
│   │   ├── common/               # 通用组件
│   │   ├── editor/               # 编辑器组件
│   │   ├── layout/               # 布局组件
│   │   ├── library/              # 书籍库组件
│   │   └── outline/              # 目录/大纲组件
│   ├── hooks/                    # 自定义 Hooks
│   ├── lib/                      # 工具库 & IPC 桥接
│   ├── pages/                    # 页面组件
│   ├── plugins/                  # 插件系统
│   ├── router/                   # 路由配置
│   ├── stores/                   # 状态管理 (Zustand + Jotai)
│   ├── styles/                   # 全局样式
│   └── types/                    # TypeScript 类型定义
├── src-tauri/                    # Rust 后端
│   └── src/
│       ├── commands/             # Tauri IPC 命令层
│       ├── db/                   # 数据库层 (Schema + Migration)
│       ├── models/               # 数据模型
│       ├── repositories/         # 数据访问层
│       └── services/             # 业务逻辑层
├── docs/                         # 项目文档
├── product/                      # 产品资源
├── scripts/                      # 构建/工具脚本
├── package.json                  # 前端依赖
└── vite.config.ts                # Vite 构建配置
```
