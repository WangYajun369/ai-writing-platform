//! Agent 插件 IPC 命令层（ADR-006）
//!
//! 薄薄一层转发到 [`crate::plugin::loader`]：命令只做参数透传与 AppHandle 注入，
//! 业务规则（清单校验、权限校验、启用清单持久化）全部留在 loader 里，
//! 便于不启动 Tauri 的情况下单测。
//!
//! ## 命令命名
//!
//! 统一 `plugin_` 前缀，便于前端与 `ipc-commands.ts` 契约中成组识别。

use tauri::AppHandle;

use crate::error::AppError;
use crate::plugin::loader;
use crate::plugin::model::InstalledPlugin;

/// 列出全部已安装插件（含装坏的，`status: "error"` 并附原因）
#[tauri::command]
pub fn plugin_list(app: AppHandle) -> Result<Vec<InstalledPlugin>, AppError> {
    loader::list_plugins(&app)
}

/// 安装插件：从本地目录复制 `manifest.json` + 入口文件到 `plugins/<id>/`
///
/// `src_dir` 由前端经文件选择对话框取得。安装后默认**未启用**——
/// 须用户在确认界面阅读源码、逐项确认 `grants` 后再调 [`plugin_set_enabled`]。
#[tauri::command]
pub fn plugin_install(app: AppHandle, src_dir: String) -> Result<InstalledPlugin, AppError> {
    loader::install_plugin(&app, std::path::Path::new(&src_dir))
}

/// 卸载插件：删除目录并从启用清单移除
#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, id: String) -> Result<(), AppError> {
    loader::uninstall_plugin(&app, &id)
}

/// 启用 / 停用插件
///
/// 启用前会重跑全量校验（插件可能在安装之后才变坏）。
#[tauri::command]
pub fn plugin_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), AppError> {
    loader::set_plugin_enabled(&app, &id, enabled)
}

/// 读取插件入口源码（供安装确认界面原样展示，让用户审核后再启用）
#[tauri::command]
pub fn plugin_source(app: AppHandle, id: String) -> Result<String, AppError> {
    loader::read_plugin_source(&app, &id)
}
