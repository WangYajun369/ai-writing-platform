//! 数据导入导出模块
//!
//! 包含：格式导出（TXT/MD/HTML）、TXT 导入、加密备份、全量/单作品数据迁移。

pub mod backup;
pub mod crypto;
pub mod export;
pub mod import_txt;

use crate::error::AppError;
use crate::observability::bus;
use std::sync::atomic::{AtomicBool, Ordering};

/// 导入/导出命令级互斥（Spec §9 并发：双窗口防重）。
/// 只读预检（`inspect_backup`）不占用；写型命令（备份导入/导出、TXT 导入、格式导出、回滚）互斥。
static IO_OP_RUNNING: AtomicBool = AtomicBool::new(false);

/// 占用导入/导出通道；已有操作进行中则返回 `E_IO_BUSY`。
///
/// v1.9：acquire/release/busy 三态均通过 `bus::emit_io` 推送 telemetry 事件,
/// 调试控制台可见 IO 通道状态变化,不必靠错误码反推。
pub fn try_acquire_io_lock(app: Option<&tauri::AppHandle>) -> Result<IoOpGuard, AppError> {
    match IO_OP_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => {
            bus::emit_io(app, "acquire", "IO 通道已占用", file!(), line!());
            Ok(IoOpGuard::new(app.cloned()))
        }
        Err(_) => {
            bus::emit_io(app, "busy", "IO 通道被占用,拒绝新请求", file!(), line!());
            Err(AppError::Business(
                "E_IO_BUSY：已有导入/导出操作正在进行，请完成后再试".into(),
            ))
        }
    }
}

/// RAII 释放：命令返回（成功/失败）时自动释放互斥
#[derive(Debug)]
pub struct IoOpGuard {
    /// 携带 app 引用以便 drop 时 emit 释放事件
    app: Option<tauri::AppHandle>,
}

impl IoOpGuard {
    /// 创建 guard,携带 app 引用(drop 时 emit 释放事件)
    pub fn new(app: Option<tauri::AppHandle>) -> Self {
        Self { app }
    }
}

impl Drop for IoOpGuard {
    fn drop(&mut self) {
        IO_OP_RUNNING.store(false, Ordering::SeqCst);
        if let Some(app) = self.app.as_ref() {
            bus::emit_io(Some(app), "release", "IO 通道已释放", file!(), line!());
        }
    }
}
