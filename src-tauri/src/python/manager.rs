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
use chrono::Local;
use tauri::Emitter;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{interval, sleep};

use crate::commands::window::{log_buffer, LogEntry};
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

    /// 规范化路径：转绝对路径 + 消除 . 和 ..，但不解析符号链接
    ///
    /// 与 canonicalize() 的关键区别：canonicalize() 会解析符号链接，
    /// 对于 venv 虚拟环境来说 bin/python 是符号链接，解析后会指向系统
    /// Python，导致后续无法找到 venv 内安装的依赖（如 uvicorn）。
    fn normalize_path(relative: &std::path::Path) -> PathBuf {
        use std::path::Component;

        let base = if relative.is_absolute() {
            PathBuf::new()
        } else {
            std::env::current_dir().unwrap_or_default()
        };
        let combined = base.join(relative);

        // 手动遍历组件，消除 . 和 ..
        let mut normalized = PathBuf::new();
        for component in combined.components() {
            match component {
                Component::ParentDir => {
                    normalized.pop();
                }
                Component::CurDir => {}
                other => normalized.push(other),
            }
        }
        normalized
    }

    /// 查找 Python 解释器路径
    ///
    /// 优先级：
    /// 1. 用户指定的 python_path
    /// 2. agent/.venv 虚拟环境中的解释器（生产环境首次运行前由用户创建）
    /// 3. PATH 中的 python/python3（开发环境）
    fn find_python(&self) -> String {
        // 辅助：同时输出到 stderr 和调试窗口日志缓冲区
        let log = |msg: &str| {
            eprintln!("{}", msg);
            if let Ok(mut buffer) = log_buffer().lock() {
                if buffer.len() >= 1000 { buffer.remove(0); }
                buffer.push(LogEntry {
                    timestamp: Local::now().format("%H:%M:%S").to_string(),
                    level: "info".to_string(),
                    message: msg.to_string(),
                    file: None,
                    file_name: None,
                    line: None,
                });
            }
        };

        log("[Agent] 开始查找 Python 解释器...");

        // 优先级 1：使用用户显式指定的解释器路径
        if let Some(ref path) = self.config.python_path {
            log(&format!("[Agent] 使用用户指定的 Python 路径: {}", path));
            return path.clone();
        }

        // 优先级 2：尝试 .venv 虚拟环境
        //   先查 agent/.venv（打包后随 agent 目录分发）
        //   再查项目根目录 .venv（开发备选，不被打包）
        if let Ok(entry) = self.find_agent_entry() {
            log(&format!("[Agent] agent 入口文件: {}", entry.display()));
            if let Some(agent_dir) = entry.parent() {
                log(&format!("[Agent] agent 目录: {}", agent_dir.display()));
                // 根据操作系统选择虚拟环境的 Python 可执行文件路径
                #[cfg(target_os = "windows")]
                let venv_candidates: Vec<PathBuf> = vec![
                    agent_dir.join(".venv").join("Scripts").join("python.exe"),
                ];
                #[cfg(not(target_os = "windows"))]
                let venv_candidates: Vec<PathBuf> = vec![
                    agent_dir.join(".venv").join("bin").join("python"),
                    // 候选 2：项目根目录 .venv（开发备选，不被打包）
                    agent_dir.parent().map(|p| p.join(".venv").join("bin").join("python")).unwrap_or_default(),
                ];

                // 遍历候选路径，返回第一个存在且已安装 uvicorn 的解释器
                for venv_python in &venv_candidates {
                    log(&format!("[Agent] 检查虚拟环境候选: {}", venv_python.display()));
                    if venv_python.exists() {
                        // 用原始 venv 路径验证 uvicorn（不能先 canonicalize，因为 venv/bin/python
                        // 是符号链接，解析后指向的系统 Python 不关联虚拟环境的 site-packages）
                        // let verify_path = venv_python.to_string_lossy().to_string();
                        let verify_path = venv_python.display().to_string();
                        log(&format!("[Agent] 虚拟环境 Python 存在，验证 uvicorn: {}", verify_path));
                        if let Ok(uv) = std::process::Command::new(&verify_path)
                            .arg("-c")
                            .arg("import uvicorn")
                            .output()
                        {
                            if uv.status.success() {
                                // 获取绝对路径：canonicalize() 会解析符号链接，但 venv/bin/python
                                // 是符号链接，解析后指向系统 Python 会丢失 site-packages，因此手动
                                // 拼接 current_dir + 规范化 .. 来获得不解析符号链接的绝对路径
                                let abs_path = Self::normalize_path(venv_python);
                                let path = abs_path.display().to_string();
                                log(&format!("[Agent] 使用虚拟环境 Python: {}", path));
                                return path;
                            } else {
                                log(&format!("[Agent] 虚拟环境 Python 未安装 uvicorn，跳过: {}", verify_path));
                            }
                        } else {
                            log(&format!("[Agent] 无法执行虚拟环境 Python: {}", verify_path));
                        }
                    } else {
                        log(&format!("[Agent] 虚拟环境候选不存在: {}", venv_python.display()));
                    }
                }
            }
        } else {
            log("[Agent] 未找到 agent 入口文件");
        }

        // 优先级 3：开发模式，用 which 命令查找系统 PATH 中的 python
        log("[Agent] 尝试通过 which python 查找系统 Python...");
        if let Ok(output) = std::process::Command::new("which")
            .arg("python")
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                log(&format!("[Agent] which python 结果: {}", path));
                // 验证该 python 是否安装了 uvicorn
                if let Ok(uv) = std::process::Command::new(&path)
                    .arg("-c")
                    .arg("import uvicorn")
                    .output()
                {
                    if uv.status.success() {
                        log(&format!("[Agent] 使用系统 Python (which): {}", path));
                        return path;
                    } else {
                        log(&format!("[Agent] 系统 Python 未安装 uvicorn: {}", path));
                    }
                } else {
                    log(&format!("[Agent] 无法执行系统 Python: {}", path));
                }
            } else {
                log("[Agent] which python 返回空结果");
            }
        } else {
            log("[Agent] which python 命令执行失败");
        }

        // 终极降级：返回 "python" 字符串，由系统 PATH 自行解析
        log("[Agent] 所有方式未找到可用 Python，降级使用默认 'python'");
        "python".to_string()
    }

    /// 查找 agent/main.py 入口文件路径
    ///
    /// 查找策略：
    /// 1. 开发模式：从工作目录、src-tauri 父目录、或 current_dir 查找
    /// 2. 生产模式：从 Tauri 打包后的资源目录查找（macOS bundle 或 flat 目录）
    fn find_agent_entry(&self) -> Result<PathBuf, AppError> {
        // ─── 开发模式：从常见的相对/绝对路径查找 ───
        let candidates = vec![
            PathBuf::from("agent/main.py"),                                    // 从工作目录（如项目根目录运行）
            PathBuf::from("../agent/main.py"),                                 // 从 src-tauri 目录运行
            std::env::current_dir()
                .unwrap_or_default()
                .join("agent/main.py"),                                        // 拼接当前工作目录的绝对路径
        ];

        for candidate in &candidates {
            if candidate.exists() {
                return Ok(candidate.clone());
            }
        }

        // ─── 生产模式：从 Tauri 打包后的资源目录查找 ───
        // Tauri 在不同平台上资源位置不同：
        // - macOS .app bundle: Contents/Resources/ （即 exe/../Resources/）
        // - Linux/Windows 及非 bundle 模式: {exe}同目录下的 resources/
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                // macOS .app bundle 特有路径：MyApp.app/Contents/MacOS/exe → ../Resources/agent/
                if let Some(bundle_parent) = parent.parent() {
                    let bundle_path = bundle_parent.join("Resources").join("agent").join("main.py");
                    if bundle_path.exists() {
                        return Ok(bundle_path);
                    }
                }
                // 非 bundle / Linux / Windows 路径：exe 同级目录下的 resources/agent/
                let flat_path = parent.join("resources").join("agent").join("main.py");
                if flat_path.exists() {
                    return Ok(flat_path);
                }
            }
        }

        // 所有候选路径都未找到，返回错误
        Err(AppError::Business(
            "找不到 Agent 服务入口文件 agent/main.py".into(),
        ))
    }

    /// 查找占用指定端口的进程 PID
    ///
    /// 平台实现：
    /// - macOS：使用 `lsof -ti :<port>`，失败时降级到 netstat
    /// - Linux：使用 `fuser <port>/tcp`
    fn find_pid_on_port(port: u16) -> Option<u32> {
        #[cfg(target_os = "macos")]
        {
            // macOS 主方案：lsof -ti :<port>
            //   -t: 简要模式，只输出 PID
            //   -i: 筛选网络连接
            let result = std::process::Command::new("lsof")
                .args(["-ti", &format!(":{}", port)])
                .output();
            match result {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if stdout.is_empty() {
                        // lsof 没找到（权限问题或端口处于 TIME_WAIT 状态）
                        // 降级尝试 netstat 作为后备方案
                        return Self::find_pid_via_netstat(port);
                    }
                    // lsof -t 可能返回多行（多个 PID 占用同一端口），取第一个即可
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
            // Linux：使用 fuser 直接查询端口对应的 PID
            // fuser <port>/tcp 输出格式：端口号后跟 PID
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
    ///
    /// 在 lsof 因权限等原因无法正常工作时作为降级方案
    #[cfg(target_os = "macos")]
    fn find_pid_via_netstat(port: u16) -> Option<u32> {
        // netstat -anv -p tcp 输出所有 TCP 连接详情
        // 通过 ".<port> " 模式匹配 + LISTEN 状态过滤 → 最后一列为 PID
        if let Ok(output) = std::process::Command::new("netstat")
            .args(["-anv", "-p", "tcp"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let pattern = format!(".{} ", port);
            for line in stdout.lines() {
                if line.contains(&pattern) && line.contains("LISTEN") {
                    // netstat 在 macOS 上的输出格式最后一列为 PID
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

    /// 非 macOS 平台的 stub 实现（netstat 仅作为 macOS lsof 的后备）
    #[cfg(not(target_os = "macos"))]
    fn find_pid_via_netstat(_port: u16) -> Option<u32> {
        None
    }

    /// 强制终止占用指定端口的进程
    ///
    /// 同时尝试 kill 子进程组，防止 uvicorn worker 残留。
    /// 原理：uvicorn 启动后会 fork 多个 worker 子进程，
    /// 单纯 kill 主进程可能留下孤儿 worker 继续占用端口。
    fn kill_process_on_port(port: u16) {
        if let Some(pid) = Self::find_pid_on_port(port) {
            eprintln!("[Agent] 发现端口 {} 被 PID {} 占用，发送 SIGKILL...", port, pid);
            #[cfg(unix)]
            {
                // 1) 先杀整个进程组（-pid 取负表示进程组），确保 worker 全部终止
                // 2) 再单独杀主进程，双重保障
                // uvicorn 可能 fork 了 worker，单纯 kill 主进程杀不干净
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL); // 进程组：发送 SIGKILL 到整个进程组
                    libc::kill(pid as i32, libc::SIGKILL);     // 主进程：单独确保主进程被杀死
                }
            }
            #[cfg(windows)]
            {
                // Windows：taskkill /T 会终止进程及其所有子进程，/F 强制终止
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .spawn();
            }
        } else {
            eprintln!("[Agent] 未找到占用端口 {} 的进程 PID（lsof/netstat 均未查到）", port);
        }
    }

    /// 等待端口彻底释放
    ///
    /// 场景：旧 server 进程退出后，TCP 端口可能仍处于 TIME_WAIT 状态，
    /// 此时新进程无法立即绑定同一端口。本方法通过轮询 TCP connect
    /// 来判断端口是否真正可用。
    ///
    /// 参数：
    /// - `timeout_secs`：最长等待时间
    /// - `auto_kill`：是否在检测到占用时自动尝试 kill（用于启动前清理僵尸进程）
    async fn wait_for_port_free(&self, timeout_secs: u64, auto_kill: bool) -> Result<(), String> {
        let start = std::time::Instant::now();
        let addr = format!("127.0.0.1:{}", self.config.port);

        eprintln!("[Agent] 等待端口 {} 释放...", addr);

        // 标记是否已尝试过 kill（避免循环中反复 kill 同一进程）
        let mut kill_attempted = false;

        loop {
            // 用 connect_timeout 测试端口是否可连接（可连接 = 被占用）
            match TcpStream::connect_timeout(
                &addr.parse().unwrap(),
                Duration::from_millis(200),
            ) {
                Ok(_) => {
                    // 端口仍被占用
                    if !kill_attempted && auto_kill {
                        // 首次检测到占用：尝试 kill 占用进程
                        kill_attempted = true;
                        Self::kill_process_on_port(self.config.port);
                        // kill 后等待 500ms 让系统回收端口资源
                        sleep(Duration::from_millis(500)).await;
                        continue;
                    }

                    // 已尝试过 kill 或不允许 auto_kill：检查是否超时
                    if start.elapsed().as_secs() >= timeout_secs {
                        return Err(format!(
                            "端口 {} 在 {} 秒内未释放，可能有僵尸进程占用",
                            addr, timeout_secs
                        ));
                    }
                    // 未超时：等 300ms 后重试
                    sleep(Duration::from_millis(300)).await;
                }
                Err(_) => {
                    // connect 失败 = 端口无人监听 = 已释放
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
    ///
    /// 完整启动流程：
    /// 1. 检查状态（避免重复启动）
    /// 2. 等待端口释放（清理可能存在的僵尸进程）
    /// 3. 查找 Python 解释器和入口文件
    /// 4. 通过 uvicorn 启动 FastAPI 服务
    /// 5. 轮询 /health 端点等待就绪
    /// 6. 验证 Rust ↔ Python 通信链路
    pub async fn start(&self) -> Result<(), AppError> {
        // ─── 步骤 1：状态检查，避免重复启动 ───
        let mut state = self.state.lock().await;
        if *state == AgentState::Running || *state == AgentState::Starting {
            return Ok(()); // 已在运行或启动中
        }
        *state = AgentState::Starting;
        drop(state); // 尽早释放锁，避免死锁

        // ─── 步骤 2：启动前确保端口已释放 ───
        // auto_kill=true：如果发现端口被占用，自动 kill 僵尸进程
        if let Err(e) = self.wait_for_port_free(15, true).await {
            eprintln!("[Agent] 端口检查警告: {}", e);
            // 不阻塞启动，继续尝试（可能是自身残留的 TIME_WAIT 状态）
        }

        // ─── 步骤 3：查找 Python 解释器和入口文件 ───
        let python = self.find_python();
        let entry = self.find_agent_entry()?;

        // 从 agent/main.py 路径推导项目根目录
        // entry = /path/to/project/agent/main.py
        //   → parent → agent/
        //     → parent → 项目根目录
        // 使用 canonicalize 确保路径解析的一致性
        let project_root = entry
            .canonicalize()
            .ok()
            .and_then(|p| {
                p.parent()                  // agent/
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

        // ─── 步骤 4：启动 Python 子进程（uvicorn） ───
        let child = Command::new(&python)
            .arg("-u")                                      // 无缓冲输出，确保日志实时可见
            .arg("-m")
            .arg("uvicorn")                                 // 以模块方式运行 uvicorn
            .arg("agent.main:app")                          // FastAPI app 位于 agent/main.py
            .arg("--host")
            .arg("127.0.0.1")                               // 仅监听本地回环，不暴露到外网
            .arg("--port")
            .arg(self.config.port.to_string())
            .arg("--log-level")
            .arg("debug")                                   // 调试日志级别
            .current_dir(&project_root)                     // 工作目录设为项目根目录
            .env("AGENT_PORT", self.config.port.to_string()) // 注入端口号供 Python 使用
            .env("PYTHONUNBUFFERED", "1")                    // Python 无缓冲输出
            .env("AGENT_TRACE_LEVEL", "DEBUG")               // 启动后默认打开所有调试日志
            .stdout(Stdio::inherit())                        // stdout 转发到 Rust 进程控制台
            .stderr(Stdio::inherit())                        // stderr 转发到 Rust 进程控制台
            .kill_on_drop(true)                              // Rust 侧 drop Child 时自动 kill
            .spawn()
            .context("无法启动 Python 进程")?;

        let pid = child.id();
        eprintln!("[Agent] Server PID: {:?}", pid);

        // 保存子进程句柄（用于后续健康检查和优雅关闭）
        {
            let mut child_lock = self.child.lock().await;
            *child_lock = Some(child);
        }

        // ─── 步骤 5：等待服务就绪 ───
        match self.wait_for_ready().await {
            Ok(()) => {
                // ─── 步骤 6：验证 Rust ↔ Python 通信链路 ───
                // 服务已启动，发送实际 HTTP 请求验证通信正常
                match self.verify_communication().await {
                    Ok(info) => {
                        eprintln!("[Agent] Server 已就绪，通信链路验证通过");
                        eprintln!("[Agent] 服务信息: {}", info);
                    }
                    Err(e) => {
                        // 通信验证失败不阻塞启动，仅打印警告
                        eprintln!("[Agent] 通信链路验证警告: {}", e);
                    }
                }
                // 更新状态为 Running，重置重启计数
                let mut state = self.state.lock().await;
                *state = AgentState::Running;
                let mut count = self.restart_count.lock().await;
                *count = 0;
                Ok(())
            }
            Err(e) => {
                // 启动超时：更新状态为 Crashed
                let mut state = self.state.lock().await;
                *state = AgentState::Crashed(format!("启动超时: {}", e));
                Err(AppError::Business(format!("Agent Server 启动失败: {}", e)))
            }
        }
    }

    /// 启动后验证 Rust ↔ Python 通信链路
    ///
    /// 发送一次真实的 HTTP GET 请求到 /health 端点，
    /// 并解析返回的 JSON 以确认服务版本和模型配置。
    async fn verify_communication(&self) -> Result<String, String> {
        // 创建不经过系统代理的 HTTP 客户端（本地通信不需要代理）
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
        let health_url = format!("{}/health", self.base_url);

        // 发送健康检查请求（5 秒超时）
        let resp = client
            .get(&health_url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("健康检查请求失败: {}", e))?;

        // 检查 HTTP 状态码
        if !resp.status().is_success() {
            return Err(format!("健康检查返回非成功状态: {}", resp.status()));
        }

        // 解析 JSON 响应体，提取版本和模型信息
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

    /// 等待服务就绪（轮询 /health 端点）
    ///
    /// 使用指数退避的轮询策略：
    /// 1. 先等待 500ms 让 uvicorn 完成模块导入和 asyncio loop 初始化
    /// 2. 每 500ms 轮询一次 /health，直到成功或超时
    /// 3. 前 3 秒的失败静默处理，之后打印日志帮助排查问题
    async fn wait_for_ready(&self) -> Result<(), String> {
        let start = std::time::Instant::now();
        // 本地通信不使用代理
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
        let health_url = format!("{}/health", self.base_url);

        eprintln!("[Agent] 开始健康检查轮询: {}", health_url);

        // 先等待 500ms，让 uvicorn 完成内部初始化（导入模块、启动 asyncio event loop 等）
        // 避免因过早轮询导致大量无意义的连接错误日志
        sleep(Duration::from_millis(500)).await;

        while start.elapsed().as_secs() < self.config.startup_timeout_secs {
            match client
                .get(&health_url)
                .timeout(Duration::from_secs(self.config.health_check_timeout_secs))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    // 健康检查成功，服务已就绪
                    eprintln!("[Agent] 健康检查成功 ({}ms)", start.elapsed().as_millis());
                    return Ok(());
                }
                Ok(resp) => {
                    // 服务器响应了但状态码不是 2xx（可能是启动中）
                    eprintln!("[Agent] 健康检查返回非成功状态: {}", resp.status());
                }
                Err(e) => {
                    // 如果启动超过 3 秒仍失败，打印日志帮助排查原因
                    // 3 秒内的失败属于正常的"uvicorn 尚未就绪"阶段
                    if start.elapsed().as_secs() > 3 {
                        eprintln!("[Agent] 健康检查失败 ({}ms): {}", start.elapsed().as_millis(), e);
                    }
                }
            }
            // 每 500ms 轮询一次
            sleep(Duration::from_millis(500)).await;
        }

        // 超时未就绪
        Err(format!(
            "Agent Server 在 {} 秒内未就绪",
            self.config.startup_timeout_secs
        ))
    }

    /// 健康检查（供外部定时调用）
    ///
    /// 返回 true 表示服务健康，false 表示不可达。
    /// 由看门狗定时调用以判断是否需要重启。
    pub async fn check_health(&self) -> bool {
        let client = match reqwest::Client::builder().no_proxy().build() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[Agent] 创建 HTTP 客户端失败: {}", e);
                return false;
            }
        };
        let health_url = format!("{}/health", self.base_url);

        // 发送健康检查请求，仅判断 HTTP 状态码是否 2xx
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

    /// 尝试重启 Agent Server（在崩溃时由看门狗调用）
    ///
    /// 流程：
    /// 1. 检查重启次数是否达到上限
    /// 2. 停止当前进程
    /// 3. 等待 2 秒后重新启动
    /// 4. 如果达到上限，标记为 Crashed 并返回错误
    pub async fn try_restart(&self) -> Result<(), AppError> {
        let mut count = self.restart_count.lock().await;
        if *count >= self.config.max_restart_attempts {
            // 达到最大重启次数：不再尝试，标记为永久崩溃
            let msg = format!(
                "Agent Server 已崩溃 {} 次，达到最大重启次数限制",
                *count
            );
            eprintln!("[Agent] {}", msg);
            let mut state = self.state.lock().await;
            *state = AgentState::Crashed(msg.clone());
            return Err(AppError::Business(msg));
        }

        // 递增重启计数并记录当前是第几次尝试
        *count += 1;
        let attempt = *count;
        drop(count); // 尽早释放锁

        eprintln!(
            "[Agent] 第 {} 次尝试重启（最多 {} 次）",
            attempt,
            self.config.max_restart_attempts
        );

        // 先停止旧进程，清理端口占用
        self.stop().await?;

        // 等待 2 秒让系统资源（端口等）彻底释放后再启动
        sleep(Duration::from_secs(2)).await;

        // 重新启动
        self.start().await
    }

    /// 停止 Agent Server
    ///
    /// 步骤：
    /// 1. 发送 SIGTERM 优雅关闭
    /// 2. 等待最多 10 秒让进程自行退出
    /// 3. 超时则强制 kill
    /// 4. 验证端口是否已释放，未释放则强制清理
    pub async fn stop(&self) -> Result<(), AppError> {
        let mut child_opt = self.child.lock().await;
        if let Some(ref mut child) = *child_opt {
            let pid = child.id();
            eprintln!("[Agent] 正在关闭 Server (PID: {:?})...", pid);

            // 步骤 1：发送 SIGTERM 优雅关闭
            // SIGTERM 允许 uvicorn 完成正在处理的请求后再退出
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

            // 步骤 2-3：等待进程结束
            // 优雅等待 10 秒，超时则强制 kill
            match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
                Ok(Ok(status)) => {
                    // 进程正常退出
                    eprintln!("[Agent] Server 进程已退出: {:?}", status);
                }
                Ok(Err(e)) => {
                    // 等待过程中出错（进程可能已经退出）
                    eprintln!("[Agent] 等待关闭时出错: {}", e);
                    let _ = child.kill().await;
                }
                Err(_) => {
                    // 10 秒超时，强制 kill
                    eprintln!("[Agent] 关闭超时，强制终止");
                    let _ = child.kill().await;
                }
            }
        }

        // 清除子进程句柄
        *child_opt = None;

        // ─── 步骤 4：端口释放验证 ───
        // 即使进程已退出，端口可能仍在 TIME_WAIT；
        // 此外可能有不在此 child 跟踪范围内的僵尸进程（如上次崩溃残留）
        self.verify_port_released(5).await;

        // 更新状态为 Stopped
        let mut state = self.state.lock().await;
        *state = AgentState::Stopped;

        Ok(())
    }

    /// 验证端口是否已释放，若未释放则强制清理
    ///
    /// 在 stop() 后调用，确保端口彻底干净，为下次启动做好准备。
    async fn verify_port_released(&self, timeout_secs: u64) {
        let port = self.config.port;
        let addr = format!("127.0.0.1:{}", port);

        // 快速检查：尝试 connect 看端口是否仍被监听
        match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)) {
            Ok(_) => {
                // 端口仍被占用 → 尝试通过系统命令 kill 占用进程
                eprintln!("[Agent] 端口 {} 仍被占用，尝试强制清理...", addr);
                Self::kill_process_on_port(port);

                // 等待端口释放（最多 timeout_secs 秒）
                let start = std::time::Instant::now();
                loop {
                    if start.elapsed().as_secs() >= timeout_secs {
                        eprintln!("[Agent] 警告: 端口 {} 在 {} 秒内未释放", addr, timeout_secs);
                        break;
                    }
                    match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)) {
                        Ok(_) => {
                            // 仍未释放，等 300ms 后重试
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
                // connect 失败 = 端口已释放
                eprintln!("[Agent] 端口 {} 已释放 ✓", addr);
            }
        }
    }

    /// 暴力关闭（同步版本，不依赖 tokio Child 对象）
    ///
    /// 用于应用退出时的清理场景：
    /// - Tauri runtime 可能已被拆除，tokio Child 不再可用
    /// - 直接通过系统命令 SIGKILL 进程组 + 端口占用检测来保证彻底清理
    /// - 这是同步函数，可在 Drop 或非 async 上下文中调用
    pub fn force_shutdown_sync(&self) {
        let port = self.config.port;

        // 1) 先尝试通过 tokio Child 发送 SIGTERM（如果 runtime 还存活）
        //    使用 try_lock 而不是 async lock，因为这是同步上下文
        if let Ok(mut child_opt) = self.child.try_lock() {
            if let Some(ref mut child) = *child_opt {
                if let Some(pid) = child.id() {
                    eprintln!("[Agent] force_shutdown: 发送 SIGTERM 给 PID {}", pid);
                    #[cfg(unix)]
                    unsafe {
                        // 先向进程组发送 SIGTERM（pid 取负），确保 uvicorn worker 全部终止
                        libc::kill(-(pid as i32), libc::SIGTERM);
                    }
                    // 等待 500ms 让进程自行退出
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    // 如果仍未退出，尝试 start_kill（强制 kill）
                    let _ = child.start_kill();
                }
            }
            *child_opt = None;
        }

        // 2) 再通过端口强制清理（SIGKILL 进程组，确保 worker 不会被残留）
        eprintln!("[Agent] force_shutdown: 通过端口 {} 强制清理残留进程...", port);
        Self::kill_process_on_port(port);

        // 3) 等待端口彻底释放（最多 8 秒）
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
                        // 最后再试一次 kill，尽最大努力清理
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
    ///
    /// 看门狗在独立的 tokio task 中运行，周期性检查 Agent Server 健康状态：
    /// - Running 状态：执行健康检查，失败则尝试重启
    /// - Crashed 状态：已达重启上限，退出看门狗
    /// - 其他状态（Stopped/Starting）：跳过本轮检查
    ///
    /// 通过 Tauri 事件系统向前端发送状态变更通知。
    pub fn spawn_watchdog(manager: Arc<AgentManager>, app: tauri::AppHandle) {
        tauri::async_runtime::spawn(async move {
            // 创建定时器，按配置的健康检查间隔触发
            let mut ticker = interval(Duration::from_secs(
                manager.config.health_check_interval_secs,
            ));

            loop {
                ticker.tick().await;

                let state = manager.state().await;
                match state {
                    AgentState::Running => {
                        // 正常运行中，执行健康检查
                        // 检查逻辑在下面
                    }
                    AgentState::Crashed(_) => {
                        // 已达最大重启次数，退出看门狗（不再继续监控）
                        eprintln!("[Agent] 看门狗：Agent 已崩溃且达到最大重启次数，退出监控");
                        break;
                    }
                    _ => {
                        // Stopped 或 Starting 状态，跳过本轮检查
                        continue;
                    }
                }

                // 执行健康检查
                if !manager.check_health().await {
                    eprintln!("[Agent] 健康检查失败，尝试重启...");
                    // 通知前端：开始重启
                    let _ = app.emit("agent-status-changed", serde_json::json!({
                        "status": "restarting",
                        "message": "Agent 服务无响应，正在自动重启..."
                    }));

                    match manager.try_restart().await {
                        Ok(()) => {
                            // 重启成功 → 通知前端
                            let _ = app.emit("agent-status-changed", serde_json::json!({
                                "status": "running",
                                "message": "Agent 服务已恢复"
                            }));
                        }
                        Err(e) => {
                            // 重启失败（可能达到上限）→ 通知前端
                            let _ = app.emit("agent-status-changed", serde_json::json!({
                                "status": "crashed",
                                "message": format!("Agent 服务异常: {}", e)
                            }));
                            // 检查是否已达到最大重启次数
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
