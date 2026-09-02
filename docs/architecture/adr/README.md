# 架构决策记录（ADR）

> **最后更新**：2026-08-31

ADR（Architecture Decision Record）用于记录 TimeWrite 中**具有长期影响的技术决策**：我们决定了什么、为什么这么决定、以及随之而来的取舍。

---

## 什么是「值得记录」的决策

满足以下任一条即应写 ADR：

- 影响多个模块或跨进程边界
- 一旦实施难以逆转（更换框架、数据模型、通信协议）
- 存在多个合理备选方案，需要说明为何选此弃彼
- 后续维护者会反复追问「为什么是这样」

**不需要**写 ADR 的：函数级实现选择、命名约定、纯偏好问题。

---

## 决策索引

| 编号 | 标题 | 状态 | 影响范围 |
|------|------|------|---------|
| [ADR-001](architecture/adr/ADR-001-tauri-rust-backend) | 采用 Tauri v2 + Rust 后端承载数据与 AI 通信 | 已采纳 | 全局 |
| [ADR-002](architecture/adr/ADR-002-agent-bridge-readonly) | Python Agent 经 Bridge 只读回调，不直连 SQLite | 已废弃（v1.1 迁 Rust 原生） | Agent / 数据层 |
| [ADR-003](architecture/adr/ADR-003-dual-state-management) | Zustand 管业务状态 + Jotai 管 UI 瞬态 | 已采纳 | 前端 |

**状态取值**：`提议` / `已采纳` / `已废弃` / `已被取代（ADR-00X）`

---

## 命名与存放

- 位置：`docs/architecture/adr/`
- 命名：`ADR-<三位序号>-<简短英文标识>.md`，如 `ADR-004-epub-export.md`
- 编号**只增不复用**：即使 ADR 被废弃，编号也保留，用「已被取代」指向新 ADR

---

## 模板

```markdown
# ADR-00X：<决策标题>

> **状态**：提议 | 已采纳 | 已废弃 | 已被取代（ADR-00Y）
> **日期**：YYYY-MM-DD
> **影响范围**：模块 / 进程 / 全局

## 背景

<要解决的问题是什么？约束条件有哪些？当时的上下文是什么？>

## 备选方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. …… | | |
| B. …… | | |
| C. …… | | |

## 决策

<最终选择了哪个方案，一句话说清。>

## 理由

<为什么选它？核心考量是什么？哪些约束起了决定性作用？>

## 后果

### 正面

- ……

### 负面 / 代价

- ……

### 需要 follow-up 的事项

- ……
```

---

## 与 Wiki 的关系

`docs/` 下的文件会由 `.github/workflows/deploy-wiki.yml` 自动同步到 GitHub Wiki，子目录会被扁平化命名。因此本文件在 Wiki 中的页面名为 `architecture-adr-ADR-001-tauri-rust-backend` 等，内部链接由脚本自动转换。
