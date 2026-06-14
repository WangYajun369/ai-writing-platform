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

优雅关闭分为三个阶段：**请求排空 → 进程终止 → 资源回收**。

```rust
impl PythonAgentManager {
    pub async fn stop(&mut self, app: &AppHandle) {
        self.set_status(AgentStatus::Stopping, app);

        if let Some(mut child) = self.child.take() {
            // ── 阶段 1：请求排空（Draining） ──
            // 通知 Python 停止接收新请求，等待进行中的请求完成
            if let Ok(client) = reqwest::Client::new()
                .post(format!("http://127.0.0.1:{}/admin/drain", self.port))
                .timeout(Duration::from_secs(3))
                .send()
                .await
            {
                tracing::info!("Agent draining: {:?}", client.status());
            }
            
            // 等待排空（最多 5s）
            let drain_timeout = tokio::time::timeout(
                Duration::from_secs(5),
                Self::wait_for_drain(self.port),
            ).await;
            if drain_timeout.is_err() {
                tracing::warn!("Agent drain timeout, proceeding with shutdown");
            }

            // ── 阶段 2：发送 SIGTERM ──
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

            // ── 阶段 3：强制结束（SIGKILL） ──
            if timeout.is_err() {
                tracing::warn!("Agent did not terminate gracefully, sending SIGKILL");
                let _ = child.kill();
                let _ = child.wait();
            }
            
            // 资源回收：清理端口占用
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("lsof")
                    .args(["-ti", &format!(":{}", self.port)])
                    .output();
            }
        }

        self.set_status(AgentStatus::Stopped, app);
    }
    
    /// 等待 Agent 排空（无进行中的 /skills/execute 请求）
    async fn wait_for_drain(port: u16) {
        loop {
            if let Ok(resp) = reqwest::get(
                format!("http://127.0.0.1:{port}/admin/pending")
            ).await {
                if let Ok(body) = resp.text().await {
                    if body == "0" { break; }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}
```

**Python 侧配合**：
```python
# agent/admin.py
from fastapi import APIRouter
import asyncio

admin_router = APIRouter()
_is_draining = False
_pending_requests = 0

@admin_router.post("/admin/drain")
async def start_drain():
    global _is_draining
    _is_draining = True
    return {"status": "draining"}

@admin_router.get("/admin/pending")
async def get_pending():
    return str(_pending_requests)

# 在 skill 执行入口处检查是否正在排空
async def execute_skill(request: SkillRequest):
    if _is_draining:
        raise HTTPException(status_code=503, detail="Agent is draining")
    global _pending_requests
    _pending_requests += 1
    try:
        return await do_execute(request)
    finally:
        _pending_requests -= 1
```

> **优雅关闭口诀**：Drain → SIGTERM → wait(10s) → SIGKILL。确保进行中的 AI 推理不丢失、不半截。详见 11 §11.9 发布流程中 Agent 重启动说明。

### 5.3.4 心跳机制（孤儿进程防护）

⚠️ **风险**：若 Rust 主进程崩溃重启，Python 子进程成为孤儿，继续占用端口和内存，且无法接收新请求。

**解决方案**：Python 每 30 秒向 Rust 发送心跳，Rust 记录最后一次心跳时间。看门狗同时检查进程存活 **和** 心跳超时。

#### Rust 侧实现

```rust
// python/manager.rs (补充)
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct PythonAgentManager {
    child: Option<Child>,
    port: u16,
    bridge_port: u16,
    restart_count: u32,
    status: AgentStatus,
    status_tx: tokio::sync::broadcast::Sender<AgentStatus>,
    // 新增：最后一次心跳时间戳（原子操作，跨线程安全）
    last_heartbeat: Arc<AtomicI64>,
}

impl PythonAgentManager {
    /// 启动 Agent（补充心跳端点）
    pub async fn start(&mut self, app: AppHandle) -> Result<(), AgentError> {
        // ... 原有启动逻辑 ...
        
        // 启动心跳接收服务（在 Bridge 中增加 /agent/heartbeat 端点）
        self.start_heartbeat_listener(app.clone())?;
        
        // 启动看门狗（修改为同时检查心跳）
        self.start_watchdog_v2(app.clone());
        
        Ok(())
    }
    
    /// 启动心跳监听（在 Bridge 中注册端点）
    fn start_heartbeat_listener(&self, app: AppHandle) -> Result<(), AgentError> {
        let last_heartbeat = self.last_heartbeat.clone();
        
        // 在 Bridge 服务中注册 /agent/heartbeat POST 端点
        // （具体实现在 5.4.3 节）
        tracing::info!("Heartbeat listener registered on Bridge");
        Ok(())
    }
    
    /// 看门狗 V2：同时检查进程存活和心跳
    fn start_watchdog_v2(&self, app: AppHandle) {
        let port = self.port;
        let last_heartbeat = self.last_heartbeat.clone();
        let mut status_rx = self.status_tx.subscribe();
        let max_restarts = 3;

        tokio::spawn(async move {
            let mut failures = 0u32;
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;

                // 检查 1：进程是否存活
                let process_alive = Self::check_process_alive(port).await;
                
                // 检查 2：心跳是否超时（超过 90 秒未收到心跳）
                let heartbeat_timeout = {
                    let last = last_heartbeat.load(Ordering::Relaxed);
                    if last == 0 {
                        false // 尚未收到第一次心跳
                    } else {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_secs() as i64;
                        (now - last) > 90 // 90 秒超时
                    }
                };
                
                if !process_alive || heartbeat_timeout {
                    failures += 1;
                    tracing::warn!(
                        "Agent unhealthy (process_alive={}, heartbeat_timeout={}), restart attempt {failures}/{max_restarts}",
                        process_alive, heartbeat_timeout
                    );
                    
                    if failures <= max_restarts {
                        // 触发重启逻辑（需要先杀死孤儿进程）
                        if process_alive {
                            Self::force_kill(port).await;
                        }
                        // 通知重启逻辑（通过 status_tx）
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
    
    /// 更新心跳时间戳（由 Bridge /agent/heartbeat 端点调用）
    pub fn update_heartbeat(&self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        self.last_heartbeat.store(now, Ordering::Relaxed);
    }
}
```

#### Python 侧实现

```python
# agent/main.py (补充心跳发送)
import asyncio
import aiohttp
from typing import Optional

class HeartbeatClient:
    def __init__(self, rust_bridge_port: int = 9876):
        self.bridge_url = f"http://127.0.0.1:{rust_bridge_port}/agent/heartbeat"
        self.interval = 30  # 每 30 秒发送一次
        self._task: Optional[asyncio.Task] = None
        
    async def start(self):
        """启动心跳任务"""
        self._task = asyncio.create_task(self._heartbeat_loop())
        
    async def stop(self):
        """停止心跳任务"""
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
    
    async def _heartbeat_loop(self):
        """心跳循环"""
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        self.bridge_url,
                        json={"status": "alive", "pid": os.getpid()},
                        timeout=aiohttp.ClientTimeout(total=5)
                    ) as resp:
                        if resp.status != 200:
                            logging.warning(f"Heartbeat failed: {resp.status}")
            except Exception as e:
                logging.warning(f"Heartbeat error: {e}")
                # ⚠️ 若连续多次心跳失败，Python 应自行退出（防止孤儿进程）
                # （具体实现见下方孤儿进程自我检测）
            
            await asyncio.sleep(self.interval)

# 在 FastAPI 启动时启动心跳
@app.on_event("startup")
async def startup_event():
    global heartbeat_client
    heartbeat_client = HeartbeatClient()
    await heartbeat_client.start()
    
@app.on_event("shutdown")
async def shutdown_event():
    if heartbeat_client:
        await heartbeat_client.stop()
```

#### 孤儿进程自我检测（Python 侧）

```python
# agent/orphan_detector.py
import os
import signal
import psutil  # 需要安装：pip install psutil

class OrphanDetector:
    def __init__(self, parent_pid: int, check_interval: int = 60):
        self.parent_pid = parent_pid
        self.check_interval = check_interval
        self._task: Optional[asyncio.Task] = None
        
    async def start(self):
        """启动孤儿检测任务"""
        self._task = asyncio.create_task(self._detect_loop())
        
    async def _detect_loop(self):
        """检测父进程是否存活"""
        while True:
            await asyncio.sleep(self.check_interval)
            
            try:
                parent = psutil.Process(self.parent_pid)
                if not parent.is_running():
                    logging.error(f"Parent process {self.parent_pid} is dead. Self-terminating.")
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
            except psutil.NoSuchProcess:
                logging.error(f"Parent process {self.parent_pid} not found. Self-terminating.")
                os.kill(os.getpid(), signal.SIGTERM)
                return

# 在 FastAPI 启动时获取父进程 PID 并启动检测
@app.on_event("startup")
async def startup_event():
    # ... 其他启动逻辑 ...
    
    # 获取并检测父进程
    parent_pid = os.getppid()
    global orphan_detector
    orphan_detector = OrphanDetector(parent_pid)
    await orphan_detector.start()
```

> **实现要点**：
> 1. Rust 启动 Python 时，通过环境变量 `MIRAGEINK_PARENT_PID` 传递自己的 PID
> 2. Python 读取此 PID，定期检查父进程是否存活
> 3. 若父进程死亡，Python 自行退出（SIGTERM）
> 4. 双重保障：Rust 看门狗检测 Python 心跳超时 + Python 自行检测父进程存活

### 5.3.5 Agent 健康指标暴露

> **与本节的定位差异**：本节关注**进程级运维指标**（内存/CPU/QPS），用于本地监控 Agent 健康状态；**业务级 AI 调用埋点**（技能成功率/Token 消耗/模型降级）归属于统一埋点体系，详见 [12-可观测性与数据埋点.md](./12-可观测性与数据埋点.md)。

为支持监控面板和故障排查，Agent 应暴露关键运行时指标。

#### 指标清单

| 指标 | 端点 | 类型 | 告警阈值 |
|------|------|------|---------|
| 内存使用 (RSS) | `/metrics` | Gauge | > 2 GB → WARN |
| CPU 使用率 | `/metrics` | Gauge | > 80% 持续 30s → WARN |
| 请求 QPS | `/metrics` | Counter | — |
| 请求 P50/P99 延迟 | `/metrics` | Histogram | P99 > 30s → WARN |
| 错误率 (5xx) | `/metrics` | Counter | > 5% → ERROR |
| 进行中请求数 | `/metrics` | Gauge | > 10 并发 → WARN |

#### Python 侧实现

```python
# agent/metrics.py
import psutil
import os
import time
from prometheus_client import Gauge, Counter, Histogram, generate_latest, REGISTRY

# 指标定义
agent_memory_bytes = Gauge('agent_memory_bytes', 'Agent RSS memory usage')
agent_cpu_percent = Gauge('agent_cpu_percent', 'Agent CPU usage %')
agent_requests_total = Counter('agent_requests_total', 'Total requests', ['status'])
agent_request_duration = Histogram('agent_request_duration_seconds', 'Request duration')
agent_pending_requests = Gauge('agent_pending_requests', 'Pending requests')
agent_uptime_seconds = Gauge('agent_uptime_seconds', 'Agent uptime')

_start_time = time.time()

def collect_process_metrics():
    """采集进程级指标"""
    proc = psutil.Process(os.getpid())
    agent_memory_bytes.set(proc.memory_info().rss)
    agent_cpu_percent.set(proc.cpu_percent(interval=1))
    agent_uptime_seconds.set(time.time() - _start_time)

# FastAPI 端点
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

metrics_router = APIRouter()

@metrics_router.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    """Prometheus 格式指标端点"""
    collect_process_metrics()
    return generate_latest(REGISTRY)

@metrics_router.get("/health")
async def health():
    """简单健康检查（配合 Rust 就绪检测）"""
    return {
        "status": "healthy" if not _is_draining else "draining",
        "uptime_seconds": time.time() - _start_time,
        "pending_requests": _pending_requests,
        "memory_mb": psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024,
    }
```

#### Rust 侧指标采集

```rust
// python/monitor.rs
use std::collections::HashMap;

pub struct AgentMetrics {
    pub memory_mb: f64,
    pub cpu_percent: f64,
    pub pending_requests: u32,
    pub uptime_seconds: u64,
    pub error_rate_5min: f64,
}

impl PythonAgentManager {
    /// 每 15 秒采集一次指标（独立于看门狗）
    pub async fn collect_metrics(&self) -> Option<AgentMetrics> {
        let resp = reqwest::get(
            format!("http://127.0.0.1:{}/health", self.port)
        ).await.ok()?;
        let json: HashMap<String, serde_json::Value> = resp.json().await.ok()?;
        
        Some(AgentMetrics {
            memory_mb: json.get("memory_mb")?.as_f64()?,
            cpu_percent: 0.0, // Python 侧下次采集更新
            pending_requests: json.get("pending_requests")?.as_u64()? as u32,
            uptime_seconds: json.get("uptime_seconds")?.as_u64()?,
            error_rate_5min: 0.0,
        })
    }
}
```

### 5.3.6 模型配置管理

Agent 支持多种 LLM 模型（OpenAI / Ollama / 本地）。配置通过项目管理，支持热加载。

#### 配置结构

```yaml
# agent/config/models.yaml
default_model: gpt-4o-mini

models:
  gpt-4o:
    provider: openai
    model: gpt-4o
    api_key_env: OPENAI_API_KEY        # 从环境变量读取，不落盘
    max_tokens: 4096
    temperature: 0.7
    rate_limit: 10                       # 每分钟最大请求数
    
  gpt-4o-mini:
    provider: openai
    model: gpt-4o-mini
    api_key_env: OPENAI_API_KEY
    max_tokens: 2048
    temperature: 0.7
    rate_limit: 30

  qwen-local:
    provider: ollama
    model: qwen2.5:7b
    base_url: http://localhost:11434
    max_tokens: 8192
    temperature: 0.3

skills:
  summarize:          { model: gpt-4o-mini, max_tokens: 1024 }
  expand:             { model: gpt-4o,      max_tokens: 4096 }
  polish:             { model: gpt-4o-mini, max_tokens: 2048 }
  translate:          { model: gpt-4o-mini, max_tokens: 4096 }
  outline-generate:   { model: qwen-local,  max_tokens: 8192 }
```

#### Python 加载逻辑

```python
# agent/model_config.py
import os
import yaml
from pathlib import Path
from typing import Dict, Optional

class ModelConfigManager:
    def __init__(self, config_path: Path = Path("config/models.yaml")):
        with open(config_path) as f:
            self.config = yaml.safe_load(f)
        self._resolve_env_vars()
    
    def _resolve_env_vars(self):
        """将 api_key_env 替换为实际值"""
        for model_id, model_cfg in self.config.get("models", {}).items():
            env_var = model_cfg.pop("api_key_env", None)
            if env_var:
                model_cfg["api_key"] = os.getenv(env_var, "")
                if not model_cfg["api_key"]:
                    logging.warning(f"Model {model_id}: env var {env_var} not set")
    
    def get_model_for_skill(self, skill: str) -> Dict:
        """根据 skill 返回对应模型配置"""
        skill_cfg = self.config.get("skills", {}).get(skill, {})
        model_id = skill_cfg.get("model", self.config["default_model"])
        model = dict(self.config["models"].get(model_id, {}))
        model.update({k: v for k, v in skill_cfg.items() if k != "model"})
        return model

# 全局单例
model_config = ModelConfigManager()
```

> **安全要点**：API Key 仅通过环境变量注入，永不写入配置文件或 Git。Rust 启动 Agent 时将 `MIRAGEINK_OPENAI_KEY` 等环境变量传递给子进程（见 06 §6.2.3 凭证管理）。

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

### 5.4.3 Bridge 认证机制（安全加固）

⚠️ **风险**：Bridge 绑定 `127.0.0.1`，但未验证请求来源。任何本地进程均可调用 Bridge 读取数据。

**解决方案**：Rust 启动时生成随机 Auth Token，通过环境变量传递给 Python。Python 所有 Bridge 回调请求必须附带 `X-Auth-Token` header。

#### Rust 侧实现

```rust
// infrastructure/bridge.rs (补充)
use rand::{thread_rng, Rng};
use rand::distr::Alphanumeric;

pub struct DataBridge {
    pool: Arc<r2d2::Pool<SqliteConnectionManager>>,
    auth_token: String,  // 新增：认证 Token
}

impl DataBridge {
    pub fn new(pool: Arc<r2d2::Pool<SqliteConnectionManager>>) -> Self {
        // 生成随机 Token（32 字节，Base64 编码后约 43 字符）
        let token: String = thread_rng()
            .sample_iter(&Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();
        
        // 将 Token 写入环境变量，供 Python 读取
        std::env::set_var("MIRAGEINK_BRIDGE_TOKEN", &token);
        
        tracing::info!("Bridge Auth Token generated and set as env var");
        
        Self { pool, auth_token: token }
    }
    
    /// 验证请求中的 Auth Token
    fn verify_auth(&self, request: &tiny_http::Request) -> bool {
        for header in request.headers() {
            if header.field.as_str() == "x-auth-token" {
                return header.value.as_str() == self.auth_token;
            }
        }
        false
    }
    
    pub fn start(pool: Arc<r2d2::Pool<SqliteConnectionManager>>, port: u16) {
        let bridge = Self::new(pool);
        let server = Server::http(format!("127.0.0.1:{port}"))
            .expect("Failed to start Bridge server");

        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                // 认证检查
                if !bridge.verify_auth(&request) {
                    let _ = request.respond(
                        Response::from_string("Unauthorized")
                            .with_status_code(401)
                    );
                    continue;
                }
                
                // ... 原有路由逻辑 ...
            }
        });
    }
}
```

#### Python 侧实现

```python
# agent/bridge_client.py
import os
import aiohttp
from typing import Optional

class BridgeClient:
    def __init__(self, bridge_port: int = 9876):
        self.base_url = f"http://127.0.0.1:{bridge_port}"
        self.auth_token: Optional[str] = None
        
    def load_auth_token(self):
        """从环境变量读取 Auth Token"""
        self.auth_token = os.environ.get("MIRAGEINK_BRIDGE_TOKEN")
        if not self.auth_token:
            logging.error("MIRAGEINK_BRIDGE_TOKEN not found in env!")
            raise RuntimeError("Bridge Auth Token missing")
    
    async def _request(self, method: str, path: str, **kwargs):
        """统一的 Bridge 请求方法（自动附加 Auth Token）"""
        if not self.auth_token:
            self.load_auth_token()
            
        headers = kwargs.pop("headers", {})
        headers["X-Auth-Token"] = self.auth_token
        
        async with aiohttp.ClientSession() as session:
            async with session.request(
                method, f"{self.base_url}{path}",
                headers=headers,
                **kwargs
            ) as resp:
                resp.raise_for_status()
                return await resp.json()
    
    # 示例：读取章节内容
    async def read_chapter(self, chapter_id: str):
        return await self._request(
            "POST", "/agent/read_chapter",
            json={"chapter_id": chapter_id}
        )

# 全局 Bridge 客户端实例
bridge_client = BridgeClient()

# 在 FastAPI 启动时初始化
@app.on_event("startup")
async def startup_event():
    bridge_client.load_auth_token()
    # ... 其他启动逻辑 ...
```

> **安全要点**：
> 1. Token 在 Rust 启动时随机生成，每次启动不同
> 2. Token 通过环境变量传递，不写入文件
> 3. Python 进程崩溃重启后，需重新从环境变量读取 Token
> 4. 若 Token 验证失败，Bridge 返回 401，Python 应记录错误并停止工作

## 5.5 模型路由

### 5.5.1 双层级路由

```
用户请求
    │
    ▼
SkillType: WRITING/ANALYSIS/RESEARCH → CLOUD (DeepSeek)
SkillType: POLISH                     → LOCAL (Ollama)
    │
    ▼  若目标不可用，自动降级（详见 §5.9.4）
    │
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

## 5.9 统一错误传播协议

Python Agent 的错误必须遵循跨语言的 **统一错误处理模型**（完整定义见 [02-MVVM分层详解.md](./02-MVVM分层详解.md) 第 2.8 节），确保错误信息在 Python → Rust → TypeScript 三层之间无损传递。

### 5.9.1 AgentError 模型定义

```python
# agent/errors.py
from enum import Enum
from typing import Optional, Any
from pydantic import BaseModel
from fastapi import HTTPException
from fastapi.responses import JSONResponse

class ErrorSeverity(str, Enum):
    INFO = "info"
    WARN = "warn"
    ERROR = "error"
    FATAL = "fatal"

class AgentError(BaseModel):
    """Python 侧的标准化错误模型——与 Rust AppError 字段一一对应"""
    code: str              # e.g., "LLM_TIMEOUT", "RATE_LIMITED"
    message: str           # 用户可读消息
    severity: ErrorSeverity = ErrorSeverity.WARN
    recoverable: bool = True
    detail: Optional[str] = None  # JSON 字符串，额外上下文

    def to_http_response(self, status_code: int = 500) -> JSONResponse:
        """转为 FastAPI JSONResponse，供 Rust 侧 AppError::from_agent_response 解析"""
        return JSONResponse(
            status_code=status_code,
            content=self.model_dump(exclude_none=True),
        )
```

### 5.9.2 LLM 错误子类型

```python
# agent/errors.py (续)

class AgentErrorFactory:
    """常见 AI 错误的工厂方法"""

    @staticmethod
    def llm_timeout(skill: str, timeout_seconds: int) -> AgentError:
        return AgentError(
            code="LLM_TIMEOUT",
            message=f"AI 技能「{skill}」执行超时（{timeout_seconds}s），请稍后重试",
            severity=ErrorSeverity.WARN,
            recoverable=True,
        )

    @staticmethod
    def rate_limited(retry_after: int = 60) -> AgentError:
        return AgentError(
            code="RATE_LIMITED",
            message=f"请求频率过高，请在 {retry_after} 秒后重试",
            severity=ErrorSeverity.WARN,
            recoverable=True,
            detail=json.dumps({"retry_after_seconds": retry_after}),
        )

    @staticmethod
    def token_limit_exceeded(current: int, max_tokens: int) -> AgentError:
        return AgentError(
            code="TOKEN_LIMIT_EXCEEDED",
            message=f"输入内容过长（{current}/{max_tokens} tokens），请精简后重试",
            severity=ErrorSeverity.WARN,
            recoverable=False,
            detail=json.dumps({"current_tokens": current, "max_tokens": max_tokens}),
        )

    @staticmethod
    def model_unavailable(model: str, reason: str = "") -> AgentError:
        return AgentError(
            code="MODEL_UNAVAILABLE",
            message=f"模型「{model}」不可用" + (f": {reason}" if reason else ""),
            severity=ErrorSeverity.ERROR,
            recoverable=True,
        )

    @staticmethod
    def invalid_api_key(provider: str) -> AgentError:
        return AgentError(
            code="INVALID_API_KEY",
            message=f"{provider} API Key 无效，请在设置中重新配置",
            severity=ErrorSeverity.ERROR,
            recoverable=False,
        )

    @staticmethod
    def internal(original_error: str) -> AgentError:
        return AgentError(
            code="AGENT_INTERNAL",
            message="AI 服务内部错误，请稍后重试",
            severity=ErrorSeverity.FATAL,
            recoverable=False,
            detail=original_error,  # 完整错误信息仅记录日志，不暴露给用户
        )
```

### 5.9.3 在路由层集成

```python
# server/routes.py
from agent.errors import AgentError, AgentErrorFactory
from openai import RateLimitError, APIError, APITimeoutError

@router.post("/skills/execute")
async def execute_skill(request: SkillExecuteRequest):
    try:
        result = await skill_executor.execute(request)
        return StreamingResponse(result.stream(), media_type="text/event-stream")

    except APITimeoutError:
        raise HTTPException(
            status_code=504,
            detail=AgentErrorFactory.llm_timeout(
                request.skill_type.value, timeout_seconds=120
            ).model_dump(),
        )

    except RateLimitError:
        raise HTTPException(
            status_code=429,
            detail=AgentErrorFactory.rate_limited().model_dump(),
        )

    except APIError as e:
        if "invalid_api_key" in str(e).lower():
            raise HTTPException(
                status_code=401,
                detail=AgentErrorFactory.invalid_api_key("OpenAI").model_dump(),
            )
        raise HTTPException(
            status_code=502,
            detail=AgentErrorFactory.model_unavailable(
                request.model, str(e)
            ).model_dump(),
        )

    except Exception as e:
        logging.exception("Unexpected agent error")
        raise HTTPException(
            status_code=500,
            detail=AgentErrorFactory.internal(str(e)).model_dump(),
        )
```

### 5.9.4 模型切换降级策略

当前 `SKILL_MODEL_MAP` 将 POLISH 固定到本地 Ollama，WRITING/ANALYSIS/RESEARCH 固定到云端。若目标模型不可用，需支持自动降级：

```python
# models/router.py (补充)

class ModelRouter:
    # 模型降级链：按优先级尝试
    FALLBACK_CHAIN = {
        ModelTier.CLOUD: [ModelTier.CLOUD, ModelTier.LOCAL],  # 云端不可用 → 降级到本地
        ModelTier.LOCAL: [ModelTier.LOCAL, ModelTier.CLOUD],  # 本地不可用 → 降级到云端
    }

    def get_model_for_skill(self, skill: SkillType, stream: bool = True):
        tier = SKILL_MODEL_MAP[skill]

        last_error = None
        for fallback_tier in self.FALLBACK_CHAIN[tier]:
            try:
                model = self._get_or_create(fallback_tier, stream)
                # 快速健康检查
                model.invoke("ping")  # 或用轻量请求验证模型可用
                return model
            except Exception as e:
                last_error = e
                logging.warning(
                    f"Model tier {fallback_tier.value} unavailable for {skill.value}: {e}"
                )
                continue

        # 所有降级链路失败
        raise AgentErrorFactory.model_unavailable(
            f"skill={skill.value}", str(last_error)
        )
```

> **降级规则**：
> 1. WRITING/ANALYSIS/RESEARCH 首选云端 DeepSeek，不可用时降级到本地 Ollama
> 2. POLISH 首选本地 Ollama（隐私优先），不可用时降级到云端 gpt-4o-mini
> 3. 降级时记录 WARNING 日志，便于排查
> 4. Rust 侧收到 `AGENT_MODEL_UNAVAILABLE` 时通过 Tauri Event 通知前端显示"已切换至备用模型"提示
