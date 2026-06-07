# MirageInk 版本号分布位置

版本号在项目中分布在以下 6 个文件中，发版时必须全部更新：

| # | 文件 | 路径（相对于项目根目录） | 更新方式 |
|---|------|------------------------|---------|
| 1 | `package.json` | `package.json` | JSON 字段 `version` |
| 2 | `Cargo.toml` | `src-tauri/Cargo.toml` | TOML 字段 `package.version` |
| 3 | `tauri.conf.json` | `src-tauri/tauri.conf.json` | JSON 字段 `version` |
| 4 | `Cargo.lock` | `src-tauri/Cargo.lock` | `cargo build` 时自动同步 |
| 5 | `SettingsPage.tsx` | `src/pages/SettingsPage.tsx` | 硬编码 `const APP_VERSION = '0.1.0'` |
| 6 | `README.md` | `README.md` | 应用信息表格 + 更新日志标题 |
| 7 | `release.yml` | `.github/workflows/release.yml` | `workflow_dispatch` 默认值 |

## 关键注意

- `Cargo.lock` 由 `cargo build` 自动生成，**不需要手动修改**。
- `SettingsPage.tsx` 中的 `APP_VERSION` 用于前端版本显示和 GitHub Releases API 更新检测。
- README.md 中版本出现在两处：应用信息表格 和 更新日志标题。
- GitHub Actions 的 `release.yml` 中 `workflow_dispatch` 的 `default` 值建议同步更新。
