//! 数据导入导出模块
//!
//! 包含：格式导出（TXT/MD/HTML）、TXT 导入、加密备份、全量/单作品数据迁移。

pub mod backup;
pub mod crypto;
pub mod export;
pub mod import_txt;

use crate::error::AppError;
use std::sync::atomic::{AtomicBool, Ordering};

/// 导入/导出命令级互斥（Spec §9 并发：双窗口防重）。
/// 只读预检（`inspect_backup`）不占用；写型命令（备份导入/导出、TXT 导入、格式导出、回滚）互斥。
static IO_OP_RUNNING: AtomicBool = AtomicBool::new(false);

/// 占用导入/导出通道；已有操作进行中则返回 `E_IO_BUSY`。
pub fn try_acquire_io_lock() -> Result<IoOpGuard, AppError> {
    if IO_OP_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::Business(
            "E_IO_BUSY：已有导入/导出操作正在进行，请完成后再试".into(),
        ));
    }
    Ok(IoOpGuard)
}

/// RAII 释放：命令返回（成功/失败）时自动释放互斥
#[derive(Debug)]
pub struct IoOpGuard;

impl Drop for IoOpGuard {
    fn drop(&mut self) {
        IO_OP_RUNNING.store(false, Ordering::SeqCst);
    }
}
