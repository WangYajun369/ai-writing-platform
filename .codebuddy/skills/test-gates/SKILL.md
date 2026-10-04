---
title: "TimeWrite 四项测试门禁"
summary: "MirageInk 项目提交前全量验证：tsc + check.mjs + cargo test + vitest，含本机环境坑位"
agent_created: true
read_when:
  - 提交代码前验证
  - 修改了 Rust 或前端代码需要回归
---

# TimeWrite 四项测试门禁（提交前必跑）

## 四项命令（全部通过才算绿）

```bash
# 1. TypeScript 类型检查（需先加载 nvm）
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
npx tsc --noEmit

# 2. 完整性断言（约 205 项，含文件存在性/版本号/契约一致性）
node scripts/check.mjs

# 3. Rust 全量测试（cargo 不在 PATH，必须全路径）
cd src-tauri && ~/.cargo/bin/cargo test

# 4. 前端测试
pnpm test   # 等价 npx vitest run
```

## 环境坑位（实测踩过）

1. **cargo 不在 PATH**：非登录 shell 找不到 cargo，用 `~/.cargo/bin/cargo` 全路径；check.mjs 会因此跳过 cargo check（仅警告）。
2. **vitest worker 启动偶发超时**：forks/threads 池在本环境都可能 "Timeout waiting for worker to respond"。稳定兜底：`npx vitest run --maxWorkers=1`（慢，~100s，spawn ~26s/文件，但必过）。
3. **cargo test 只接受一个过滤器**：`cargo test service::task_service commands::ai` 报错；要全量跑或分两次。
4. **sed -i '' 在本 zsh 环境报错**：批量替换用 `perl -pi -e`。
5. **pnpm install 沙箱写全局 store 被拒**：需前台提权执行（dangerouslyDisableSandbox）。
6. **长命令前台会被 SIGTERM（exit 137）**：cargo test / vitest 用 run_in_background 跑，日志重定向到 /tmp 再读。
7. **git commit 多行 -m 正文用单引号**：双引号内 \" 转义会被 zsh 拆成多行命令报错。

## 基准值（2026-10-03）

- cargo test: 86/86
- check.mjs: 220 通过 / 0 失败（含版本号一致性 10 项 + 窗口能力覆盖 5 项）
- vitest: 37/37（version 14 / tauri-bridge 10 / uiAtoms 5 / taskCardsHierarchy 4 / preferencesStore 4）
- tsc: 0 错误

## 门禁的两组「防漂移」断言（改这两类东西时注意）

1. **版本号一致性**：以 `package.json` 为唯一真源，比对 9 个引用点（tauri.conf.json / Cargo.toml / README 表格 + 当前版本行 + 亮点行 / docs/Home.md / 宣传页 Hero + 页脚 / release.yml）。发版后必须 `pnpm check`，否则漏改会被 CI 前发现不了。
2. **窗口能力覆盖**：`capabilities/updater.json` 必须存在且授予 `updater:default` 并仅限 `main` 窗口；`sub-windows.json` 必须覆盖 debug / diary-book。历史教训：缺 capability 会让插件 API 被权限层拒绝而**静默降级**（调试控制台事件流失效、应用内更新失效），不会报错，极难发现。

## Tauri capability 权限名校验技巧

改 capability 后想确认权限名合法：先故意写个非法名（如 `updater:bogus-permission`）跑 `cargo check`，报错信息会列出该插件全部合法权限；确认后再改回。比翻文档可靠。
