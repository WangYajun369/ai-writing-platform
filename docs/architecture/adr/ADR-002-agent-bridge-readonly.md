# ADR-002：Python Agent 经 Bridge 只读回调，不直连 SQLite（已废弃）

> **状态**：已废弃（superseded）
>
> v1.1 起 Python Agent 已迁移为 **Rust 原生引擎**（`src-tauri/src/commands/agent/`），
> tiny_http Bridge（9876）与 Python 子进程（9877）整体删除，数据访问改为引擎内
> repository 层直查 SQLite（单进程模型，无写锁竞争）。本 ADR 仅作 v1.0 历史决策记录。
> **日期**：2026-08-XX（v1.0.0）
> **影响范围**：Agent 进程 / 数据层

## 背景

v1.0.0 引入 Python Agent 子系统（LangGraph ReAct），需要访问用户的章节与世界观数据。这带来一个新的架构问题：**SQLite 将同时被 Rust 主进程与 Python 子进程访问**。

SQLite 虽支持多进程访问，但需要处理：

- 写锁竞争（`SQLITE_BUSY`）
- WAL 模式下的 `-wal` / `-shm` 文件跨进程同步
- 事务隔离与崩溃恢复的一致性

## 备选方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. Python 直连 SQLite（只读 + 自己的写表） | 实现简单，无网络开销 | 写锁竞争、WAL 跨进程同步风险、数据一致性难保证 |
| B. Rust 暴露 Bridge HTTP 服务，Python 只读回调 | 写操作唯一入口仍在 Rust，无锁竞争 | 多一跳 HTTP 开销（本机回环，约 1ms 级） |
| C. 通过 stdin/stdout IPC 管道通信 | 无端口占用，无网络栈 | 协议需自行设计，流式与并发处理复杂 |
| D. 数据全量通过请求参数传入 | 最简单 | 数据量受限，长章节无法承载 |

## 决策

采用**方案 B**：Rust 侧 `python/bridge.rs` 启动 tiny_http 服务监听 `127.0.0.1:9876`，暴露 `read_chapter` / `list_chapters` / `search_world_cards` / `book_context` 四个只读路由；Python 侧 `tools/db_tools.py` 通过 httpx 回调获取数据。**Python 进程永不直接打开 SQLite 连接。**

## 理由

1. **数据主权单一**：所有写操作的唯一入口始终在 Rust，事务边界与 `service/` 层的 `emit_sql_log` 审计得以完整保留
2. **杜绝锁竞争**：Python 只读不写，从根本上消除多进程写 SQLite 的 `SQLITE_BUSY` 与一致性风险
3. **开销可接受**：本机回环 HTTP 延迟在毫秒级，相对 LangGraph 的 LLM 推理耗时（秒级）可忽略
4. **解耦部署**：Python 进程崩溃不影响数据库连接；看门狗可安全重启子进程而无需考虑连接状态
5. **可测试性**：Bridge 是纯 HTTP 接口，便于用 curl 单独验证

## 后果

### 正面

- 数据库一致性得到结构性保障，无需引入跨进程锁机制
- Agent 崩溃 / 重启对数据层零影响
- 工具链可根据 Skill 定制，配合请求级 LRU 缓存（32 条 / TTL 300s）控制重复请求

### 负面 / 代价

- 多一跳 HTTP，需要额外的重试与诊断逻辑（`_is_bridge_connection_error` + 3 次指数退避）
- Bridge 端口 9876 硬编码在 CSP 与多处配置中，改端口需同步修改
- 增加了进程间故障面：Bridge 未就绪会导致 Agent 工具调用失败

### 需要 follow-up 的事项

- **Bridge 当前无鉴权**：任何本机进程可读取全部作品内容。建议启动时生成随机 Token 写入临时文件，Python 侧置于 `Authorization` 头（见 [优化报告](meta/optimization-report) 问题 27）
- 端口 9876 / 9877 硬编码，建议改为 Rust 动态分配空闲端口后注入 Python 环境变量（问题 30）
- `/skills/cancel` 为占位实现，无法真正中断任务（问题 28）
