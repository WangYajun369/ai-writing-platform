//! Python Agent Server 进程管理器
//!
//! 负责 Python 子进程的生命周期管理：
//! - 启动 FastAPI 服务
//! - 健康检查
//! - 崩溃自动重启
//! - 优雅关闭

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use tauri::Emitter;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{interval, sleep};

use crate::error::AppError;

/// Python 进程管理器状态
#[derive(Debug, Clone, PartialEq)]
pub enum AgentState {
    /// 未启动
    Stopped,
    /// 启动中
    Starting,
    /// 运行中
    Running,
    /// 已停止（异常）
    Crashed(String),
}

/// Agent Server 配置
#[derive(Debug, Clone)]
pub struct AgentServerConfig {
    /// Python 解释器路径（None = 使用系统 python3）
    pub python_path: Option<String>,
    /// Agent 服务端口
    pub port: u16,
    /// 健康检查间隔（秒）
    pub health_check_interval_secs: u64,
    /// 健康检查超时（秒）
    pub health_check_timeout_secs: u64,
    /// 最大重启次数
    pub max_restart_attempts: u32,
    /// 启动等待超时（秒）
    pub startup_timeout_secs: u64,
}

impl Default for AgentServerConfig {
    fn default() -> Self {
        Self {
            python_path: None,
            port: 9877,
            health_check_interval_secs: 10,
            health_check_timeout_secs: 5,
            max_restart_attempts: 3,
            startup_timeout_secs: 30,
        }
    }
}

/// Python Agent Server 管理器
pub struct AgentManager {
    /// 子进程句柄
    child: Mutex<Option<Child>>,
    /// 当前状态
    state: Mutex<AgentState>,
    /// 重启计数
    restart_count: Mutex<u32>,
    /// 配置
    config: AgentServerConfig,
    /// Agent 服务基础 URL
    base_url: String,
}

impl AgentManager {
    /// 创建管理器实例
    pub fn new(config: AgentServerConfig) -> Self {
        let base_url = format!("http://127.0.0.1:{}", config.port);
        Self {
            child: Mutex::new(None),
            state: Mutex::new(AgentState::Stopped),
            restart_count: Mutex::new(0),
            config,
            base_url,
        }
    }

    /// 获取服务基础 URL
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// 获取当前状态
    pub async fn state(&self) -> AgentState {
        self.state.lock().await.clone()
    }

    /// 查找 Python 解释器路径
    fn find_python(&self) -> String {
        if let Some(ref path) = self.config.python_path {
            return path.clone();
        }

        // 开发模式：优先用 which python 找到真正可用的解释器
        if let Ok(output) = std::process::Command::new("which")
            .arg("python")
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                // 验证该 python 是否有 uvicorn
                if let Ok(uv) = std::process::Command::new(&path)
                    .arg("-c")
                    .arg("import uvicorn")
                    .output()
                {
                    if uv.status.success() {
                        return path;
                    }
                }
            }
        }

        // 降级：尝试 python3，再 python
        "python".to_string()
    }

    /// 查找 agent/main.py 路径
    fn find_agent_entry(&self) -> Result<PathBuf, AppError> {
        // 开发模式：从项目根目录查找
        let candidates = vec![
            PathBuf::from("agent/main.py"),                                    // 从工作目录
            PathBuf::from("../agent/main.py"),                                 // 从 src-tauri
            std::env::current_dir()
                .unwrap_or_default()
                .join("agent/main.py"),
        ];

        for candidate in &candidates {
            if candidate.exists() {
                return Ok(candidate.clone());
            }
        }

        // 生产模式：从资源目录查找
        // Tauri 会将 resources 解压到可执行文件同目录
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let prod_path = parent.join("resources").join("agent").join("main.py");
                if prod_path.exists() {
                    return Ok(prod_path);
                }
            }
        }

        Err(AppError::Business(
            "找不到 Agent 服务入口文件 agent/main.py".into(),
        ))
    }

    /// 查找占用指定端口的进程 PID（macOS / Linux）
    fn find_pid_on_port(port: u16) -> Option<u32> {
        #[cfg(target_os = "macos")]
        {
            // macOS: lsof -ti :<port>（-t: 只输出PID，-i: 网络连接）
            let result = std::process::Command::new("lsof")
                .args(["-ti", &format!(":{}", port)])
                .output();
            match result {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if stdout.is_empty() {
                        // lsof 没找到，可能是权限问题或端口处于 TIME_WAIT
                        // 尝试用 netstat 作为后备
                        return Self::find_pid_via_netstat(port);
                    }
                    // lsof -t 可能返回多行（多个 PID），取第一个
                    for line in stdout.lines() {
                        if let Ok(pid) = line.trim().parse::<u32>() {
                            return Some(pid);
                        }
                    }
                    eprintln!("[Agent] lsof 返回了无法解析的内容: '{}'", stdout);
                }
                Err(e) => {
                    eprintln!("[Agent] lsof 命令执行失败: {}", e);
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Ok(output) = std::process::Command::new("fuser")
                .args([&format!("{}/tcp", port)])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Ok(pid) = stdout.parse::<u32>() {
                    return Some(pid);
                }
            }
        }
        None
    }

    /// 备用方案：用 netstat 查找端口占用 PID（macOS）
    #[cfg(target_os = "macos")]
    fn find_pid_via_netstat(port: u16) -> Option<u32> {
        // netstat -anv -p tcp | grep ".<port> " → 最后字段是 PID
        if let Ok(output) = std::process::Command::new("netstat")
            .args(["-anv", "-p", "tcp"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let pattern = format!(".{} ", port);
            for line in stdout.lines() {
                if line.contains(&pattern) && line.contains("LISTEN") {
                    // netstat macOS 格式: ...<pid>
                    if let Some(last) = line.split_whitespace().last() {
                        if let Ok(pid) = last.parse::<u32>() {
                            return Some(pid);
                        }
                    }
                }
            }
        }
        None
    }

    #[cfg(not(target_os = "macos"))]
    fn find_pid_via_netstat(_port: u16) -> Option<u32> {
        None
    }

    /// 强制终止占用指定端口的进程（同时尝试 kill 子进程组，防止 worker 残留）
    fn kill_process_on_port(port: u16) {
        if let Some(pid) = Self::find_pid_on_port(port) {
            eprintln!("[Agent] 发现端口 {} 被 PID {} 占用，发送 SIGKILL...", port, pid);
            #[cfg(unix)]
            {
                // 先杀整个进程组（-pid 表示进程组），再单独杀主进程
                // uvicorn 可能 fork 了 worker，单纯 kill 主进程杀不干净
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL); // 进程组
                    libc::kill(pid as i32, libc::SIGKILL);     // 主进程
                }
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .spawn();
            }
        } else {
            eprintln!("[Agent] 未找到占用端口 {} 的进程 PID（lsof/netstat 均未查到）", port);
        }
    }

    /// 等待端口彻底释放（旧 server 进程退出后，端口可能仍处于 TIME_WAIT）
    async fn wait_for_port_free(&self, timeout_secs: u64, auto_kill: bool) -> Result<(), String> {
        let start = std::time::Instant::now();
        let addr = format!("127.0.0.1:{}", self.config.port);

        eprintln!("[Agent] 等待端口 {} 释放...", addr);

        // 如果 auto_kill 且第一次检测就发现端口被占用，立即尝试 kill
        let mut kill_attempted = false;

        loop {
            match TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                Duration::from_millis(200),
            ) {
                Ok(_) => {
                    // 端口仍被占用
                    if !kill_attempted && auto_kill {
                        kill_attempted = true;
                        Self::kill_process_on_port(self.config.port);
                        // kill 后继续等待一小段时间让系统回收
                        sleep(Duration::from_millis(500)).await;
                        continue;
                    }

                    if start.elapsed().as_secs() >= timeout_secs {
                        return Err(format!(
                            "端口 {} 在 {} 秒内未释放，可能有僵尸进程占用",
                            addr, timeout_secs
                        ));
                    }
                    sleep(Duration::from_millis(300)).await;
                }
                Err(_) => {
                    // 端口已释放
                    eprintln!(
                        "[Agent] 端口 {} 已释放 ({}ms)",
                        addr,
                        start.elapsed().as_millis()
                    );
                    return Ok(());
                }
            }
        }
    }

    /// 启动 Agent Server
    pub async fn start(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().await;
        if *state == AgentState::Running || *state == AgentState::Starting {
            return Ok(()); // 已在运行
        }
        *state = AgentState::Starting;
        drop(state);

        // 启动前先确保端口已释放（auto_kill=true: 发现占用自动 kill 僵尸进程）
        if let Err(e) = self.wait_for_port_free(15, true).await {
            eprintln!("[Agent] 端口检查警告: {}", e);
            // 不阻塞启动，继续尝试
        }

        let python = self.find_python();
        let entry = self.find_agent_entry()?;

        // 从 agent/main.py 路径推导项目根目录（agent 包的父目录）
        // 使用 canonicalize 确保无论相对路径还是绝对路径都能正确解析
        let project_root = entry
            .canonicalize()
            .ok()
            .and_then(|p| {
                p.parent()         // agent/
                    .and_then(|p| p.parent())  // 项目根目录
                    .map(|p| p.to_path_buf())
            })
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

        eprintln!(
            "[Agent] 启动 Server: {} -m uvicorn agent.main:app (端口: {}, cwd: {})",
            python,
            self.config.port,
            project_root.display()
        );

        // 设置环境变量
        let child = Command::new(&python)
            .arg("-u") // 无缓冲输出
            .arg("-m")
            .arg("uvicorn")
            .arg("agent.main:app")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(self.config.port.to_string())
            .arg("--log-level")
            .arg("debug")
            .current_dir(&project_root)
            .env("AGENT_PORT", self.config.port.to_string())
            .env("PYTHONUNBUFFERED", "1")
            .env("AGENT_TRACE_LEVEL", "DEBUG")  // 启动后默认打开所有调试日志
            .stdout(Stdio::inherit())            // 日志输出到 Rust 进程控制台
            .stderr(Stdio::inherit())            // 日志输出到 Rust 进程控制台
            .kill_on_drop(true)
            .spawn()
            .context("无法启动 Python 进程")?;

        let pid = child.id();
        eprintln!("[Agent] Server PID: {:?}", pid);

        {
            let mut child_lock = self.child.lock().await;
            *child_lock = Some(child);
        }

        // 等待服务就绪
        match self.wait_for_ready().await {
            Ok(()) => {
                // 启动后验证通信链路
                match self.verify_communication().await {
                    Ok(info) => {
                        eprintln!("[Agent] Server 已就绪，通信链路验证通过");
                        eprintln!("[Agent] 服务信息: {}", info);
                    }
                    Err(e) => {
                        eprintln!("[Agent] 通信链路验证警告: {}", e);
                    }
                }
                let mut state = self.state.lock().await;
                *state = AgentState::Running;
                let mut count = self.restart_count.lock().await;
                *count = 0;
                Ok(())
            }
            Err(e) => {
                let mut state = self.state.lock().await;
                *state = AgentState::Crashed(format!("启动超时: {}", e));
                Err(AppError::Business(format!("Agent Server 启动失败: {}", e)))
            }
        }
    }

    /// 启动后验证 Rust ↔ Python 通信链路
    async fn verify_communication(&self) -> Result<String, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
        let health_url = format!("{}/health", self.base_url);

        let resp = client
            .get(&health_url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("健康检查请求失败: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("健康检查返回非成功状态: {}", resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析响应失败: {}", e))?;

        let version = body["version"].as_str().unwrap_or("unknown");
        let config = &body["config"];
        let local_model = config["local_model"].as_str().unwrap_or("N/A");
        let cloud_model = config["cloud_model"].as_str().unwrap_or("N/A");

        Ok(format!(
            "version={}, local_model={}, cloud_model={}",
            version, local_model, cloud_model
        ))
    }

    /// 等待服务就绪（轮询 /health）
    async fn wait_for_ready(&self) -> Result<(), String> {
        let start = std::time::Instant::now();
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
        let health_url = format!("{}/health", self.base_url);

        eprintln!("[Agent] 开始健康检查轮询: {}", health_url);

        // 先等待一小段时间，让 uvicorn 完成内部初始化（导入模块、启动 asyncio loop 等）
        sleep(Duration::from_millis(500)).await;

        while start.elapsed().as_secs() < self.config.startup_timeout_secs {
            match client
                .get(&health_url)
                .timeout(Duration::from_secs(self.config.health_check_timeout_secs))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    eprintln!("[Agent] 健康检查成功 ({}ms)", start.elapsed().as_millis());
                    return Ok(());
                }
                Ok(resp) => {
                    eprintln!("[Agent] 健康检查返回非成功状态: {}", resp.status());
                }
                Err(e) => {
                    // 前几次失败静默，超过 3 秒后打印日志帮助排查
                    if start.elapsed().as_secs() > 3 {
                        eprintln!("[Agent] 健康检查失败 ({}ms): {}", start.elapsed().as_millis(), e);
                    }
                }
            }
            sleep(Duration::from_millis(500)).await;
        }

        Err(format!(
            "Agent Server 在 {} 秒内未就绪",
            self.config.startup_timeout_secs
        ))
    }

    /// 健康检查（供外部定时调用）
    pub async fn check_health(&self) -> bool {
        let client = match reqwest::Client::builder().no_proxy().build() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Agent] 创建 HTTP 客户端失败: {}", e);
                return false;
            }
        };
        let health_url = format!("{}/health", self.base_url);

        match client
            .get(&health_url)
            .timeout(Duration::from_secs(self.config.health_check_timeout_secs))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(e) => {
                eprintln!("[Agent] 健康检查失败: {}", e);
                false
            }
        }
    }

    /// 尝试重启（在崩溃时调用）
    pub async fn try_restart(&self) -> Result<(), AppError> {
        let mut count = self.restart_count.lock().await;
        if *count >= self.config.max_restart_attempts {
            let msg = format!(
                "Agent Server 已崩溃 {} 次，达到最大重启次数限制",
                *count
            );
            eprintln!("[Agent] {}", msg);
            let mut state = self.state.lock().await;
            *state = AgentState::Crashed(msg.clone());
            return Err(AppError::Business(msg));
        }

        *count += 1;
        let attempt = *count;
        drop(count);

        eprintln!(
            "[Agent] 第 {} 次尝试重启（最多 {} 次）",
            attempt,
            self.config.max_restart_attempts
        );

        // 确保旧进程已关闭
        self.stop().await?;

        // 等待一小段再重启
        sleep(Duration::from_secs(2)).await;

        self.start().await
    }

    /// 停止 Agent Server，并验证端口是否已释放
    pub async fn stop(&self) -> Result<(), AppError> {
        let mut child_opt = self.child.lock().await;
        if let Some(ref mut child) = *child_opt {
            let pid = child.id();
            eprintln!("[Agent] 正在关闭 Server (PID: {:?})...", pid);

            // 尝试优雅关闭
            if let Some(id) = pid {
                #[cfg(unix)]
                {
                    unsafe {
                        libc::kill(id as i32, libc::SIGTERM);
                    }
                }
                #[cfg(windows)]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &id.to_string(), "/T", "/F"])
                        .spawn();
                }
            }

            // 等待进程结束（最多 10 秒）
            match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
                Ok(Ok(status)) => {
                    eprintln!("[Agent] Server 进程已退出: {:?}", status);
                }
                Ok(Err(e)) => {
                    eprintln!("[Agent] 等待关闭时出错: {}", e);
                    let _ = child.kill().await;
                }
                Err(_) => {
                    eprintln!("[Agent] 关闭超时，强制终止");
                    let _ = child.kill().await;
                }
            }
        }

        *child_opt = None;

        // ─── 端口释放验证 ───
        // 即使进程已退出，端口可能仍在 TIME_WAIT；
        // 此外，可能有不在 child 跟踪范围内的僵尸进程（如上次崩溃残留）
        self.verify_port_released(5).await;

        let mut state = self.state.lock().await;
        *state = AgentState::Stopped;

        Ok(())
    }

    /// 验证端口是否已释放，若未释放则强制清理
    async fn verify_port_released(&self, timeout_secs: u64) {
        let port = self.config.port;
        // 先快速检查端口是否已释放
        let addr = format!("127.0.0.1:{}", port);
        match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)) {
            Ok(_) => {
                // 端口仍被占用，尝试 kill 占用端口的进程
                eprintln!("[Agent] 端口 {} 仍被占用，尝试强制清理...", addr);
                Self::kill_process_on_port(port);
                // 等待端口释放
                let start = std::time::Instant::now();
                loop {
                    if start.elapsed().as_secs() >= timeout_secs {
                        eprintln!("[Agent] 警告: 端口 {} 在 {} 秒内未释放", addr, timeout_secs);
                        break;
                    }
                    match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)) {
                        Ok(_) => {
                            sleep(Duration::from_millis(300)).await;
                        }
                        Err(_) => {
                            eprintln!("[Agent] 端口 {} 已确认释放", addr);
                            break;
                        }
                    }
                }
            }
            Err(_) => {
                eprintln!("[Agent] 端口 {} 已释放 ✓", addr);
            }
        }
    }

    /// 暴力关闭（同步版本，不依赖 tokio Child 对象）
    ///
    /// 用于应用退出时的清理：不依赖被 Tauri runtime 可能已经拆除的 tokio Child，
    /// 直接通过系统命令 SIGKILL 进程组 + 端口占用检测来保证彻底清理。
    pub fn force_shutdown_sync(&self) {
        let port = self.config.port;

        // 1) 先尝试通过 tokio Child 发 SIGTERM（如果 runtime 还活着）
        //    这里直接拿 std mutex 锁，不做 async
        if let Ok(mut child_opt) = self.child.try_lock() {
            if let Some(ref mut child) = *child_opt {
                if let Some(pid) = child.id() {
                    eprintln!("[Agent] force_shutdown: 发送 SIGTERM 给 PID {}", pid);
                    #[cfg(unix)]
                    unsafe {
                        // 杀进程组（pid 取负）确保 uvicorn worker 全部终止
                        libc::kill(-(pid as i32), libc::SIGTERM);
                    }
                    // 短暂等待进程自行退出
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    // 尝试 start_kill（如果还没退出）
                    let _ = child.start_kill();
                }
            }
            *child_opt = None;
        }

        // 2) 再通过端口强制清理（SIGKILL 进程组，确保 worker 不会被残留）
        eprintln!("[Agent] force_shutdown: 通过端口 {} 强制清理残留进程...", port);
        Self::kill_process_on_port(port);

        // 3) 等待端口彻底释放
        let addr = format!("127.0.0.1:{}", port);
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(8);
        loop {
            match std::net::TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                std::time::Duration::from_millis(200),
            ) {
                Ok(_) => {
                    if start.elapsed() >= timeout {
                        eprintln!(
                            "[Agent] force_shutdown: 端口 {} 未能在 {} 秒内释放",
                            port,
                            timeout.as_secs()
                        );
                        // 最后再试一次 kill
                        Self::kill_process_on_port(port);
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
                Err(_) => {
                    eprintln!(
                        "[Agent] force_shutdown: 端口 {} 已释放 ({}ms)",
                        port,
                        start.elapsed().as_millis()
                    );
                    break;
                }
            }
        }
    }

    /// 启动健康检查看门狗（后台任务）
    /// 必须在 Tauri async runtime 上下文中调用（如 setup 闭包内用 tauri::async_runtime::spawn）
    pub fn spawn_watchdog(manager: Arc<AgentManager>, app: tauri::AppHandle) {
        tauri::async_runtime::spawn(async move {
            let mut ticker = interval(Duration::from_secs(
                manager.config.health_check_interval_secs,
            ));

            loop {
                ticker.tick().await;

                let state = manager.state().await;
                match state {
                    AgentState::Running => {
                        // 正常运行中，进行健康检查
                    }
                    AgentState::Crashed(_) => {
                        // 已达最大重启次数，退出看门狗
                        eprintln!("[Agent] 看门狗：Agent 已崩溃且达到最大重启次数，退出监控");
                        break;
                    }
                    _ => {
                        // Stopped 或 Starting 状态，跳过本轮
                        continue;
                    }
                }

                if !manager.check_health().await {
                    eprintln!("[Agent] 健康检查失败，尝试重启...");
                    let _ = app.emit("agent-status-changed", serde_json::json!({
                        "status": "restarting",
                        "message": "Agent 服务无响应，正在自动重启..."
                    }));

                    match manager.try_restart().await {
                        Ok(()) => {
                            let _ = app.emit("agent-status-changed", serde_json::json!({
                                "status": "running",
                                "message": "Agent 服务已恢复"
                            }));
                        }
                        Err(e) => {
                            let _ = app.emit("agent-status-changed", serde_json::json!({
                                "status": "crashed",
                                "message": format!("Agent 服务异常: {}", e)
                            }));
                            // 达到最大重启次数后退出看门狗
                            let state = manager.state().await;
                            if matches!(state, AgentState::Crashed(_)) {
                                eprintln!("[Agent] 看门狗：重启失败已达上限，退出监控");
                                break;
                            }
                        }
                    }
                }
            }
        });
    }
}
