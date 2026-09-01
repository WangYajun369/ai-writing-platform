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
// 日志统一走 crate 级全局宏（控制台 + 调试窗口双写），定义见 src/logging.rs
use crate::{app_log, app_log_console, app_log_error};

/// Agent 启动失败类型
///
/// 用于区分"重试有意义"与"重试无意义"的错误，避免看门狗做无用功：
/// - `Permanent`：环境/配置缺失（找不到解释器、缺依赖、入口文件缺失），重试必然重复失败
/// - `Transient`：进程崩溃、端口占用、网络抖动，重试可能恢复
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AgentFailureKind {
    /// 永久性错误：不应重试
    Permanent,
    /// 临时性错误：可以重试
    Transient,
}

/// Python 进程管理器状态
#[derive(Debug, Clone, PartialEq)]
pub enum AgentState {
    /// 未启动
    Stopped,
    /// 启动中
    Starting,
    /// 运行中
    Running,
    /// 已停止（异常）。携带 (原因, 失败类型)
    Crashed(String, AgentFailureKind),
}

/// Python 启动方式
///
/// 两种形态：
/// - 普通解释器：`program` = 解释器路径，`prefix_args` = 空
/// - uv 项目：`program` = "uv"，`prefix_args` = ["run", "python"]，由 uv 解析项目环境
///
/// 之所以要用前缀参数而不是只存一个路径，是因为 uv 需要先由 `uv run`
/// 解析 pyproject.toml + uv.lock 再执行，无法简化成单个解释器路径。
#[derive(Debug, Clone)]
pub struct PythonLauncher {
    /// 可执行程序
    pub program: String,
    /// 前置参数（uv 模式为 ["run", "python"]）
    pub prefix_args: Vec<String>,
    /// 人类可读描述（用于日志）
    pub description: String,
}

impl PythonLauncher {
    /// 是否为 uv 启动模式（`uv run python`）
    pub fn is_uv(&self) -> bool {
        !self.prefix_args.is_empty()
    }
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

    /// 查找可用的 Python 启动方式
    ///
    /// 优先级：
    /// 1. 用户指定的 python_path
    /// 2. agent/.venv、项目根 .venv 中的解释器（`uv sync` 或 `python -m venv` 创建）
    /// 3. uv 项目环境（uv.lock / pyproject `[tool.uv]` + uv 命令可用）→ `uv run python`
    /// 4. PATH 中的 python3 / python（开发备选）
    ///
    /// 每个候选都同时校验两件事：
    /// - Python 版本不低于项目要求（读 agent/.python-version 或 pyproject requires-python）
    /// - 已安装 uvicorn
    ///
    /// 找不到时返回错误并附带修复指引，而不是降级到一个注定失败的解释器。
    fn find_python(&self) -> Result<PythonLauncher, AppError> {
        // 探测过程先收集到 trace：成功时只打印一行汇总，失败时才逐条输出。
        // 这样可避免启动阶段每个候选都刷日志（看门狗重试还会成倍放大）。
        let mut trace: Vec<String> = Vec::new();

        // 入口文件所在目录（agent/），用于推导 .venv 与读取项目配置
        let agent_dir_opt = self
            .find_agent_entry()
            .ok()
            .and_then(|e| e.parent().map(|p| p.to_path_buf()));
        if agent_dir_opt.is_none() {
            trace.push("[Agent] 未找到 agent 入口文件".to_string());
        }

        // 项目要求的 Python 最低版本
        let required = agent_dir_opt.as_deref().and_then(Self::read_required_python);
        let required_desc = required
            .map(|(a, b)| format!("{}.{}", a, b))
            .unwrap_or_else(|| "未指定".to_string());
        trace.push(format!("[Agent] 项目要求的 Python 版本: >= {}", required_desc));

        // ─── 优先级 1：用户显式指定 ───
        if let Some(ref path) = self.config.python_path {
            app_log!("[Agent] 使用用户指定的 Python 路径: {}", path);
            return Ok(PythonLauncher {
                program: path.clone(),
                prefix_args: vec![],
                description: format!("用户指定 ({})", path),
            });
        }

        // ─── 优先级 2：.venv 虚拟环境 ───
        if let Some(ref agent_dir) = agent_dir_opt {
            // 根据操作系统选择虚拟环境的 Python 可执行文件路径
            #[cfg(target_os = "windows")]
            let venv_candidates: Vec<PathBuf> = vec![
                agent_dir.join(".venv").join("Scripts").join("python.exe"),
            ];
            #[cfg(not(target_os = "windows"))]
            let venv_candidates: Vec<PathBuf> = vec![
                agent_dir.join(".venv").join("bin").join("python"),
                // 项目根目录 .venv（开发备选，不被打包）
                agent_dir
                    .parent()
                    .map(|p| p.join(".venv").join("bin").join("python"))
                    .unwrap_or_default(),
            ];

            for venv_python in &venv_candidates {
                if !venv_python.exists() {
                    trace.push(format!(
                        "[Agent] 虚拟环境候选不存在: {}",
                        venv_python.display()
                    ));
                    continue;
                }
                // 用原始 venv 路径探测（不能先 canonicalize：venv/bin/python 是符号链接，
                // 解析后会指向系统 Python，丢失 venv 的 site-packages）
                let verify_path = venv_python.display().to_string();
                match Self::probe_python(&verify_path, &[], required) {
                    Ok(ver) => {
                        // 归一化为绝对路径（同样不解析符号链接）
                        let abs_path = Self::normalize_path(venv_python).display().to_string();
                        app_log!("[Agent] 使用虚拟环境 Python: {} (Python {})", abs_path, ver);
                        return Ok(PythonLauncher {
                            program: abs_path,
                            prefix_args: vec![],
                            description: format!("虚拟环境 Python {}", ver),
                        });
                    }
                    Err(reason) => trace.push(format!(
                        "[Agent] 虚拟环境候选不可用: {} ({})",
                        verify_path, reason
                    )),
                }
            }
        }

        // ─── 优先级 3：uv 项目环境 ───
        // 本项目用 uv 管理依赖（uv.lock + pyproject [tool.uv]），交由 uv 解析环境，
        // 无需用户预先 sync —— 依赖缺失时 uv 会在启动时自动同步。
        if let Some(ref agent_dir) = agent_dir_opt {
            if Self::is_uv_project(agent_dir) {
                match Self::find_uv() {
                    Some(uv) => {
                        // 刻意不做 `uv run python -c "import uvicorn"` 探测：
                        // 当 .venv 不存在时，uv run 会自动创建环境并下载依赖，
                        // 而 std::process::Command::output() 是同步阻塞的，会卡住整个启动流程。
                        // uv.lock 已保证依赖可解析，改由启动阶段的健康检查兜底（并放宽超时）。
                        app_log!(
                            "[Agent] 检测到 uv 项目，采用 {} run python 启动（依赖由 uv 按需同步）",
                            uv
                        );
                        return Ok(PythonLauncher {
                            program: uv,
                            prefix_args: vec!["run".to_string(), "python".to_string()],
                            description: "uv 项目环境".to_string(),
                        });
                    }
                    None => trace
                        .push("[Agent] 项目为 uv 管理，但 PATH 中未找到 uv 命令".to_string()),
                }
            }
        }

        // ─── 优先级 4：PATH 中的 python3 / python ───
        for cmd in ["python3", "python"] {
            let output = match std::process::Command::new("which").arg(cmd).output() {
                Ok(o) => o,
                Err(_) => {
                    trace.push(format!("[Agent] which {} 命令执行失败", cmd));
                    continue;
                }
            };
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                trace.push(format!("[Agent] which {} 返回空结果", cmd));
                continue;
            }
            match Self::probe_python(&path, &[], required) {
                Ok(ver) => {
                    app_log!("[Agent] 使用系统 Python: {} (Python {})", path, ver);
                    return Ok(PythonLauncher {
                        // clone：path 还被 match scrutinee 借用着，不能直接 move
                        program: path.clone(),
                        prefix_args: vec![],
                        description: format!("系统 Python {} ({})", ver, path),
                    });
                }
                Err(reason) => {
                    trace.push(format!("[Agent] 系统 Python 不可用: {} ({})", path, reason))
                }
            }
        }

        // 全部失败：输出完整探测轨迹（成功路径不会走到这里，因此不影响正常启动的日志量）
        for line in &trace {
            app_log_error!("{}", line);
        }
        Err(AppError::Business(format!(
            "未找到可用的 Python 环境（需 Python >= {} 且已安装 uvicorn）。\
             请在 agent/ 目录用 uv 同步依赖：cd agent && uv sync \
             （或使用项目脚本：pnpm agent:setup --dev）",
            required_desc
        )))
    }

    /// 探测候选 Python 是否可用
    ///
    /// 一次子进程调用同时取得「版本」与「uvicorn 可用性」，减少子进程开销。
    /// 返回 Ok("3.14.6") 表示可用；Err(原因) 表示不可用。
    fn probe_python(
        program: &str,
        prefix_args: &[String],
        required: Option<(u32, u32)>,
    ) -> Result<String, String> {
        // 输出格式："<major>.<minor>;<1|0>"，后者表示 uvicorn 是否可导入
        let script = concat!(
            "import sys\n",
            "v=sys.version_info\n",
            "print('%d.%d'%(v.major,v.minor),end=';')\n",
            "try:\n",
            "    import uvicorn\n",
            "    print('1')\n",
            "except Exception:\n",
            "    print('0')\n",
        );

        let mut cmd = std::process::Command::new(program);
        cmd.args(prefix_args).arg("-c").arg(script);
        let out = cmd.output().map_err(|e| format!("无法执行: {}", e))?;
        if !out.status.success() {
            return Err("执行失败".to_string());
        }

        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let mut parts = text.split(';');
        let version = parts.next().unwrap_or("").to_string();
        let has_uvicorn = parts.next() == Some("1");

        if !has_uvicorn {
            return Err("未安装 uvicorn".to_string());
        }

        // 版本校验：低于项目要求则拒绝。
        // 否则可能选中系统旧版 Python（如 macOS 自带的 3.9），
        // 导致 Agent 在运行期因语法/特性不支持而崩溃，排查成本很高。
        if let Some((req_major, req_minor)) = required {
            if let Some((major, minor)) = Self::parse_version_pair(&version) {
                if (major, minor) < (req_major, req_minor) {
                    return Err(format!(
                        "Python {} 低于项目要求的 {}.{}",
                        version, req_major, req_minor
                    ));
                }
            }
        }

        Ok(version)
    }

    /// 判断子进程 stderr 的一行是否为错误线索
    ///
    /// 只影响"是否写入调试窗口缓冲"，控制台始终保留完整输出。
    /// uvicorn 以 `--log-level debug` 运行时 stderr 混杂大量 INFO/DEBUG，
    /// 全量写入会占满 1000 条缓冲并挤掉其它模块的日志。
    fn is_error_line(line: &str) -> bool {
        let lower = line.to_lowercase();
        lower.contains("traceback")
            || lower.contains("error")
            || lower.contains("exception")
            || lower.contains("failed")
            || lower.contains("modulenotfound")
            // uv 依赖解析失败（如 uv.lock 与 pyproject 不一致）
            || lower.contains("no solution")
    }

    /// 读取项目要求的最低 Python 版本
    ///
    /// 优先级：agent/.python-version（如 "3.14.2"）→ pyproject.toml 的 requires-python（如 ">=3.14"）
    /// 都读不到时返回 None（表示不做版本校验）。
    fn read_required_python(agent_dir: &std::path::Path) -> Option<(u32, u32)> {
        if let Ok(s) = std::fs::read_to_string(agent_dir.join(".python-version")) {
            if let Some(v) = Self::parse_version_pair(s.trim()) {
                return Some(v);
            }
        }
        if let Ok(s) = std::fs::read_to_string(agent_dir.join("pyproject.toml")) {
            for line in s.lines() {
                let line = line.trim();
                // 形如：requires-python = ">=3.14"
                if let Some(rest) = line.strip_prefix("requires-python") {
                    if let Some(quoted) = rest.split('"').nth(1) {
                        let digits = quoted.trim_start_matches(|c: char| !c.is_ascii_digit());
                        if let Some(v) = Self::parse_version_pair(digits) {
                            return Some(v);
                        }
                    }
                }
            }
        }
        None
    }

    /// 解析 "3.14.2" / "3.14" → (3, 14)
    fn parse_version_pair(s: &str) -> Option<(u32, u32)> {
        let mut it = s.split('.');
        let major: u32 = it.next()?.trim().parse().ok()?;
        let minor: u32 = it.next()?.trim().parse().ok()?;
        Some((major, minor))
    }

    /// 判断 agent 目录是否为 uv 管理的项目
    ///
    /// 依据：存在 uv.lock，或 pyproject.toml 含 [tool.uv] 段。
    fn is_uv_project(agent_dir: &std::path::Path) -> bool {
        if agent_dir.join("uv.lock").exists() {
            return true;
        }
        std::fs::read_to_string(agent_dir.join("pyproject.toml"))
            .map(|s| s.contains("[tool.uv]"))
            .unwrap_or(false)
    }

    /// 在 PATH 中查找 uv 命令
    fn find_uv() -> Option<String> {
        let out = std::process::Command::new("which").arg("uv").output().ok()?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
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
                // 归一化为绝对路径：候选里含 "agent/main.py"、"../agent/main.py" 等相对路径，
                // 后续要用它拼接 .venv 路径、并推导子进程 cwd，依赖 CWD 容易出错。
                // 用 normalize_path 而非 canonicalize，避免解析符号链接破坏 venv。
                return Ok(Self::normalize_path(candidate));
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
                        return Ok(Self::normalize_path(&bundle_path));
                    }
                }
                // 非 bundle / Linux / Windows 路径：exe 同级目录下的 resources/agent/
                let flat_path = parent.join("resources").join("agent").join("main.py");
                if flat_path.exists() {
                    return Ok(Self::normalize_path(&flat_path));
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
                    app_log!("[Agent] lsof 返回了无法解析的内容: '{}'", stdout);
                }
                Err(e) => {
                    app_log!("[Agent] lsof 命令执行失败: {}", e);
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
            app_log!("[Agent] 发现端口 {} 被 PID {} 占用，发送 SIGKILL...", port, pid);
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
            app_log!("[Agent] 未找到占用端口 {} 的进程 PID（lsof/netstat 均未查到）", port);
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

        app_log!("[Agent] 等待端口 {} 释放...", addr);

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
                    app_log!(
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
            app_log!("[Agent] 端口检查警告: {}", e);
            // 不阻塞启动，继续尝试（可能是自身残留的 TIME_WAIT 状态）
        }

        // ─── 步骤 3：查找 Python 启动方式与入口文件 ───
        // 失败时必须把状态置为 Crashed，不能停留在 Starting：
        // 看门狗对 Starting 状态是 continue 跳过，否则 Agent 会永久卡在"启动中"且不再重试。
        // 这两类失败都是环境/配置缺失，属永久性错误，标记 Permanent 让看门狗不再无谓重试。
        let launcher = match self.find_python() {
            Ok(l) => l,
            Err(e) => {
                let mut state = self.state.lock().await;
                *state = AgentState::Crashed(e.to_string(), AgentFailureKind::Permanent);
                return Err(e);
            }
        };
        let entry = match self.find_agent_entry() {
            Ok(p) => p,
            Err(e) => {
                let mut state = self.state.lock().await;
                *state = AgentState::Crashed(e.to_string(), AgentFailureKind::Permanent);
                return Err(e);
            }
        };

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

        app_log!(
            "[Agent] 启动 Server [{}]: {} {} -m uvicorn agent.main:app (端口: {}, cwd: {})",
            launcher.description,
            launcher.program,
            launcher.prefix_args.join(" "),
            self.config.port,
            project_root.display()
        );

        // ─── 步骤 4：启动 Python 子进程（uvicorn） ───
        // uv 模式：   uv run python -u -m uvicorn ...（由 uv 解析 pyproject/uv.lock 并按需同步依赖）
        // 普通模式：  <解释器> -u -m uvicorn ...
        let mut child = Command::new(&launcher.program)
            .args(&launcher.prefix_args)                    // uv 模式为 ["run","python"]，普通模式为空
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
            .stderr(Stdio::piped())                          // stderr 走管道：既转发控制台，也写入调试窗口缓冲
            .kill_on_drop(true)                              // Rust 侧 drop Child 时自动 kill
            .spawn()
            .context("无法启动 Python 进程")?;

        // 读取 Python 子进程 stderr：原样转发到控制台，仅错误线索写入调试窗口。
        // 原本使用 Stdio::inherit() 时 Rust 拿不到子进程的错误内容，
        // uvicorn 启动失败（如 No module named uvicorn）只能靠用户肉眼在控制台找。
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    // 控制台保留完整输出，便于排查
                    app_log_console!("{}", line);
                    // 调试窗口只收错误行：uvicorn 以 debug 级别运行，
                    // stderr 混杂大量 INFO/DEBUG，全量写入会挤爆 1000 条缓冲
                    if Self::is_error_line(&line) {
                        app_log_error!("[Python] {}", line);
                    }
                }
            });
        }

        let pid = child.id();
        app_log!("[Agent] Server PID: {:?}", pid);

        // 保存子进程句柄（用于后续健康检查和优雅关闭）
        {
            let mut child_lock = self.child.lock().await;
            *child_lock = Some(child);
        }

        // ─── 步骤 5：等待服务就绪 ───
        // wait_for_ready 会返回最后一次成功的 /health 响应体，供下面解析服务信息复用，
        // 因此这里不再额外发送一次 /health（原实现 verify_communication 会重复请求）。
        // uv 模式首次启动可能需要现场创建虚拟环境并下载全部依赖，放宽启动超时
        let startup_timeout = if launcher.is_uv() {
            self.config.startup_timeout_secs.max(180)
        } else {
            self.config.startup_timeout_secs
        };
        match self.wait_for_ready(startup_timeout).await {
            Ok(health_body) => {
                // ─── 步骤 6：解析服务信息，确认 Rust ↔ Python 通信链路正常 ───
                app_log!("[Agent] Server 已就绪，通信链路验证通过");
                app_log!(
                    "[Agent] 服务信息: {}",
                    Self::parse_service_info(&health_body)
                );
                // 更新状态为 Running，重置重启计数
                let mut state = self.state.lock().await;
                *state = AgentState::Running;
                let mut count = self.restart_count.lock().await;
                *count = 0;
                Ok(())
            }
            Err(e) => {
                // 启动超时 / 进程意外退出属于临时性错误，可由看门狗重试恢复
                let mut state = self.state.lock().await;
                *state =
                    AgentState::Crashed(format!("启动超时: {}", e), AgentFailureKind::Transient);
                Err(AppError::Business(format!("Agent Server 启动失败: {}", e)))
            }
        }
    }

    /// 从 /health 响应体中解析服务信息（版本 + 本地/云端模型）
    ///
    /// 纯函数，不发起网络请求：响应体由 wait_for_ready 复用而来。
    fn parse_service_info(body: &serde_json::Value) -> String {
        let version = body["version"].as_str().unwrap_or("unknown");
        let config = &body["config"];
        let local_model = config["local_model"].as_str().unwrap_or("N/A");
        let cloud_model = config["cloud_model"].as_str().unwrap_or("N/A");
        format!(
            "version={}, local_model={}, cloud_model={}",
            version, local_model, cloud_model
        )
    }

    /// 等待服务就绪（轮询 /health 端点）
    ///
    /// 返回最后一次成功的 /health 响应体，供调用方解析服务信息，
    /// 避免 start() 再单独发一次 /health 请求。
    ///
    /// 参数 `timeout_secs`：启动等待超时。uv 模式首次启动需现场同步依赖，
    /// 调用方会传入放大的值（见 start()）。
    ///
    /// 轮询策略：
    /// 1. 先等待 500ms 让 uvicorn 完成模块导入和 asyncio loop 初始化
    /// 2. 每 500ms 轮询一次 /health，直到成功或超时；每轮先探测子进程是否已退出
    /// 3. 失败日志按 5 秒节流，避免刷屏
    async fn wait_for_ready(&self, timeout_secs: u64) -> Result<serde_json::Value, String> {
        let start = std::time::Instant::now();
        // 本地通信不使用代理
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
        let health_url = format!("{}/health", self.base_url);

        app_log!("[Agent] 开始健康检查轮询: {}", health_url);

        // 先等待 500ms，让 uvicorn 完成内部初始化（导入模块、启动 asyncio event loop 等）
        // 避免因过早轮询导致大量无意义的连接错误日志
        sleep(Duration::from_millis(500)).await;

        // 日志节流：每 5 秒最多打印一次失败日志（避免 500ms 一次刷屏）
        let log_interval = Duration::from_secs(5);
        let mut last_log = std::time::Instant::now();

        while start.elapsed().as_secs() < timeout_secs {
            // 关键：先探测子进程是否已意外退出。
            // uvicorn 若因模块缺失（如 No module named uvicorn）或端口冲突，
            // 会在 1 秒内退出；若只轮询 HTTP 会白等满 startup_timeout（默认 30 秒）才报错。
            {
                let mut child_lock = self.child.lock().await;
                if let Some(ref mut child) = *child_lock {
                    if let Ok(Some(status)) = child.try_wait() {
                        return Err(format!(
                            "Agent 进程启动后立即退出（状态码: {}）。\
                             常见原因：Python 解释器未安装 uvicorn、依赖缺失或端口 {} 被占用，\
                             详见上方 Python 错误输出",
                            status, self.config.port
                        ));
                    }
                }
            }

            match client
                .get(&health_url)
                .timeout(Duration::from_secs(self.config.health_check_timeout_secs))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    // 健康检查成功，服务已就绪
                    app_log!("[Agent] 健康检查成功 ({}ms)", start.elapsed().as_millis());
                    // 直接解析响应体返回，供调用方复用（不再单独发一次 /health）
                    return resp
                        .json::<serde_json::Value>()
                        .await
                        .map_err(|e| format!("解析健康检查响应失败: {}", e));
                }
                Ok(resp) => {
                    // 服务器响应了但状态码不是 2xx（可能是启动中）
                    if last_log.elapsed() >= log_interval {
                        last_log = std::time::Instant::now();
                        app_log_error!("[Agent] 健康检查返回非成功状态: {}", resp.status());
                    }
                }
                Err(e) => {
                    // 启动超过 3 秒仍失败才打印，且按 5 秒节流
                    // （3 秒内的失败属于正常的"uvicorn 尚未就绪"阶段）
                    if start.elapsed().as_secs() > 3 && last_log.elapsed() >= log_interval {
                        last_log = std::time::Instant::now();
                        app_log_error!(
                            "[Agent] 健康检查失败 ({}ms): {}",
                            start.elapsed().as_millis(),
                            e
                        );
                    }
                }
            }
            // 每 500ms 轮询一次
            sleep(Duration::from_millis(500)).await;
        }

        // 超时未就绪
        Err(format!("Agent Server 在 {} 秒内未就绪", timeout_secs))
    }

    /// 健康检查（供外部定时调用）
    ///
    /// 返回 true 表示服务健康，false 表示不可达。
    /// 由看门狗定时调用以判断是否需要重启。
    pub async fn check_health(&self) -> bool {
        let client = match reqwest::Client::builder().no_proxy().build() {
            Ok(c) => c,
            Err(e) => {
                app_log_error!("[Agent] 创建 HTTP 客户端失败: {}", e);
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
                app_log_error!("[Agent] 健康检查失败: {}", e);
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
            app_log_error!("[Agent] {}", msg);
            let mut state = self.state.lock().await;
            // 达到上限后即为永久性失败，看门狗据此停止重试
            *state = AgentState::Crashed(msg.clone(), AgentFailureKind::Permanent);
            return Err(AppError::Business(msg));
        }

        // 递增重启计数并记录当前是第几次尝试
        *count += 1;
        let attempt = *count;
        drop(count); // 尽早释放锁

        app_log!(
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
            app_log!("[Agent] 正在关闭 Server (PID: {:?})...", pid);

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
                    app_log!("[Agent] Server 进程已退出: {:?}", status);
                }
                Ok(Err(e)) => {
                    // 等待过程中出错（进程可能已经退出）
                    app_log!("[Agent] 等待关闭时出错: {}", e);
                    let _ = child.kill().await;
                }
                Err(_) => {
                    // 10 秒超时，强制 kill
                    app_log!("[Agent] 关闭超时，强制终止");
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
                app_log!("[Agent] 端口 {} 仍被占用，尝试强制清理...", addr);
                Self::kill_process_on_port(port);

                // 等待端口释放（最多 timeout_secs 秒）
                let start = std::time::Instant::now();
                loop {
                    if start.elapsed().as_secs() >= timeout_secs {
                        app_log!("[Agent] 警告: 端口 {} 在 {} 秒内未释放", addr, timeout_secs);
                        break;
                    }
                    match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200)) {
                        Ok(_) => {
                            // 仍未释放，等 300ms 后重试
                            sleep(Duration::from_millis(300)).await;
                        }
                        Err(_) => {
                            app_log!("[Agent] 端口 {} 已确认释放", addr);
                            break;
                        }
                    }
                }
            }
            Err(_) => {
                // connect 失败 = 端口已释放
                app_log!("[Agent] 端口 {} 已释放 ✓", addr);
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
                    app_log!("[Agent] force_shutdown: 发送 SIGTERM 给 PID {}", pid);
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
        app_log!("[Agent] force_shutdown: 通过端口 {} 强制清理残留进程...", port);
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
                        app_log!(
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
                    app_log!(
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
                        // 正常运行中：执行健康检查，健康则跳过本轮
                        if manager.check_health().await {
                            continue;
                        }
                        app_log_error!("[Agent] 健康检查失败，尝试重启...");
                    }
                    AgentState::Crashed(ref reason, kind) => {
                        // 永久性错误（环境/配置缺失，如找不到 Python、缺 uvicorn、入口文件缺失）：
                        // 重试必然重复同样的失败，还会重复执行整套环境探测，直接放弃并提示用户。
                        if kind == AgentFailureKind::Permanent {
                            app_log_error!(
                                "[Agent] 看门狗：检测到永久性错误（环境/配置问题），停止重试：{}",
                                reason
                            );
                            let _ = app.emit("agent-status-changed", serde_json::json!({
                                "status": "crashed",
                                "message": format!("Agent 服务不可用（需人工处理）: {}", reason)
                            }));
                            break;
                        }

                        // 临时性错误：区分"运行期崩溃且已耗尽重启次数"与"首次启动失败"
                        //   ① 已耗尽重启次数 → 真正放弃
                        //   ② 启动失败（restart_count 仍为 0）→ 继续尝试重启
                        let count = *manager.restart_count.lock().await;
                        if count >= manager.config.max_restart_attempts {
                            app_log_error!(
                                "[Agent] 看门狗：Agent 已崩溃且达到最大重启次数（{}/{}），退出监控",
                                count, manager.config.max_restart_attempts
                            );
                            let _ = app.emit("agent-status-changed", serde_json::json!({
                                "status": "crashed",
                                "message": format!("Agent 服务不可用: {}", reason)
                            }));
                            break;
                        }
                        app_log!(
                            "[Agent] 看门狗：检测到 Agent 崩溃（{}/{} 次重启），尝试重启...",
                            count, manager.config.max_restart_attempts
                        );
                    }
                    _ => {
                        // Stopped 或 Starting 状态，跳过本轮检查
                        continue;
                    }
                }

                {
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
                            // 只有真正耗尽重启次数才退出监控。
                            // 注意：不能用 state == Crashed 判定，因为启动失败也会置为 Crashed，
                            // 那样会在第一次启动失败时就永久退出监控。
                            let count = *manager.restart_count.lock().await;
                            if count >= manager.config.max_restart_attempts {
                                app_log_error!(
                                    "[Agent] 看门狗：已耗尽 {}/{} 次重启机会，退出监控",
                                    count, manager.config.max_restart_attempts
                                );
                                break;
                            }
                        }
                    }
                }
            }
        });
    }
}
