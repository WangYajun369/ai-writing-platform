# ADR-001：采用 Tauri v2 + Rust 后端承载数据与 AI 通信

> **状态**：已采纳
> **日期**：2026-06-03（v0.1.0）
> **影响范围**：全局

## 背景

TimeWrite 是面向小说作者的桌面写作工具，需要满足：

1. **本地优先**：作品数据必须存储在用户本机，不依赖云端
2. **大文本性能**：单部小说可达数百万字，需要高效的全文检索与持久化
3. **AI 流式通信**：需要与多家 LLM 服务商建立长连接 SSE 流式通信
4. **跨平台**：至少覆盖 macOS 与 Windows
5. **体积与启动速度**：相比 Electron 应有明显优势

## 备选方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. Electron + Node 后端 | 生态成熟、开发快 | 体积大（100MB+）、内存占用高、SQLite 需原生模块编译 |
| B. Tauri v2 + Rust 后端 | 体积小、内存低、Rust 原生 SQLite/reqwest、系统 WebView | Rust 学习曲线陡、部分生态需自行实现 |
| C. 纯前端 + IndexedDB | 开发最简单 | 大文本性能差、全文检索能力弱、无原生文件系统访问 |
| D. Tauri + 前端直连 AI API | 少一层转发 | 浏览器 CORS 限制、流式解析不稳、API Key 暴露在前端 |

## 决策

采用 **Tauri v2 + Rust 后端**，SQLite 由 Rust 独占管理，所有 AI 的 HTTP/SSE 通信在 Rust 侧通过 `reqwest` 完成，前端仅通过 IPC 与事件交互。

## 理由

1. **体积与性能**：系统 WebView 替代 Chromium，包体积与内存占用远低于 Electron
2. **数据主权**：SQLite 在 Rust 侧独占，配合 r2d2 连接池与 WAL 模式，天然适合大文本与并发读写
3. **规避 CORS**：AI 流式请求若放前端，会被服务商的 CORS 策略阻断（多数 LLM API 不允许浏览器直连）。Rust 侧发起请求无此限制
4. **API Key 安全**：密钥不进入 WebView 渲染进程，减少泄露面
5. **FTS5 全文检索**：SQLite 原生支持，无需引入额外检索引擎

## 后果

### 正面

- 安装包体积与内存占用显著低于 Electron 方案
- 流式 AI 响应稳定，不受浏览器策略影响
- 全文本地检索能力开箱即用

### 负面 / 代价

- Rust 开发门槛高于 Node，团队需具备 Rust 能力
- IPC 边界带来额外的序列化开销，需要 `tauri-bridge.ts` 统一封装以控制复杂度
- 某些前端生态能力（如 Service Worker）在 Tauri 中不可用

### 需要 follow-up 的事项

- ~~updater `pubkey` 未配置~~ —— ✅ 已修复（2026-08-31）：已生成 minisign 签名密钥对，公钥已填入 `tauri.conf.json`；CI 需配置 `TAURI_PRIVATE_KEY` 与 `TAURI_PRIVATE_KEY_PASSWORD` 两个 Secret
- ~~`withGlobalTauri: true`~~ —— ✅ 已修复（2026-08-31）：已设为 `false`（前端零使用 `window.__TAURI__`）
