---
name: version-release
description: MirageInk 项目版本发布技能。当用户需要发布 GitHub Releases、更新版本号、bump 版本、或对项目进行发版时使用。触发词包括：发布大版本、发布新功能版本、发布优化版本、发布补丁版本、重置当前版本、发版、bump version、release、tag 等。
---

# MirageInk 版本发布

## Overview

该技能负责 MirageInk（Tauri v2 + React + TypeScript）项目的版本号管理和 GitHub Releases 发布流程。版本号在项目中分布于 6 个文件，必须全部同步更新。

## 触发场景

| 用户命令 | 操作 | 示例 |
|---------|------|------|
| 发布大版本 | major bump | 0.1.0 → 1.0.0 |
| 发布新功能版本 | minor bump | 0.1.0 → 0.2.0 |
| 发布优化版本 / 发布补丁版本 | patch bump | 0.1.0 → 0.1.1 |
| 重置当前版本 | set 指定版本 | 重置为 0.1.0 |

## 工作流程

### Step 1：更新版本号

使用 `scripts/bump_version.py` 脚本自动更新所有 6 个文件中的版本号：

```bash
# 项目根目录下执行
python3 .codebuddy/skills/version-release/scripts/bump_version.py major   # 大版本
python3 .codebuddy/skills/version-release/scripts/bump_version.py minor   # 新功能
python3 .codebuddy/skills/version-release/scripts/bump_version.py patch   # 优化/补丁
python3 .codebuddy/skills/version-release/scripts/bump_version.py set 0.5.0  # 重置
```

该脚本自动更新的文件：
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src/pages/SettingsPage.tsx`（APP_VERSION 常量）
- `README.md`（应用信息表格中的版本）
- `.github/workflows/release.yml`（workflow_dispatch 默认值）

脚本执行后会显示更新结果和后续步骤提示。

### Step 2：自动生成 README 更新日志

基于 git log 自动生成更新日志条目，添加到 `README.md` 的 `## 更新日志` 部分顶部：

1. **获取上一版本 Tag 以来的提交记录**：

```bash
git log <上一个Tag>..HEAD --format="%h %s"
# 例如: git log v0.1.0..HEAD --format="%h %s"
```

2. **按提交类型分类**，识别 `feat:` / `fix:` / `chore:` / `refactor:` / `perf:` 等 conventional commits 前缀：

| 前缀 | 分类 |
|------|------|
| `feat:` | 新增 |
| `fix:` | 修复 |
| `chore:` / `refactor:` / `perf:` / `style:` | 优化 |

3. **生成更新日志条目并插入 README**，格式为：

```markdown
### vX.Y.Z (当天日期)

#### 新增
- feat 类提交的简要描述

#### 修复
- fix 类提交的简要描述

#### 优化
- chore/refactor/perf/style 类提交的简要描述
```

4. **插入位置**：在 `## 更新日志` 行之后，已有版本条目之前。

### Step 3：检测完整性（可选但建议）

```bash
npm run check
```

### Step 4：生成详细 Commit 并推送至 GitHub

**禁止使用泛化 commit message**（如 `chore: bump version`），必须基于实际代码变更生成详细描述。

1. **对比变更内容**，获取自上一版本 Tag 以来的文件差异：

```bash
# 查看变更文件列表
git diff --stat <上一个Tag>..HEAD

# 查看具体代码变更（重点关注函数/方法的增删改）
git diff <上一个Tag>..HEAD -- '*.rs' '*.tsx' '*.ts'
```

2. **分析变更并生成 commit 标题和正文**：

   - **标题**（subject）：`chore: release vX.Y.Z`，不超过 72 字符
   - **正文**（body）：按以下结构详细描述本版本所有代码变更：

   ```
   chore: release vX.Y.Z

   ### 新增
   - <文件名>: 新增 <函数/组件/模块名> — <功能简述>

   ### 修改
   - <文件名>: <函数/组件/模块名> — <改动说明>
   ```

   - 仅列出有实际代码变更的文件和函数（排除配置、版本号等非功能性文件）
   - 优先关注 `src/`、`src-tauri/src/` 下的 `.rs`、`.tsx`、`.ts` 源码文件
   - 每个条目一句话，精炼表达改动内容

3. **提交并推送至 GitHub**：

```bash
git add -A
git commit -m "chore: release vX.Y.Z" -m "<详细正文>"
git tag vX.Y.Z
git push origin main --tags
```

> **注意**：默认推送到 `origin`（GitHub），如需推送到其他远端请在指令中指定。

推送 Tag 后，GitHub Actions（`.github/workflows/release.yml`）会自动：
1. 并行构建 macOS ARM64 DMG 和 Windows NSIS EXE
2. 创建 GitHub Release 并上传安装包

### Step 5：（首次或密钥更换时）配置更新器签名

若 `src-tauri/tauri.conf.json` 中 `plugins.updater.pubkey` 为空：

```bash
pnpm tauri signer generate -w ~/.tauri/mirageink.key
```

将输出的**公钥**填入 `tauri.conf.json` 的 `pubkey` 字段，**私钥**配置到 GitHub Secrets（`TAURI_PRIVATE_KEY`），并在 workflow 的构建步骤中加入 `--sign` 参数。

## 重要规则

1. **绝不跳过版本号同步**：版本号在 6 个位置硬编码，任一遗漏会导致更新检测失效或版本显示不一致。
2. **Tag 格式**：使用 `vX.Y.Z` 格式（带 `v` 前缀），这是 GitHub Actions 工作流的触发条件。
3. **先更新版本号再打 Tag**：确保 Tag 指向的 commit 已包含版本号更新。
4. **release.yml 的 workflow_dispatch 默认值**：此值仅影响手动触发时的预填值，不影响自动触发流程，但仍建议保持同步。
5. **`Cargo.lock` 不需要手动修改**：`cargo build` 时会自动同步版本号。

## 参考文档

- 版本号分布详情：`references/version_locations.md`
