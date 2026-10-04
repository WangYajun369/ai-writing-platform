# MirageInk (TimeWrite) 版本号分布位置

版本号在项目中分布在以下 **7 个文件 / 10 个引用点**中（发版时 `bump_version.py` 会自动更新），另有 **docs 文档版本标记**（约 19 个文件，由 `refresh-doc-versions.mjs` 同步），以及 2 个自动同步来源无需手动操作：

## 一、核心版本引用点（`bump_version.py` 自动更新，`check.mjs` 断言守护）

| # | 文件 | 路径（相对于项目根目录） | 引用点 | 更新方式 |
|---|------|------------------------|--------|---------|
| 1 | `package.json` | `package.json` | JSON 字段 `version`（**唯一真源**） | JSON 字段 |
| 2 | `Cargo.toml` | `src-tauri/Cargo.toml` | `[package] version` | TOML 字段 |
| 3 | `tauri.conf.json` | `src-tauri/tauri.conf.json` | JSON 字段 `version`（**前端运行时版本来源**） | JSON 字段 |
| 4 | `README.md` | `README.md` | 应用信息表格「版本」行 | 正则 `\| 版本 \| X.Y.Z \|` |
| 5 | `README.md` | `README.md` | 头部「**当前版本：`X.Y.Z`**」行 | 正则 |
| 6 | `README.md` | `README.md` | 头部「> **vX.Y.Z 亮点**」行（仅改版本号） | 正则 |
| 7 | `docs/Home.md` | `docs/Home.md` | 应用信息表格「当前版本」行 | 正则 `\| 当前版本 \| X.Y.Z \|` |
| 8 | `product/landing-page.html` | `product/landing-page.html` | Hero 徽章「vX.Y.Z 已发布」（仅改版本号） | 正则 |
| 9 | `product/landing-page.html` | `product/landing-page.html` | 页脚版本号 | 正则 |
| 10 | `release.yml` | `.github/workflows/release.yml` | `workflow_dispatch` 默认值 | 正则 |

## 二、docs 文档版本标记（`refresh-doc-versions.mjs` 同步，`check.mjs` 不断言）

`docs/**/*.md` 头部的 `> **适用版本**：\`X.Y.Z\`　|　**最后核对**：YYYY-MM-DD` 标记，约 19 个文档。发版时必须执行：

```bash
node scripts/refresh-doc-versions.mjs --write --version <新版本号>
```

> ⚠️ 带注解的版本标记（如 `1.7.0（本规范已于 v1.7.0 落地实现）`）不会被脚本自动替换，需手动更新版本号、保留历史注解。

## 三、自动同步来源（无需手动操作）

| 来源 | 说明 |
|------|------|
| `Cargo.lock` | `src-tauri/Cargo.lock` | `cargo build` 时自动同步 |
| 前端页面 | 各组件 | 运行时通过 `getVersion()` 从 `tauri.conf.json` 动态读取 |

## 四、CHANGELOG（版本流水）

| # | 文件 | 说明 |
|---|------|------|
| 6* | `docs/CHANGELOG.md` | `bump_version.py` 自动插入 `## vX.Y.Z (日期)` 版本标题；正文需基于 git log 人工生成 |

## 版本统一机制

前端不再硬编码版本号。App 启动时调用 Tauri 的 `getVersion()` 从 `tauri.conf.json` 读取版本号，存入全局 store，所有页面统一引用此值。因此：

- `tauri.conf.json` 是**前端的唯一版本来源**，发版时由 `bump_version.py` 自动更新。
- 所有前端页面（设置页、状态栏等）均通过 `getVersion()` 自动跟随 `tauri.conf.json`。

## 更新日志管理

版本更新日志独立存放于 `docs/CHANGELOG.md`，不再放在 `README.md` 中。

- **README.md**：仅保留指向 `docs/CHANGELOG.md` 的链接，以及应用信息表格中的版本号。
- **CHANGELOG.md**：使用 `## vX.Y.Z (YYYY-MM-DD)` 格式，按 `### 新增` / `### 修复` / `### 优化` 三个分类组织条目。
- **发版时**：
  - `bump_version.py` 自动在 CHANGELOG.md 中插入 `## vX.Y.Z (当天日期)` 版本标题
  - 更新日志具体内容由发版流程（SKILL.md Step 2）基于 git log 生成并填充
  - `bump_version.py` 自动更新 README.md 应用信息表格中的版本号

## 关键注意

- **以上 10 个核心引用点**每次发版必须全部更新，任一遗漏会导致 `check.mjs` 失败。
- **docs 文档版本标记**发版时必须用 `refresh-doc-versions.mjs` 同步，否则文档停留在旧版本。
- **CHANGELOG.md** 由 `bump_version.py` 自动插入版本标题，但内容需基于 git log 手动生成。
- `Cargo.lock` 由 `cargo build` 自动生成，**不需要手动修改**。
- 前端页面**不再需要手动更新版本号**，它们通过 `getVersion()` 自动同步 `tauri.conf.json`。
- GitHub Actions 的 `release.yml` 中 `workflow_dispatch` 的 `default` 值建议同步更新。
- 版本 Tag 格式为 `vX.Y.Z`（带 `v` 前缀），这是 GitHub Actions 自动构建的触发条件。
