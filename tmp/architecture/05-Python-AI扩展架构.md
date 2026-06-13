# 05 — Python AI 扩展架构

## 5.1 设计动机

AI/LLM 生态集中在 Python 侧（LangChain、OpenAI SDK、Ollama、HuggingFace），Rust 在这些领域缺乏成熟绑定。通过将 Python 作为 **独立子进程的 AI 微服务**，实现最佳技术选型，同时保持核心架构原则不变。

## 5.2 进程模型

```
Tauri 主进程 (Rust)
    │
    ├─ spawn ─► Python 子进程 (uvicorn :9877)
    │               │
    │               ├─ /health              ← Rust 就绪检测
    │               ├─ /skills/execute      ← Rust 转发用户请求
    │               ├─ /skills/cancel       ← Rust 转发取消请求
    │               └─ /memory/*            ← Rust 转发记忆操作
    │
    ├─ Bridge (:9876, tiny_http)  ◄── Python 回调读取数据
    │
    └─ 状态推送 → 前端 (agent-status-changed)
```

## 5.3 Rust 侧进程管理

### 5.3.1 Manager 状态机

```
        ┌──────────┐
        │ Stopped   │
        └─────┬─────┘
              │ start_agent()
        ┌─────▼─────┐
        │ Starting  │──► 查找解释器 → 启动 uvicorn
        └─────┬─────┘
              │ 轮询 /health (500ms, 最长30s)
        ┌─────▼─────┐
        │ Running   │◄── 看门狗 10s 检查
        └──┬───┬───┬┘
           │   │   └── 崩溃 (retry ≤3) → Starting
           │   └── stop_agent() → Stopping
           │
        ┌──▼──────┐
        │ Stopping│──► SIGTERM → 10s → SIGKILL
        └─────────┘
```

### 5.3.2 核心实现

```rust
// python/manager.rs
pub struct PythonAgentManager {
    child: Option<Child>,
    port: u16,
    bridge_port: u16,
    restart_count: u32,
    status: AgentStatus,
    status_tx: tokio::sync::broadcast::Sender<AgentStatus>,
}

impl PythonAgentManager {
    /// 三级降级查找 Python 解释器
    fn find_python(&self) -> Result<PathBuf, AgentError> {
        // 1. 用户指定环境变量
        if let Ok(path) = std::env::var("MIRAGEINK_PYTHON") {
            let p = PathBuf::from(&path);
            if p.exists() { return Ok(p); }
        }
        // 2. 项目 .venv
        let venv_python = project_root().join(".venv/bin/python");
        if venv_python.exists() { return Ok(venv_python); }
        // 3. 系统 PATH
        which::which("python3")
            .or_else(|_| which::which("python"))
            .map_err(|_| AgentError::PythonNotFound)
    }

    /// 启动 Agent
    pub async fn start(&mut self, app: AppHandle) -> Result<(), AgentError> {
        self.set_status(AgentStatus::Starting, &app);

        let python = self.find_python()?;
        let child = Command::new(python)
            .args([
                "-m", "uvicorn",
                "agent.main:app",
                "--host", "127.0.0.1",
                "--port", &self.port.to_string(),
                "--log-level", "info",
            ])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| AgentError::SpawnFailed(e.to_string()))?;

        self.child = Some(child);

        // 就绪检测：轮询 /health
        self.wait_for_ready().await?;

        self.restart_count = 0;
        self.set_status(AgentStatus::Running, &app);

        // 启动看门狗
        self.start_watchdog(app.clone());

        Ok(())
    }

    async fn wait_for_ready(&self) -> Result<(), AgentError> {
        let client = reqwest::Client::new();
        let health_url = format!("http://127.0.0.1:{}/health", self.port);
        let deadline = Instant::now() + Duration::from_secs(30);

        loop {
            if Instant::now() > deadline {
                return Err(AgentError::StartupTimeout);
            }
            match client.get(&health_url).timeout(Duration::from_secs(2)).send().await {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                _ => tokio::time::sleep(Duration::from_millis(500)).await,
            }
        }
    }

    /// 看门狗：每 10s 检查健康，崩溃自动重启
    fn start_watchdog(&self, app: AppHandle) {
        let port = self.port;
        let mut status_rx = self.status_tx.subscribe();
        let max_restarts = 3;

        tokio::spawn(async move {
            let mut failures = 0u32;
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;

                // 检查是否仍在运行
                if !Self::check_health(port).await {
                    failures += 1;
                    if failures <= max_restarts {
                        tracing::warn!("Agent unhealthy, restart attempt {failures}/{max_restarts}");
                        // 触发重启逻辑
                    } else {
                        tracing::error!("Agent failed after {max_restarts} restarts");
                        break;
                    }
                } else {
                    failures = 0;
                }
            }
        });
    }
}
```

### 5.3.3 优雅关闭

```rust
impl PythonAgentManager {
    pub async fn stop(&mut self, app: &AppHandle) {
        self.set_status(AgentStatus::Stopping, app);

        if let Some(mut child) = self.child.take() {
            // SIGTERM
            #[cfg(unix)]
            {
                use nix::sys::signal::{kill, Signal};
                use nix::unistd::Pid;
                let _ = kill(Pid::from_raw(child.id() as i32), Signal::SIGTERM);
            }

            // 等待 10s
            let timeout = tokio::time::timeout(
                Duration::from_secs(10),
                child.wait()
            ).await;

            // 强制结束
            if timeout.is_err() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        self.set_status(AgentStatus::Stopped, app);
    }
}
```

## 5.4 Bridge 回调服务

### 5.4.1 为什么需要 Bridge

Python 不能直接访问 SQLite（违背单一真理源原则）。Bridge 是一个 Rust 侧的轻量 HTTP 服务，暴露只读接口供 Python 回调。

### 5.4.2 实现

```rust
// infrastructure/bridge.rs
use tiny_http::{Server, Response, Header};
use std::sync::Arc;

pub struct DataBridge {
    pool: Arc<r2d2::Pool<SqliteConnectionManager>>,
}

impl DataBridge {
    pub fn start(pool: Arc<r2d2::Pool<SqliteConnectionManager>>, port: u16) {
        let server = Server::http(format!("127.0.0.1:{port}"))
            .expect("Failed to start Bridge server");

        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let pool = pool.clone();
                match (request.method(), request.url()) {
                    (&tiny_http::Method::Post, "/agent/read_chapter") => {
                        let body = String::from_utf8(
                            request.as_reader().bytes().collect()
                        ).unwrap();
                        let result = Self::handle_read_chapter(&pool, &body);
                        let response = Response::from_string(result)
                            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
                        let _ = request.respond(response);
                    }
                    // ...其他端点
                    _ => {
                        let _ = request.respond(Response::from_string("Not Found")
                            .with_status_code(404));
                    }
                }
            }
        });
    }
}
```

## 5.5 模型路由

### 5.5.1 双层级路由

```
用户请求
    │
    ▼
SkillType: WRITING/ANALYSIS/RESEARCH → CLOUD (DeepSeek)
SkillType: POLISH                     → LOCAL (Ollama)
    │
    ▼
models/factory.py → 创建/缓存模型实例
```

### 5.5.2 Python 实现

```python
# models/router.py
from enum import Enum
from typing import Optional
from langchain_openai import ChatOpenAI
from langchain_ollama import ChatOllama

class ModelTier(Enum):
    LOCAL = "local"
    CLOUD = "cloud"

class SkillType(Enum):
    WRITING = "WRITING"
    ANALYSIS = "ANALYSIS"
    RESEARCH = "RESEARCH"
    POLISH = "POLISH"

# Skill → Model Tier 映射
SKILL_MODEL_MAP = {
    SkillType.WRITING:  ModelTier.CLOUD,
    SkillType.ANALYSIS: ModelTier.CLOUD,
    SkillType.RESEARCH: ModelTier.CLOUD,
    SkillType.POLISH:   ModelTier.LOCAL,
}

class ModelRouter:
    def __init__(self, config: ModelConfig):
        self.config = config
        self._cache: dict[str, ChatOpenAI | ChatOllama] = {}

    def get_model_for_skill(self, skill: SkillType, stream: bool = True):
        tier = SKILL_MODEL_MAP[skill]
        return self._get_or_create(tier, stream)

    def _get_or_create(self, tier: ModelTier, stream: bool):
        cache_key = f"{tier.value}_{stream}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        if tier == ModelTier.LOCAL:
            model = ChatOllama(
                model=self.config.local_model,    # "qwen2.5:7b"
                base_url=self.config.local_url,    # "http://127.0.0.1:11434"
                temperature=0.3,
                streaming=stream,
            )
        else:
            model = ChatOpenAI(
                model=self.config.cloud_model,     # "deepseek-chat"
                api_key=self.config.cloud_api_key,
                base_url=self.config.cloud_url,
                temperature=0.7,
                streaming=stream,
            )
        self._cache[cache_key] = model
        return model
```

## 5.6 Security Considerations for AI Extension

### 5.6.1 进程隔离

- Python 进程与 Rust 主进程完全隔离，崩溃不影响主应用
- 通过 `127.0.0.1` 绑定，不受外部网络访问
- Bridge 同样绑定 `127.0.0.1`，仅在本地环回

### 5.6.2 输入校验

```python
# server/routes.py
from pydantic import BaseModel, Field, validator

class SkillExecuteRequest(BaseModel):
    skill_type: SkillType
    book_id: str = Field(..., min_length=1, max_length=100)
    messages: list[Message] = Field(..., min_items=1, max_items=50)
    conversation_summary: Optional[str] = Field(None, max_length=5000)

    @validator('book_id')
    def validate_book_id(cls, v):
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError('Invalid book_id format')
        return v
```

### 5.6.3 API Key 保护

- API Key 存储在 Rust 侧加密存储（Keychain / Keyring）
- 通过环境变量或启动参数传递给 Python 子进程
- 不在 Python 配置文件中硬编码

### 5.6.4 Token 限制

- 单次请求 messages token 上限：32K
- SSE 流式输出速率：10 chunks/s
- 单次会话最大轮数：50
- Memory 注入 Token 上限：600

## 5.7 并发能力

| 维度                   | 限制                 |
| ---------------------- | -------------------- |
| 同时执行的 Skill       | 1（串行，cancel 后切换） |
| SSE 连接数             | 1 per window         |
| Bridge 回调并发        | 无限制（只读 SQLite，r2d2 连接池） |
| Memory 读写            | 串行（SQLite 文件锁） |

## 5.8 扩展 Checklist

| 步骤 | 文件                            | 说明                       |
| ---- | ------------------------------- | -------------------------- |
| 1    | `skills/types.py`               | 添加 SkillType 枚举         |
| 2    | `skills/prompts.py`             | 编写 System Prompt          |
| 3    | `tools/db_tools.py`             | 定义 LangChain Tool         |
| 4    | `infrastructure/bridge.rs`      | 添加 Bridge 端点 + SQL      |
| 5    | `models/router.py`              | 如需切换模型 tier           |
| 6    | `config.py`                     | 更新模型名/端点             |
| 7    | `memory/store.py`               | 扩展记忆类型                |
| 8    | `server/routes.py`              | 新增 API 路由               |
| 9    | `commands/*.rs`                 | Rust 侧新增 IPC Command     |
