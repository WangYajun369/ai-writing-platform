# GitHub 集成总览

> 本文档汇总了 MirageInk 项目当前使用的全部 GitHub 功能及配置说明。

---

## 仓库信息

| 项目 | 详情 |
|------|------|
| 仓库地址 | [WangYajun369/ai-writing-platform](https://github.com/WangYajun369/ai-writing-platform) |
| GitHub Pages | <https://wangyajun369.github.io/ai-writing-platform/> |
| GitHub Wiki | <https://github.com/WangYajun369/ai-writing-platform/wiki> |
| 开源协议 | [MIT License](https://github.com/WangYajun369/ai-writing-platform/blob/main/LICENSE) |

---

## 一、GitHub Actions 工作流（3 个）

### 1.1 产品首页部署 — `deploy-pages.yml`

**用途**：将 `product/` 目录自动部署到 GitHub Pages，作为产品展示首页。

| 配置项 | 说明 |
|------|------|
| 触发条件 | push 到 `main` 分支，且变更涉及 `product/**`；支持手动触发 |
| 部署目录 | `product/`（启动页为 `landing-page.html`） |
| 权限 | `contents: read`, `pages: write`, `id-token: write` |

**流程**：

```
检出代码 → 配置 Pages → 复制 product 文件 → 上传 Artifact → 部署到 Pages
```

- 自动将 `landing-page.html` 重命名为 `index.html` 作为站点首页
- 使用官方 `actions/deploy-pages@v4` 进行部署
- 并发控制：同一时间只运行一个部署任务

---

### 1.2 Wiki 文档同步 — `deploy-wiki.yml`

**用途**：将 `docs/` 目录下的所有 Markdown 文件自动同步部署到 GitHub Wiki。

| 配置项 | 说明 |
|------|------|
| 触发条件 | push 到 `main` 分支，且变更涉及 `docs/**`；支持手动触发 |
| 权限 | `contents: write` |
| 认证方式 | `WIKI_DEPLOY_TOKEN`（Personal Access Token） |

**流程**：

```
验证 docs 目录 → 克隆 Wiki 仓库 → 同步文档 → 提交推送 → 验证页面可访问性
```

**核心处理逻辑**：

- **文件要求**：`docs/` 下至少 10 个 `.md` 文件才执行同步，防止意外清空 Wiki
- **扁平化处理**：`docs/user-guide/quick-start.md` → `docs/user-guide/章节编辑.md`
  - 子目录文件以 `{目录名}-{文件名}.md` 格式扁平化命名
  - 自动修正所有内部链接（`[text](subdir/page)` → `[text](subdir-page)`）
- **完整性校验**：部署后自动检查 `Home`、`quick-start`、`feature-list` 等关键页面的 HTTP 200 状态

---

### 1.3 多平台构建与发布 — `release.yml`

**用途**：构建 macOS DMG 和 Windows NSIS 安装包，并创建 GitHub Release。

| 配置项 | 说明 |
|------|------|
| 触发条件 | 推送 `v*` 标签（如 `v0.3.0`）；支持手动触发（可指定版本号） |
| 目标平台 | macOS ARM64（DMG）+ Windows x64（NSIS 安装包） |
| 签名 | macOS 代码签名 + 公证（可选），Tauri updater 签名 |

**Jobs 结构**：

```
build-macos (macos-latest) ─┐
                             ├──→ create-release (ubuntu-latest)
build-windows (windows-latest) ┘
```

**`build-macos` Job**：

1. 设置 Node 24 + pnpm + Rust stable
2. 可选：导入 Apple 开发者证书（`apple-actions/import-codesign-certs@v3`）
3. 构建：`pnpm tauri build --target aarch64-apple-darwin`（使用 `TAURI_SIGNING_PRIVATE_KEY` 签名）
4. 可选：通过 `xcrun notarytool` 公证 + `xcrun stapler staple` 装订票据
5. 上传 DMG 为 Artifact

**`build-windows` Job**：

1. 同样工具链设置
2. 构建：`pnpm tauri build`
3. 上传 NSIS 安装包为 Artifact

**`create-release` Job**：

1. 下载所有平台的 Artifact
2. **生成 `latest.json`**（Tauri updater 所需）：
   - 包含版本号、签名、各平台下载 URL
   - URL 格式：`https://github.com/{repo}/releases/download/{version}/{filename}`
3. 使用 `softprops/action-gh-release@v2` 创建 Release
   - 发布标题：`TimeWrite {version}`
   - 附带中英文下载说明和文件列表

---

## 二、Issue 模板

### 2.1 配置入口

文件：`.github/ISSUE_TEMPLATE/config.yml`

- 启用空白 Issue
- 引导用户先查阅 [Wiki 文档](https://github.com/WangYajun369/ai-writing-platform/wiki)

### 2.2 Bug 报告模板

文件：`.github/ISSUE_TEMPLATE/bug_report.yml`（YAML 表单）

| 字段 | 类型 | 必需 |
|------|------|------|
| 问题描述 | 文本域 | ✅ |
| 复现步骤 | 文本域 | ✅ |
| 期望行为 | 文本域 | ✅ |
| 截图或录屏 | 文本域 | ❌ |
| 应用版本 | 文本输入 | ❌ |
| 操作系统 | 下拉选择（macOS / Windows / Linux） | ✅ |
| 相关日志 | 文本域 | ❌ |

自动标签：`bug`, `triage`

### 2.3 功能请求模板

文件：`.github/ISSUE_TEMPLATE/feature_request.yml`（YAML 表单）

| 字段 | 类型 | 必需 |
|------|------|------|
| 需求背景 | 文本域 | ✅ |
| 建议方案 | 文本域 | ✅ |
| 备选方案 | 文本域 | ❌ |
| 补充信息 | 文本域 | ❌ |

自动标签：`enhancement`

---

## 三、应用内更新检查

### 3.1 Tauri Updater 插件

配置文件：`src-tauri/tauri.conf.json`

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/WangYajun369/ai-writing-platform/releases/latest/download/latest.json"
    ]
  }
}
```

- 更新检查端点直接指向 GitHub Releases 的 `latest.json`
- 后端注册插件：`src-tauri/src/lib.rs` 中 `tauri_plugin_updater::Builder::new().build()`

### 3.2 前端双重回退机制

文件：`src/pages/SettingsPage.tsx`

更新检查策略：

```
Tauri Updater 插件检查
        │
        ├── 成功 → 显示新版本信息，引导更新
        │
        └── 失败 → 回退到 GitHub Releases API
                    │
                    ├── GET https://api.github.com/repos/{repo}/releases/latest
                    │
                    ├── 403 (Rate Limit) → 友好提示
                    ├── 404 → 友好提示
                    └── 成功 → "前往 GitHub 下载"
```

- 使用 `Accept: application/vnd.github+json` 请求头
- 常量定义：`GITHUB_REPO = 'WangYajun369/ai-writing-platform'`

---

## 四、产品首页

文件：`product/landing-page.html`（部署为 GitHub Pages 首页）

- Open Graph 元标签指向 `wangyajun369.github.io/ai-writing-platform/`
- 下载按钮链接至 GitHub Releases 页面
- 源码查看链接至 GitHub 仓库
- Footer 注明 MIT License 和 GitHub 仓库链接

---

## 五、`.gitignore` 配置

忽略内容总结：

| 类别 | 忽略项 |
|------|--------|
| 依赖 | `node_modules/` |
| 构建产物 | `dist/`, `dist-ssr/`, `src-tauri/target/` |
| IDE | `.idea/`, `.vscode/`, `*.swp`, `*.swo` |
| 系统文件 | `.DS_Store`, `Thumbs.db` |
| 环境变量 | `.env`, `.env.*`（保留 `!.env.example`） |
| 日志 | `*.log`, `npm-debug.log*`, `pnpm-debug.log*` |
| TypeScript | `*.tsbuildinfo` |

---

## 六、Secrets 配置

GitHub Actions 依赖以下 Repository Secrets：

| Secret 名称 | 用途 | 关联 Workflow |
|------|------|------|
| `WIKI_DEPLOY_TOKEN` | Wiki 仓库推送权限（PAT） | `deploy-wiki.yml` |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 签名私钥 | `release.yml` |
| `APPLE_CERTIFICATE` | macOS 代码签名证书（可选） | `release.yml` |
| `APPLE_CERTIFICATE_PASSWORD` | 证书密码（可选） | `release.yml` |
| `APPLE_ID` | Apple 开发者账号（公证用，可选） | `release.yml` |
| `APPLE_TEAM_ID` | Apple Team ID（公证用，可选） | `release.yml` |
| `APPLE_APP_PASSWORD` | App 专用密码（公证用，可选） | `release.yml` |
| `GITHUB_TOKEN` | 创建 Release 的写入权限 | `release.yml`（自动提供） |

---

## 七、功能总览

| 功能 | 状态 | 说明 |
|------|------|------|
| GitHub Actions CI/CD | ✅ 3 个 Workflow | Pages 部署、Wiki 同步、多平台构建发布 |
| Issue 模板 | ✅ 2 个模板 | Bug 报告（中文表单）+ 功能请求（中文表单） |
| GitHub Pages | ✅ 已部署 | `product/` 作为产品首页自动部署 |
| GitHub Wiki | ✅ 自动同步 | `docs/` 目录扁平化同步到 Wiki |
| GitHub Releases | ✅ 自动创建 | Tag push 触发 macOS + Windows 构建并发布 |
| Tauri Updater | ✅ 配置完成 | 端点指向 GitHub Releases 的 `latest.json` |
| 应用内更新检查 | ✅ 前端实现 | Tauri updater + GitHub API 双重回退 |
| MIT License | ✅ 已配置 | 版权：WangYaJun 2026 |
| CODEOWNERS | ❌ 未配置 | 暂无分支保护规则 |
| Dependabot | ❌ 未配置 | 无自动依赖更新 |
| FUNDING.yml | ❌ 未配置 | 未设置赞助入口 |
| PR Template | ❌ 未配置 | 无 Pull Request 模板 |
