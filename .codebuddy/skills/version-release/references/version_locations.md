# MirageInk (TimeWrite) 版本号分布位置

版本号在项目中分布在以下 **5 个文件**中（发版时 `bump_version.py` 会自动更新），另有 2 个自动同步来源无需手动操作：

| # | 文件 | 路径（相对于项目根目录） | 更新方式 |
|---|------|------------------------|---------|
| 1 | `package.json` | `package.json` | JSON 字段 `version` |
| 2 | `Cargo.toml` | `src-tauri/Cargo.toml` | TOML 字段 `package.version` |
| 3 | `tauri.conf.json` | `src-tauri/tauri.conf.json` | JSON 字段 `version`（**前端唯一版本来源**） |
| 4 | `README.md` | `README.md` | 应用信息表格中的版本（正则匹配 `\| 版本 \| X.Y.Z \|`） |
| 5 | `release.yml` | `.github/workflows/release.yml` | `workflow_dispatch` 默认值 |
| 6* | `CHANGELOG.md` | `docs/CHANGELOG.md` | `bump_version.py` 自动插入版本标题头部 `## vX.Y.Z (日期)` |
| * | `Cargo.lock` | `src-tauri/Cargo.lock` | `cargo build` 时自动同步（无需手动更新） |
| * | 前端页面 | 各组件 | 运行时通过 `getVersion()` 从 `tauri.conf.json` 动态读取（无需手动更新） |

> *第6项 CHANGELOG.md 由 `bump_version.py` 自动插入版本标题，但具体的更新日志内容需手动或由 AI 基于 git log 生成填充。

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

- **以上 5 个文件**每次发版必须全部更新，任一遗漏会导致更新检测失效或版本显示不一致。
- **CHANGELOG.md** 由 `bump_version.py` 自动插入版本标题，但内容需基于 git log 手动生成。
- `Cargo.lock` 由 `cargo build` 自动生成，**不需要手动修改**。
- 前端页面**不再需要手动更新版本号**，它们通过 `getVersion()` 自动同步 `tauri.conf.json`。
- `README.md` 中版本号仅出现在**应用信息表格**中，更新日志内容已移至 `docs/CHANGELOG.md`。
- GitHub Actions 的 `release.yml` 中 `workflow_dispatch` 的 `default` 值建议同步更新。
- 版本 Tag 格式为 `vX.Y.Z`（带 `v` 前缀），这是 GitHub Actions 自动构建的触发条件。
