//! 系统检查命令
//!
//! 在全局设置中提供系统信息检测功能，包括：
//! - 系统类型与版本
//! - Python / Node / Rust 版本
//! - 安装路径信息

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

/// 查找 Python 解释器并获取版本
fn check_python() -> CheckItem {
    // 尝试多个可能的解释器名
    for python_bin in &["python3", "python"] {
        if let Ok(output) = Command::new("which")
            .arg(python_bin)
            .output()
        {
            let python_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !python_path.is_empty() {
                match run_cmd("python3", &["--version"]) {
                    Ok(version) => {
                        // 尝试获取安装路径
                        let lib_path = run_cmd("python3", &["-c", "import sys; print(sys.prefix)"])
                            .unwrap_or_else(|_| "无法获取".to_string());
                        return CheckItem {
                            name: "Python".to_string(),
                            value: version,
                            status: "ok".to_string(),
                            detail: Some(format!("解释器: {}\n安装路径: {}", python_path, lib_path)),
                        };
                    }
                    Err(_) => {
                        // python3 在 PATH 但获取版本失败，尝试 python
                        if let Ok(version) = run_cmd("python", &["--version"]) {
                            let lib_path = run_cmd("python", &["-c", "import sys; print(sys.prefix)"])
                                .unwrap_or_else(|_| "无法获取".to_string());
                            return CheckItem {
                                name: "Python".to_string(),
                                value: version,
                                status: "ok".to_string(),
                                detail: Some(format!(
                                    "解释器: {}\n安装路径: {}",
                                    python_path, lib_path
                                )),
                            };
                        }
                    }
                }
            }
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
