# MirageInk 版本号分布位置

版本号在项目中分布在以下 **6 个文件**中（发版时 `bump_version.py` 会自动更新全部 6 个），另有 1 个自动同步文件无需手动操作：

| # | 文件 | 路径（相对于项目根目录） | 更新方式 |
|---|------|------------------------|---------|
| 1 | `package.json` | `package.json` | JSON 字段 `version` |
| 2 | `Cargo.toml` | `src-tauri/Cargo.toml` | TOML 字段 `package.version` |
| 3 | `tauri.conf.json` | `src-tauri/tauri.conf.json` | JSON 字段 `version` |
| 4 | `SettingsPage.tsx` | `src/pages/SettingsPage.tsx` | 硬编码 `const APP_VERSION = 'X.Y.Z'` |
| 5 | `README.md` | `README.md` | 应用信息表格中的版本 |
| 6 | `release.yml` | `.github/workflows/release.yml` | `workflow_dispatch` 默认值 |
| * | `Cargo.lock` | `src-tauri/Cargo.lock` | `cargo build` 时自动同步（无需手动更新） |

## 关键注意

- **以上 6 个文件**每次发版必须全部更新，任一遗漏会导致更新检测失效或版本显示不一致。
- `Cargo.lock` 由 `cargo build` 自动生成，**不需要手动修改**。
- `SettingsPage.tsx` 中的 `APP_VERSION` 用于前端版本显示和 GitHub Releases API 更新检测。
- `README.md` 中版本出现在**应用信息表格**中（`bump_version.py` 自动更新），新版本条目由发版流程手动插入到更新日志。
- GitHub Actions 的 `release.yml` 中 `workflow_dispatch` 的 `default` 值建议同步更新。
