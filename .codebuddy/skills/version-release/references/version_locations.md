# TimeWrite 版本号分布位置

版本号在项目中分布在以下 **5 个文件**中（发版时 `bump_version.py` 会自动更新），另有 2 个自动同步来源无需手动操作：

| # | 文件 | 路径（相对于项目根目录） | 更新方式 |
|---|------|------------------------|---------|
| 1 | `package.json` | `package.json` | JSON 字段 `version` |
| 2 | `Cargo.toml` | `src-tauri/Cargo.toml` | TOML 字段 `package.version` |
| 3 | `tauri.conf.json` | `src-tauri/tauri.conf.json` | JSON 字段 `version`（**前端唯一版本来源**） |
| 4 | `README.md` | `README.md` | 应用信息表格中的版本 |
| 5 | `release.yml` | `.github/workflows/release.yml` | `workflow_dispatch` 默认值 |
| * | `Cargo.lock` | `src-tauri/Cargo.lock` | `cargo build` 时自动同步（无需手动更新） |
| * | 前端页面 | `SettingsPage.tsx` / `LibraryPage.tsx` | 运行时通过 `getVersion()` 从 `tauri.conf.json` 动态读取（无需手动更新） |

## 版本统一机制

前端不再硬编码版本号。`App.tsx` 启动时调用 Tauri 的 `getVersion()` 从 `tauri.conf.json` 读取版本号，存入全局 store，所有页面统一引用此值。因此：

- `tauri.conf.json` 是**前端的唯一版本来源**，发版时由 `bump_version.py` 自动更新。
- `SettingsPage.tsx` 的版本显示和更新检测、`LibraryPage.tsx` 的底部状态栏，均自动跟随 `tauri.conf.json`。

## 关键注意

- **以上 5 个文件**每次发版必须全部更新，任一遗漏会导致更新检测失效或版本显示不一致。
- `Cargo.lock` 由 `cargo build` 自动生成，**不需要手动修改**。
- 前端页面（`SettingsPage.tsx` / `LibraryPage.tsx`）**不再需要手动更新版本号**，它们通过 `getVersion()` 自动同步 `tauri.conf.json`。
- `README.md` 中版本出现在**应用信息表格**中（`bump_version.py` 自动更新），新版本条目由发版流程手动插入到更新日志。
- GitHub Actions 的 `release.yml` 中 `workflow_dispatch` 的 `default` 值建议同步更新。
