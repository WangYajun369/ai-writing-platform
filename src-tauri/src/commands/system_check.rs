//! 系统检查命令
//!
//! 在全局设置中提供系统信息检测功能，包括：
//! - 系统类型与版本
//! - Python / Node / Rust 版本
//! - 安装路径信息

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;

use crate::error::AppError;

/// 单个检查项
#[derive(Debug, Clone, Serialize)]
pub struct CheckItem {
    /// 检查项名称
    pub name: String,
    /// 检测到的值
    pub value: String,
    /// 状态：ok / warning / error
    pub status: String,
    /// 补充说明
    pub detail: Option<String>,
}

/// 系统检查完整结果
#[derive(Debug, Clone, Serialize)]
pub struct SystemCheckResult {
    /// 所有检查项
    pub items: Vec<CheckItem>,
    /// 整体是否通过
    pub ok: bool,
}

/// 运行命令并获取输出（去除首尾空白）
fn run_cmd(name: &str, args: &[&str]) -> Result<String, AppError> {
    let output = Command::new(name)
        .args(args)
        .output()
        .map_err(|e| AppError::General(format!("无法执行 {}: {}", name, e)))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(AppError::General(if stderr.is_empty() {
            format!("{} 执行失败（退出码: {:?}）", name, output.status.code())
        } else {
            stderr
        }))
    }
}

/// 获取操作系统详细信息
fn detect_os_info() -> (String, String, String) {
    let os_type = if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        std::env::consts::OS
    };

    let arch = std::env::consts::ARCH;

    let os_version = if cfg!(target_os = "macos") {
        run_cmd("sw_vers", &["-productVersion"]).unwrap_or_else(|_| "未知".to_string())
    } else if cfg!(target_os = "windows") {
        // Windows 使用 ver 命令
        run_cmd("cmd", &["/c", "ver"])
            .unwrap_or_else(|_| "未知".to_string())
    } else if cfg!(target_os = "linux") {
        // 尝试读取 /etc/os-release 获取发行版名称
        let release = std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|content| {
                content
                    .lines()
                    .find(|l| l.starts_with("PRETTY_NAME="))
                    .map(|l| {
                        l.trim_start_matches("PRETTY_NAME=")
                            .trim_matches('"')
                            .to_string()
                    })
            })
            .unwrap_or_else(|| {
                run_cmd("uname", &["-r"]).unwrap_or_else(|_| "未知".to_string())
            });
        release
    } else {
        "不可用".to_string()
    };

    (os_type.to_string(), os_version, arch.to_string())
}

/// 查找 .venv 虚拟环境中的 Python 解释器
/// 优先 agent/.venv（打包位置），再项目根目录 .venv（开发备选）
fn find_venv_python() -> Option<String> {
    // 开发模式：从项目目录查找
    let dev_candidates = vec![
        std::path::PathBuf::from("agent/.venv/bin/python"),        // 主位置（打包分发）
        std::path::PathBuf::from(".venv/bin/python"),              // 项目根目录（开发备选）
        std::path::PathBuf::from("../agent/.venv/bin/python"),     // 从 src-tauri
        std::path::PathBuf::from("../.venv/bin/python"),           // 从 src-tauri（开发备选）
    ];
    for candidate in &dev_candidates {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    // 也尝试从可执行文件同目录的资源路径查找（生产环境打包路径）
    // - macOS .app bundle: Contents/Resources/ （exe/../Resources/）
    // - 非 bundle / Linux / Windows: {exe}同目录下的 resources/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            #[cfg(not(target_os = "windows"))]
            let candidates = {
                let mut v: Vec<std::path::PathBuf> = Vec::new();
                // macOS .app bundle: Contents/Resources/agent/.venv/bin/python
                if let Some(bundle_parent) = parent.parent() {
                    v.push(bundle_parent.join("Resources").join("agent").join(".venv").join("bin").join("python"));
                }
                // 非 bundle 模式: {exe}/resources/agent/.venv/bin/python
                v.push(parent.join("resources").join("agent").join(".venv").join("bin").join("python"));
                // 直接在 {exe} 同目录找 .venv（不太可能但无害）
                v.push(parent.join(".venv").join("bin").join("python"));
                v
            };
            #[cfg(target_os = "windows")]
            let candidates = {
                let mut v: Vec<std::path::PathBuf> = Vec::new();
                if let Some(bundle_parent) = parent.parent() {
                    v.push(bundle_parent.join("Resources").join("agent").join(".venv").join("Scripts").join("python.exe"));
                }
                v.push(parent.join("resources").join("agent").join(".venv").join("Scripts").join("python.exe"));
                v.push(parent.join(".venv").join("Scripts").join("python.exe"));
                v
            };
            for prod_python in &candidates {
                if prod_python.exists() {
                    return Some(prod_python.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// 查找 Python 解释器并获取版本
///
/// 优先级：agent/.venv > PATH 中的 python3 > PATH 中的 python
fn check_python() -> CheckItem {
    // 优先查找 agent/.venv 虚拟环境（与 manager.rs 启动逻辑一致）
    if let Some(venv_path_raw) = find_venv_python() {
        let venv_path = Path::new(&venv_path_raw)
            .canonicalize()
            .map(|p| p.display().to_string())
            .unwrap_or(venv_path_raw);
        if let Ok(version) = run_cmd(&venv_path, &["--version"]) {
            let raw = run_cmd(&venv_path, &["-c", "import sys; print(sys.prefix)"])
                .unwrap_or_else(|_| "无法获取".to_string());
            let lib_path = Path::new(raw.trim())
                .canonicalize()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| raw.trim().to_string());
            // 验证 uvicorn 是否可用
            let uvicorn_ok = std::process::Command::new(&venv_path)
                .arg("-c")
                .arg("import uvicorn")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            let extra = if uvicorn_ok {
                " (uvicorn ✓)"
            } else {
                " (缺少 uvicorn，请运行 uv sync)"
            };
            return CheckItem {
                name: "Python".to_string(),
                value: format!("{} {}", version, extra),
                status: if uvicorn_ok { "ok" } else { "warning" }.to_string(),
                detail: Some(format!("解释器: {} (agent/.venv)\n安装路径: {}", venv_path, lib_path)),
            };
        }
    }

    // 回退：尝试 PATH 中的 python3 / python
    for python_bin in &["python3", "python"] {
        if let Ok(version) = run_cmd(python_bin, &["--version"]) {
            let raw_python_path = run_cmd("which", &[python_bin])
                .unwrap_or_else(|_| python_bin.to_string());
            let python_path = Path::new(raw_python_path.trim())
                .canonicalize()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| raw_python_path.trim().to_string());
            let raw = run_cmd(python_bin, &["-c", "import sys; print(sys.prefix)"])
                .unwrap_or_else(|_| "无法获取".to_string());
            let lib_path = Path::new(raw.trim())
                .canonicalize()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| raw.trim().to_string());
            return CheckItem {
                name: "Python".to_string(),
                value: version,
                status: "ok".to_string(),
                detail: Some(format!("解释器: {} (系统)\n安装路径: {}", python_path, lib_path)),
            };
        }
    }

    CheckItem {
        name: "Python".to_string(),
        value: "未安装".to_string(),
        status: "error".to_string(),
        detail: Some("未检测到 Python 解释器，请安装 Python 3.11+".to_string()),
    }
}

/// 检查 Node.js 版本
fn check_node() -> CheckItem {
    match run_cmd("node", &["--version"]) {
        Ok(version) => {
            // 尝试获取安装路径
            let node_path = run_cmd("which", &["node"])
                .unwrap_or_else(|_| "无法获取".to_string());
            CheckItem {
                name: "Node.js".to_string(),
                value: version,
                status: "ok".to_string(),
                detail: Some(format!("路径: {}", node_path)),
            }
        }
        Err(_) => CheckItem {
            name: "Node.js".to_string(),
            value: "未安装".to_string(),
            status: "warning".to_string(),
            detail: Some("未检测到 Node.js，部分前端构建工具可能不可用".to_string()),
        },
    }
}

/// 检查 Rust 版本
fn check_rust() -> CheckItem {
    match run_cmd("rustc", &["--version"]) {
        Ok(version) => {
            let rustup_path = run_cmd("rustup", &["show", "home"])
                .unwrap_or_else(|_| "无法获取".to_string());
            CheckItem {
                name: "Rust".to_string(),
                value: version,
                status: "ok".to_string(),
                detail: Some(format!("Rustup 路径: {}", rustup_path)),
            }
        }
        Err(_) => CheckItem {
            name: "Rust".to_string(),
            value: "未安装".to_string(),
            status: "warning".to_string(),
            detail: Some("未检测到 Rust，编译本机 Tauri 应用需要 Rust 工具链".to_string()),
        },
    }
}

/// 获取应用安装/数据路径
fn check_paths(app: &AppHandle) -> Vec<CheckItem> {
    let mut items = Vec::new();

    // 可执行文件路径
    let exe_path = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "未知".to_string());
    items.push(CheckItem {
        name: "可执行文件".to_string(),
        value: exe_path.clone(),
        status: "ok".to_string(),
        detail: None,
    });

    // 应用数据目录
    if let Ok(data_dir) = app.path().app_data_dir() {
        let path = data_dir.to_string_lossy().to_string();
        let exists = data_dir.exists();
        items.push(CheckItem {
            name: "数据目录".to_string(),
            value: path.clone(),
            status: if exists { "ok".to_string() } else { "warning".to_string() },
            detail: if exists {
                None
            } else {
                Some("目录不存在（首次启动时将自动创建）".to_string())
            },
        });
    }

    // 工作目录
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "未知".to_string());
    items.push(CheckItem {
        name: "工作目录".to_string(),
        value: cwd,
        status: "ok".to_string(),
        detail: None,
    });

    items
}

/// 系统检查主命令
///
/// 前端通过 `invoke('system_check')` 调用，
/// 返回包含所有检查项的 SystemCheckResult。
#[tauri::command]
pub async fn system_check(app: AppHandle) -> Result<SystemCheckResult, AppError> {
    let mut items: Vec<CheckItem> = Vec::new();

    // ── 系统信息 ──
    let (os_type, os_version, arch) = detect_os_info();
    items.push(CheckItem {
        name: "操作系统".to_string(),
        value: format!("{} {}", os_type, os_version),
        status: "ok".to_string(),
        detail: Some(format!("架构: {}", arch)),
    });

    // ── 运行时版本 ──
    items.push(check_python());
    items.push(check_node());
    items.push(check_rust());

    // ── 安装路径 ──
    items.extend(check_paths(&app));

    // 判断整体状态
    let ok = items.iter().all(|item| item.status != "error");

    Ok(SystemCheckResult { items, ok })
}
