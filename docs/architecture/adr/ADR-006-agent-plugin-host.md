# ADR-006：Agent 插件宿主（第三方 Agent 的安装与卸载）

> **状态**：提议
> **日期**：2026-10-10
> **影响范围**：Agent 引擎 / IPC 契约 / 应用安全边界 / 前端插件 UI
> **适用版本**：`1.20.0`　|　**最后核对**：2026-10-10
> **相关**：
> - [ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)
> - [ADR-005：Agent 扩展模型（工具注册表 / 执行模式 / 前端自动发现）](architecture/adr/ADR-005-agent-extension-model)

## 背景

在评估「Agent 是否该做成可安装 / 卸载的插件」时，用户明确选择支持**第三方编写的、带自定义逻辑的 Agent**——即插件能自带工具、访问数据、跑自定义流程。这不是「开发者在代码里加一个内置 Agent」，也不是「导入一段配置」。

本 ADR 记录如何承载这一诉求。[ADR-005](architecture/adr/ADR-005-agent-extension-model) 曾以「`'ai-prompt'` 扩展点无消费端、`PluginContext` 无后端能力」为由排除复用现有插件系统；本 ADR 确认该结论仍然成立，但**不是放弃插件化，而是另建宿主**——现有 `src/plugins/` 是编译期硬编码的静态容器，与「运行时装卸」无关。

### 走查得到的五个硬事实

**事实一：现有插件系统与「运行时装卸」无关。**

`src/plugins/bootstrap.ts:9-12` 是硬编码 `import`，插件清单就是 `doBootstrap()` 函数体本身。安装一个插件必须改源码、加 import、重新构建。无任何 manifest 扫描、目录扫描或动态 import。`PluginManager` 的 `statuses` 是内存 Map，**启用状态不持久化**，重启即回默认。

**事实二：`PluginContext` 只有 11 个方法，且 7 个是空桩。**

`app.getActiveBookId` / `getActiveChapterId` 恒 `undefined`，`editor.*` 四个方法恒空串或空实现（`bootstrap.ts:23-31`）。真正可用的只有 `storage` 与 `notify`。无 `invoke`、无数据库、无 LLM。两个内置插件（`dictionary` / `taskCards`）是靠顶层 `import windowApi` 绕过 context 的——那是「同属主 bundle」的特权，第三方代码拿不到。

**事实三：项目零第三方代码执行设施。**

无 `wasmtime` / `wasmer`、无脚本引擎（rhai / lua / deno）。`Cargo.toml` 的 `crate-type = ["staticlib", "cdylib", "rlib"]` 是 Tauri 移动端构建要求，**不是插件机制**；`Cargo.lock` 里的 `wasm` / `libloading` / `dlopen2` 全是 Tauri 的传递依赖。

**事实四：CSP 的 `connect-src` 已经很严格（有利）。**

```
connect-src 'self' ipc: http://ipc.localhost https://asset.localhost https://api.github.com
```

网络出站已被限制到白名单域，插件 JS 无法用 `fetch` 随意外传数据。

**事实五：CSP 的 `script-src 'self'` 无 `'unsafe-eval'`，且 CSP 无法按窗口隔离（代价）。**

加载第三方 JS 必然需要放宽 CSP。而 Tauri v2 的 CSP 是 `tauri.conf.json` 中的**页面级全局配置**，不能按窗口或按插件分别设置——放宽即为全局放宽。

### 一个被忽略的有利事实

`tauri.conf.json` 中 `withGlobalTauri: false`。前端不存在 `window.__TAURI__`，一切 IPC 都必须经 `@tauri-apps/api` 的模块引用。而运行时加载的插件代码不参与 Vite 打包，**拿不到任何 bundle 内模块的引用**。

这意味着能力边界可以天然成立：**插件能调用什么，完全取决于宿主注入了什么**，无需在 IPC 层做复杂的白名单校验。

## 备选方案

### 插件代码载体

| 方案 | 沙箱强度 | 新增依赖 | 作者门槛 | 判定 |
|------|---------|---------|---------|------|
| A. 前端 JS + 宿主注入受限 API | 中（网络已被 CSP 限制） | **无** | 低（写 JS 即可） | ✅ 选择 |
| B. WASM（wasmtime / wasmer） | 强（默认无文件与网络，可限内存与 CPU） | 重（编译变慢、体积增大量级） | 中（需能编译到 wasm） | 远期可选 |
| C. Rust cdylib + libloading | — | 中 | 高（须与宿主同 rustc 与依赖版本） | ❌ 排除：Rust 无稳定 ABI，版本错配即 UB |

### 能力边界的切法

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 插件可直连数据库与 LLM | 表达力最强 | 数据库连接与 API Key 进入插件可见范围；无法审计；一次泄露即全局失效 |
| B. **插件只能编排宿主原子能力** | 边界可控；审计面收敛到「插件调用了哪些原子能力」；可按需开关单项能力 | 插件无法表达宿主未提供的原子操作 |
| C. 插件声明式（无代码） | 最安全 | 无法满足「带自定义逻辑」的诉求 |

## 决策

采用 **A + B**，即「**前端 JS 载体 + 宿主注入 + 只可编排不可直连**」，并**延后到 ADR-005 前五阶段完成后实施**。

### 决策 1：三层能力模型

```
第三方插件（JS · 不可信）
   ↓  宿主注入的 host 对象
宿主编排层（提示词 · Pipeline · 工具引用）
   ↓
宿主原子能力（读章节 · 检索卡片 · 调 LLM · 写章节）
   ✗  权限边界
绝不暴露（数据库连接 · API Key · 原始 SQL）
```

插件写的是「如何组合原子能力」，不是「直接操作数据」。宿主只向插件暴露**行为**，不暴露**资源句柄**。

### 决策 2：能力经宿主注入，而非 IPC 层白名单

不做「IPC 命令白名单校验」，因为：

1. `withGlobalTauri: false` + 插件不参与打包 ⇒ 插件**根本拿不到 invoke 能力**，白名单无从绕过；
2. Tauri v2 的 capability 系统**只约束官方插件权限，不约束 app 自定义命令**，即便想靠它做白名单也做不了。

因此实现方式是：宿主构造一个只读的 `host` 对象注入插件，插件闭包内只能见到该对象。

```ts
type PluginHost = {
  llm: { complete(prompt: string): Promise<string> }
  book: { readChapter(id: string): Promise<string>; listChapters(): Promise<Chapter[]> }
  card: { search(query: string): Promise<Card[]> }
  log: { info(msg: string): void }
  storage: { get<T>(k: string): Promise<T | undefined>; set<T>(k: string, v: T): Promise<void> }
}
```

> ⚠️ 仍需保留一层兜底：宿主注入的 `llm.complete` 必须走**应用自己的配置**（用户填入的 API Key），不得接受插件传入的 endpoint 或 key，否则密钥边界被绕过。

### 决策 3：插件包格式与存放位置

```
{app_data_dir}/plugins/<plugin-id>/
  ├── manifest.json
  └── index.js
```

`app_data_dir` 已被现有代码使用（`time_write.db`、`attachments/`、`backup.key`），沿用即可。

`manifest.json` 字段：

| 字段 | 说明 |
|------|------|
| `id` | 与目录名一致，复用现有 `ID_PATTERN` |
| `name` / `version` / `description` / `author` | 与现有 `PluginManifest` 保持一致 |
| `grants` | **权限声明**，如 `["llm", "book.read", "card.search"]` |
| `profiles` | 该插件贡献的 Agent 画像（提示词 + 工具引用 + 预算） |
| `entry` | 入口文件，默认 `index.js` |

`grants` 是核心：安装时向用户展示「该插件将获得以下能力」，运行时宿主**只注入 `grants` 内声明的字段**。

### 决策 4：加载方式——受控执行 + 安装确认

因 CSP `script-src 'self'` 不含 `'unsafe-eval'`，需在 `tauri.conf.json` 中放宽。这是**全局**放宽，无法只对插件生效，故配套三条缓解措施：

1. **纯文本可读**：插件是 `.js` 源码而非二进制，安装界面直接展示源码供审核；
2. **显式确认**：安装需用户逐项确认 `grants`；
3. **能力最小化**：默认只注入 `grants` 中声明的项，未声明的一律不注入。

### 决策 5：实施节奏——先地基，后宿主

**ADR-005 的阶段一到五一字不改**，在其后追加两个阶段：

| 阶段 | 内容 | 变化 |
|------|------|------|
| 一到五 | L0 工具注册表 / L1 画像注册表 / `book_type` / 领域画像 / L3 自动发现 | **不变** |
| 六 | L2 `Pipeline` | **P3 → P2**：它现在是插件的编排层，不再只是拆书 Agent 的附属 |
| 七 | 插件宿主 | 新增：加载器 + `grants` 注入 + 启用清单持久化 + 管理 UI |

理由是 **ADR-005 的 L0 与 L2 本质上就是本 ADR 的前置**：

- **L0 工具注册表 = 宿主原子能力清单**，它决定插件能调用什么；
- **L2 `Pipeline` = 编排层**，它决定插件的自定义逻辑能表达到什么程度。

换句话说，**本 ADR 的插件宿主 ≈ ADR-005 的 L0/L1/L2 + 运行时加载器 + `grants` 权限模型**。跳过地基直接建宿主，会导致原子能力清单尚未收敛、插件 API 频繁 breaking change。

## 理由

1. **插件是数据 + 编排，不是资源访问者**。Agent 的价值在于「如何组织上下文与步骤」，而非「直接操作数据库」。把边界划在行为层而非资源层，安全面收敛为一个可枚举的 `grants` 列表。
2. **`withGlobalTauri: false` 让能力边界几乎免费**。不需要沙箱、不需要 IPC 拦截层，只需要「不注入」。这是本项目既有配置带来的红利。
3. **JS 载体零新增依赖**。引入 wasmtime 会让构建时间、二进制体积、插件作者门槛同时上升，而对单用户桌面应用而言，插件来源本就是「用户自己选择安装的那几个」，威胁模型弱于浏览器扩展生态。
4. **先做地基不返工**。L0/L1/L2 在两种路线下完全一致，先做完既不会浪费，也能让领域 Agent 提前可用。
5. **Rust 原生动态库不可行**。无稳定 ABI，宿主与插件必须用完全相同的 rustc 与依赖版本编译，否则 UB；且现有 `cdylib` 是 Tauri 移动端构建要求，改它会破坏构建。

## 后果

### 正面

- 第三方（含用户自己）可编写带自定义逻辑的 Agent，运行时安装 / 卸载，无需重新编译
- 能力边界由 `grants` 显式声明，安装时可审计，运行时按需开关
- 插件纯文本分发，可读、可 diff、可版本管理
- 复用现有 `app_data_dir` 与备份体系，插件目录可纳入备份
- 前五阶段不返工，领域 Agent 能先落地先受益

### 负面 / 代价

- ⚠️ **必须全局放宽 CSP**（`script-src` 加 `'unsafe-eval'`），且 Tauri v2 不支持按窗口隔离——这是选 JS 载体最实质的安全代价，无法只让插件承担
- **宿主注入是唯一防线**。一旦 `host` 对象上挂载了高权限方法（如任意 SQL），边界即失效——需以代码评审与单测固化「注入面」
- **LLM 通道天然是数据出口**。插件可通过 `llm.complete` 把内容带出应用，这是任何插件系统的固有问题，只能在安装确认时告知
- **插件生态维护成本**。宿主 API 一旦发布即需保持向后兼容，会拖慢 L0 工具注册表的演进
- **Pipeline 优先级上升**，工作量从「可选」变为「必需」
- **新增 IPC 命令**（枚举 / 安装 / 卸载 / 启用），需同步 `ipc-commands.ts` 契约

### 需要 follow-up 的事项

- 🔜 **CSP 放宽的具体形态**：`'unsafe-eval'` 与 `asset:` + `<script src>` 两条路线的取舍，建议在阶段七动手前实测
- 🔜 是否引入**插件签名** —— 当前威胁模型下（用户主动安装、纯文本可审核）暂不引入，若将来有分发市场再评估
- 🔜 **`grants` 的粒度**：按能力项（`book.read`）还是按工具名（`read_chapter`）？建议跟随 L0 注册表落地后再定，避免二次调整
- 🔜 **插件目录是否纳入备份** —— 倾向于纳入，但需确认备份体积与导入时的覆盖策略
- 🔜 **WASM 作为第二载体**：本 ADR 已把宿主注入抽象为 `PluginHost` 接口，将来换 WASM 执行器时前端注入面不变，但宿主侧需新增 host function 绑定
- ⚠️ 现有 `src/plugins/` 与本 ADR 的插件宿主**是两套东西**，长期并存会造成概念混淆。建议阶段七落地时明确命名（如前者称「内置模块」，后者称「Agent 插件」），并在文档中划清边界

## 相关文档

- [ADR-004：Agent 领域画像与能力技能正交分层](architecture/adr/ADR-004-domain-aware-agent-profiles)
- [ADR-005：Agent 扩展模型（工具注册表 / 执行模式 / 前端自动发现）](architecture/adr/ADR-005-agent-extension-model)
- [领域感知 Agent 实施计划](development/agent-profile-plan)
- [插件系统](development/plugin-system)
- [Agent 引擎架构](architecture/agent-architecture)
