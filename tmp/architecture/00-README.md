# MirageInk 架构文档

> [!CAUTION]
> **⚠️ 本文档为历史设计草案，不代表当前代码现状。**
>
> 本系列文档（01–13）与 `tmp/Tauri + React + RTK + MVVM.md` 是 **v0.1.0 之前的技术选型与架构设想**，
> 其中关键设计与实际实现**已不一致**：
>
> | 维度 | 本文档的设想 | 实际实现（v1.0.0） |
> |------|-------------|-------------------|
> | 前端状态管理 | Redux Toolkit（RTK Slice） | **Zustand（业务）+ Jotai（UI）**，见 [ADR-003](../../docs/architecture/adr/ADR-003-dual-state-management.md) |
> | 前端架构模式 | MVVM（ViewModel / Binder） | 组件 + Hooks，无独立 ViewModel 层 |
> | 后端分层 | Clean Architecture（UseCase / Domain） | commands / service / repository / db 四层 |
> | 离线冲突解决 | 字段级 LWW 合并 | 未实现（本地优先，无多端同步） |
>
> **请以 `docs/` 下的文档为准**：
> [架构总览](../../docs/architecture/overview.md) ·
> [代码架构深度分析](../../docs/architecture/code-architecture.md) ·
> [文档地图](../../docs/DOC-INDEX.md)
>
> 保留理由：记录了早期的技术选型推演过程，对理解演进历史有价值。
> 如无参考价值，可整体删除本目录。

## 阅读指南

本系列文档由总体架构概览文档派生而来，按关注点拆分为 13 个专题，供不同角色按需阅读。

### 文档索引

| 编号 | 文档                         | 关注点                           | 目标读者           |
| ---- | ---------------------------- | -------------------------------- | ------------------ |
| 01   | 总体架构设计                 | 技术选型、分层、核心原则         | 全员               |
| 02   | MVVM 分层详解                | 前端 RTK + 后端 Clean Architecture + 统一错误处理 | 全栈开发者       |
| 03   | 多窗口 Store 隔离与状态管理  | 窗口隔离、Store 生命周期         | 前端开发者         |
| 04   | 事件系统与跨窗口通信         | Event 规范、去重、防抖、RPC      | 前后端开发者       |
| 05   | Python AI 扩展架构           | FastAPI、LangChain、进程管理、错误传播协议 | AI/后端开发者      |
| 06   | 安全架构设计                 | 认证、授权、数据保护、IPC 安全   | 架构师、后端开发者 |
| 07   | 并发控制与数据一致性         | 锁策略、并发模型、一致性保证     | 架构师、后端开发者 |
| 08   | 事务管理与乐观更新           | SQLite 事务、乐观更新、回滚      | 前后端开发者       |
| 09   | 离线缓存与冲突解决           | 离线优先、冲突合并策略           | 全栈开发者         |
| 10   | 测试策略                     | 测试金字塔、E2E 方案             | 全员               |
| 11   | CI/CD 持续集成与交付         | 多平台构建、签名公证、自动发布   | 架构师、DevOps     |
| 12   | 可观测性与数据埋点           | 三层埋点、日志轮转、远程上报、隐私 | 全栈开发者         |
| 13   | 团队协作与开发规范           | 数据协议、事件协议、交互流程、代码规范、质量监督、ADR 模板 | 全员               |

### 阅读路径建议

```
入门路径: 01 → 02 → 03 → 04 → 08
全栈路径: 01 → 02 → 04 → 05 → 08 → 09
架构师路径: 01 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13
安全审计: 06 → 07 → 08
AI 专项: 05
发布运维: 11
可观测性: 12
团队协作: 13
```

### 术语约定

| 术语              | 含义                           |
| ----------------- | ------------------------------ |
| 真理源 (Source of Truth) | SQLite in Rust，唯一数据权威 |
| ViewModel        | RTK Slice，每窗口独立          |
| Binder           | Selector + Hook，View ↔ VM 桥接 |
| DTO              | Data Transfer Object，跨层传递的数据结构 |
| Bridge           | Rust 侧 HTTP 服务，Python 通过它回读 Rust 数据（Auth Token 保护，见 05/06） |
| 字段级 LWW       | 离线冲突按字段独立比较时间戳合并，非整行覆盖（详见 09） |
| Command Handler  | Tauri IPC 处理函数，解析参数并路由到 UseCase |
| UseCase          | 领域用例，编排 Domain + Repository |

### 项目仓库

- 路径：`/Users/wangyajun/Documents/公众号文章/时光智读-个人/MirageInk`
- 主文档：`tmp/Tauri + React + RTK + MVVM.md`
