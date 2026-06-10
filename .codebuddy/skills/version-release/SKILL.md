---
name: version-release
description: TimeWrite 项目版本发布技能。当用户需要发布 GitHub Releases、更新版本号、bump 版本、提交代码到仓库、推送代码到远程仓库、或对项目进行发版时使用。触发词包括：发布大版本、发布新功能版本、发布优化版本、发布补丁版本、重置当前版本、提交代码到仓库、推送到远程仓库、发版、bump version、release、tag、commit、push 等。
---

# TimeWrite 版本发布

## Overview

该技能负责 TimeWrite（Tauri v2 + React 19 + TypeScript）项目的版本号管理和 GitHub Releases 发布流程。版本号在项目中分布于 **5 个文件**，必须全部同步更新。

## 项目信息

| 项目 | 值 |
|------|------|
| 应用名称 | TimeWrite（智写时光） |
| 应用标识 | `com.ukcoder.timewrite` |
| 包管理器 | pnpm >= 9 |
| Node | >= 20 |
| GitHub 仓库 | `github.com:WangYajun369/ai-writing-platform.git` |
| 发布分支 | `main`（稳定/发版分支，严禁直接开发） |
| 开发分支 | `dev`（日常开发，所有功能在此迭代） |
| 版本号来源 | `src-tauri/tauri.conf.json`（前端运行时唯一版本来源） |

## 分支策略（重要）

项目采用严格的 **`dev` → `main`** 双分支协作模型：

```
dev 分支（日常开发———频繁提交）         main 分支（发布分支———仅发版时操作）
  │                                        │
  ├── feat: 新功能A                       │ ← 从不直接在此开发
  ├── fix: 修复B                          │
  ├── refactor: 重构C                     │
  │                                        │
  ├── git push origin dev                │
  │                                        │
  └──── git checkout main ────→           │
        git merge dev                      │
        （Step 1-4 在此执行）              ├── bump version + CHANGELOG
                                           ├── git tag vX.Y.Z
                                           └── git push origin main --tags
                                                  │
                                                  └── GitHub Actions 自动构建 & 发布
```

**核心原则**：
- `dev` 分支 = 日常开发，随意提交，随时推送
- `main` 分支 = 仅发版时操作（merge dev → bump version → tag → push），**严禁直接在上面写代码**
- 版本号更新、打 Tag 永远在 `main` 分支上执行
- CHANGELOG 汇总 `dev` 分支自上一版本 Tag 以来的所有提交

## 触发场景

| 用户命令 | 操作 | 执行分支 | 示例 |
|---------|------|---------|------|
| 发布大版本 | major bump | `main`（先 merge dev） | 0.1.0 → 1.0.0 |
| 发布新功能版本 | minor bump | `main`（先 merge dev） | 0.1.0 → 0.2.0 |
| 发布优化版本 / 发布补丁版本 | patch bump | `main`（先 merge dev） | 0.1.0 → 0.1.1 |
| 重置当前版本 | set 指定版本 | `main` | 重置为 0.5.0 |
| 提交代码到仓库 | git add + commit（仅本地） | `dev`（默认） | 暂存并提交，不推送远端 |
| 推送到远程仓库 | git push | `dev`（默认） | 推送当前分支到 origin |

> **注意**：版本发布类操作（bump/tag/push main）一定要在 `main` 分支执行！如果还在 `dev` 分支，执行前必须先合并。

## 发版完整流程（Step 0 ～ Step 4）

以下为一次完整版本发布的全部步骤。

---

### Step 0：本地预检 + 确认分支状态并执行合并

> ⚠️ **此步骤是发版的前置条件，必须最先执行！**

#### 0.1 本地质量门禁（在 `dev` 分支执行）

> `pnpm check` 已包含 TypeScript 类型检查（`tsc --noEmit`），能在本地提前发现编译错误，避免 CI 构建失败。

```bash
# 在 dev 分支上，先确保代码质量通过
pnpm check
# 必须全部 ✅ 通过，exit code = 0，否则禁止继续发版
```

#### 0.2 确认分支状态并合并

```bash
# 1. 查看当前分支（确认结果符合预期）
git branch --show-current

# 2. 查看各分支状态
git --no-pager log --oneline -3 main
git --no-pager log --oneline -3 dev
```

**场景 A：当前在 `dev` 分支，需要切到 `main` 发版**

```bash
# 确保 dev 分支所有变更已提交
git status                    # 应显示 clean
git push origin dev           # 先推送 dev 到远端

# 切换到 main 并合并 dev
git checkout main
git pull origin main          # 确保 main 是最新的
git merge dev                 # 将 dev 的变更合并到 main

# 解决可能的冲突后，确认合并结果
git --no-pager log --oneline -5
```

**场景 B：当前已在 `main` 分支，尚未合并 dev**

```bash
git merge dev                 # 先合并 dev 的最新变更
```

**场景 C：确认 main 已包含所有 dev 变更**

```bash
# 检查 dev 是否完全合并到 main
git branch --merged main | grep dev    # 如果 dev 在列表中，说明已完全合并
```

> **注意**：合并完成后，所有后续发版操作（Step 1-4）均在 `main` 分支上执行。

---

### Step 1：更新版本号

> 📍 **执行分支**：`main`

使用 `scripts/bump_version.py` 脚本自动更新所有 **5 个文件**中的版本号，并自动在 `docs/CHANGELOG.md` 中插入新版本条目头部：

```bash
# 项目根目录下执行（支持 --dry-run 预览模式）
python3 .codebuddy/skills/version-release/scripts/bump_version.py major     # 大版本
python3 .codebuddy/skills/version-release/scripts/bump_version.py minor     # 新功能
python3 .codebuddy/skills/version-release/scripts/bump_version.py patch     # 优化/补丁
python3 .codebuddy/skills/version-release/scripts/bump_version.py set 0.5.0 # 重置

# 预览模式：仅显示将更新哪些文件，不实际写入
python3 .codebuddy/skills/version-release/scripts/bump_version.py patch --dry-run
```

该脚本自动更新的 5 个文件：
- `package.json`（JSON 字段 `version`）
- `src-tauri/Cargo.toml`（TOML 字段 `package.version`）
- `src-tauri/tauri.conf.json`（JSON 字段 `version`，**前端运行时唯一版本来源**）
- `README.md`（应用信息表格中的版本号）
- `.github/workflows/release.yml`（workflow_dispatch 默认值）

额外操作：
- **bump（major/minor/patch）**：自动在 `docs/CHANGELOG.md` 的 `# 更新日志` 后插入 `## vX.Y.Z (YYYY-MM-DD)` 新版本条目头部
- **set（重置版本）**：自动同步 `docs/CHANGELOG.md` 中已存在的对应版本标题

> **注意**：更新日志的具体内容（新增/修复/优化条目）由 Step 2 基于 git log 生成填充，`bump_version.py` 仅插入版本标题头部。

---

### Step 2：自动生成 CHANGELOG 更新日志内容

> 📍 **执行分支**：`main`

基于 git log 生成更新日志内容，填充到 `docs/CHANGELOG.md` 中 Step 1 刚插入的版本条目头部下方。

1. **获取上一版本 Tag 以来的所有提交记录**：

```bash
# 方式一：从上一版本 Tag 到 HEAD（推荐，精确获取本版本变更）
git log <上一个Tag>..HEAD --format="%h %s"
# 例如: git log v0.5.0..HEAD --format="%h %s"

# 方式二：如果上一版本 Tag 找不到（首次发版）
git log --format="%h %s"

# 方式三：如果需要看 dev 分支独有的提交（main 上 merge 后也可以看）
git log main --not <上一个Tag> --format="%h %s"
```

> 由于发版前已执行 `git merge dev`，此时 HEAD 包含了 dev 分支所有变更，上述命令能正确覆盖本版本所有新增提交。

2. **按提交类型分类**，识别 conventional commits 前缀：

| 前缀 | 分类 |
|------|------|
| `feat:` / `feat(*):` | 新增 |
| `fix:` / `fix(*):` | 修复 |
| `chore:` / `refactor:` / `perf:` / `style:` | 优化 |

> 无明确前缀的提交归入「优化」分类。

3. **生成更新日志内容并写入 CHANGELOG.md**，格式与现有条目保持一致：

```markdown
## vX.Y.Z (当天日期)

### 新增
- feat 类提交的简要描述（去掉 feat: 前缀，精炼为一句话）

### 修复
- fix 类提交的简要描述（去掉 fix: 前缀，精炼为一句话）

### 优化
- chore/refactor/perf/style 类提交的简要描述
```

4. **填充位置**：紧贴在 Step 1 插入的 `## vX.Y.Z (日期)` 行之后、下一个已有版本条目之前。

5. **若无某类提交**（如没有 fix 类），则省略该分类标题。

---

### Step 3：检测完整性（建议）

> 📍 **执行分支**：`main`

```bash
pnpm check
```

---

### Step 4：生成详细 Commit 并推送至 GitHub

> 📍 **执行分支**：`main`
> ⚠️ **再次确认**：此时必须在 `main` 分支！`git branch --show-current` 应输出 `main`。

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

3. **提交、打 Tag 并推送至 GitHub**：

```bash
git add -A
git commit -m "chore: release vX.Y.Z" -m "<详细正文>"
git tag vX.Y.Z
git push origin main --tags
```

> **注意**：推送目标必须为 `main` 分支。Tag 推送后 GitHub Actions（`.github/workflows/release.yml`）会自动触发构建和发布流程。

推送 Tag 后，GitHub Actions 会自动：
1. 并行构建 macOS ARM64 DMG 和 Windows NSIS EXE
2. 创建 GitHub Release 并上传安装包
3. 生成 `latest.json` 用于应用内自动更新检测

---

### Step 5：（首次或密钥更换时）配置更新器签名

> 📍 **执行分支**：不限

若 `src-tauri/tauri.conf.json` 中 `plugins.updater.pubkey` 为空：

```bash
pnpm tauri signer generate -w ~/.tauri/timewrite.key
```

将输出的**公钥**填入 `tauri.conf.json` 的 `pubkey` 字段，**私钥**配置到 GitHub Secrets（`TAURI_PRIVATE_KEY`），并在 workflow 的构建步骤中加入 `--sign` 参数。

---

### Step 6：推送到远程仓库（独立推送）

> 📍 **执行分支**：`dev`（默认，自动检测当前分支）

适用于无需版本发布、仅推送本地提交到远程仓库的场景。通常在 `dev` 分支日常开发后使用。

1. **检查当前分支状态**：

```bash
git status
git --no-pager log --oneline -5
```

2. **确认远近端关系**：

```bash
git remote -v

# 查看本地与远端差异
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git --no-pager log --oneline origin/$BRANCH..$BRANCH   # 待推送的提交
```

> 默认远端为 `origin`（GitHub: `github.com:WangYajun369/ai-writing-platform.git`）。

3. **执行推送**（自动识别当前分支）：

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 推送到远端（如果是 dev 分支，推送 dev；如果是 main，推送 main）
git push origin $BRANCH

# 若需同时推送 Tag（通常在发版后用）
git push origin $BRANCH --tags
```

> **注意**：确保本地提交已就绪，推送后不可撤销。如果远端有新提交，先执行 `git pull --rebase origin $BRANCH`。

4. **推送后确认**：

```bash
git --no-pager log --oneline origin/$(git rev-parse --abbrev-ref HEAD) -5
```

---

### Step 7：提交代码到仓库（仅本地提交）

> 📍 **执行分支**：`dev`（默认，日常开发场景）

适用于仅将代码变更提交到本地仓库、**不推送远端**的场景。后续可单独执行 Step 6 推送。

1. **查看当前变更**：

```bash
git status
git --no-pager diff --stat
```

2. **暂存所有变更**：

```bash
git add -A
```

> 如需选择性暂存，使用 `git add <文件路径>` 逐个添加。

3. **分析代码变更**（核心步骤）：

> 此步骤是生成优质 commit message 的关键，必须深入分析实际 diff 内容，而非仅看文件名。

```bash
# 查看变更文件列表
git --no-pager diff --stat

# 查看具体代码变更（关注函数/方法的增删改）
git --no-pager diff -- '*.rs' '*.tsx' '*.ts' '*.css'
```

基于 diff 输出，逐一分析每个文件的改动意图：
- 新增了什么功能/组件/模块？
- 修复了什么 Bug/问题？
- 重构/优化了哪部分逻辑？

4. **生成 Commit Message 并提交**：

**禁止使用泛化 commit message**（如 `chore: update`、`fix: bug`），必须基于第 3 步的 diff 分析结果撰写。

Commit Message 结构（Conventional Commits）：

```bash
git commit -m "<type>: <简要标题>" -m "<详细正文>"
```

| 前缀 | 适用场景 |
|------|---------|
| `feat:` | 新增功能/组件/页面 |
| `fix:` | 修复 Bug |
| `chore:` | 配置/依赖/构建等杂项 |
| `refactor:` | 重构代码（不改变功能） |
| `perf:` | 性能优化 |
| `style:` | 代码格式调整（不影响逻辑） |

**标题**（subject）规范：
- 不超过 72 字符
- type 后紧跟中文冒号，空一格后写描述
- 示例：`feat: 新增文章导出 PDF 功能`

**正文**（body）规范：
- 逐条列出本次改动涉及的文件和具体变更内容
- 格式：`- <文件名>: <具体改动说明>`
- 示例：
  ```
  - src/components/ExportButton.tsx: 新增 handleExportPDF 方法，调用 Tauri 后端导出
  - src-tauri/src/export.rs: 实现 generate_pdf 命令，基于 printpdf 生成 PDF
  - src/App.css: 新增 .export-btn 样式
  ```

5. **提交后确认**：

```bash
git --no-pager log --oneline -3
```

> ⚠️ **仅执行 `git commit`，不执行 `git push`**。如需推送远端，使用「推送到远程仓库」命令。

---

## 日常开发与发版完整示例

### 日常开发（在 `dev` 分支）

```bash
# 1. 切到 dev 分支
git checkout dev
git pull origin dev          # 拉取最新代码

# 2. 写代码...

# 3. 提交（Step 7）
git add -A
git commit -m "feat: 新增某功能" -m "...详细正文..."

# 4. 推送 dev 分支（Step 6）
git push origin dev
```

### 发布版本（在 `main` 分支）

```bash
# 0. Step 0.1：本地预检（在 dev 分支，提交后）
pnpm check                   # 含 tsc --noEmit，必须全部通过

# 1. Step 0.2：合并 dev 到 main
git checkout main
git pull origin main
git merge dev

# 2. Step 1：bump 版本号
python3 .codebuddy/skills/version-release/scripts/bump_version.py minor

# 3. Step 2：AI 生成 CHANGELOG 内容，填充到 docs/CHANGELOG.md

# 4. Step 3：完整性检查
pnpm check

# 5. Step 4：提交、打 Tag、推送
git add -A
git commit -m "chore: release vX.Y.Z" -m "<详细正文>"
git tag vX.Y.Z
git push origin main --tags
```

### 发版后切回 dev 继续开发

```bash
# 将 main 的版本号更新同步回 dev
git checkout dev
git merge main               # 将发版 commit 同步到 dev
git push origin dev
```

---

## 重要规则

1. **绝不跳过版本号同步**：版本号在 **5 个文件**中硬编码，任一遗漏会导致更新检测失效或版本显示不一致。
2. **Tag 格式**：使用 `vX.Y.Z` 格式（带 `v` 前缀），这是 GitHub Actions 工作流的触发条件。
3. **先更新版本号再打 Tag**：确保 Tag 指向的 commit 已包含版本号更新。
4. **release.yml 的 workflow_dispatch 默认值**：此值仅影响手动触发时的预填值，不影响自动触发流程，但仍建议保持同步。
5. **`Cargo.lock` 不需要手动修改**：`cargo build` 时会自动同步版本号。
6. **CHANGELOG 格式统一**：使用 `## vX.Y.Z (YYYY-MM-DD)` 格式（与现有条目一致），`bump_version.py` 会自动插入。
7. **版本号运行时动态读取**：前端页面通过 `getVersion()` 从 `tauri.conf.json` 自动获取，无需手动更新前端代码。
8. **发版永远在 `main` 分支**：版本号更新、CHANGELOG 生成、打 Tag 等操作严禁在 `dev` 分支执行。
9. **发版后同步 dev**：`main` 发版完成后，执行 `git checkout dev && git merge main` 将版本号更新同步回 dev。
10. **`dev` 分支不包含版本号更新和 Tag**：dev 上的版本号可能与 main 不同步（main 发版后 version 更新了），这是正常的——下次发版 merge 时会自动对齐。

## 参考文档

- 版本号分布详情：`references/version_locations.md`
