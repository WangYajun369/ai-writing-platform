//! 统一错误类型
//!
//! 使用 thiserror 定义项目中所有可能的错误类型，
//! 实现自动 Display 和 From 转换以简化错误传播。
//!
//! AppError 实现 Serialize，可作为 Tauri 命令的 Err 类型直接返回，
//! 前端可通过字符串解析获取错误信息。

use serde::Serialize;
use thiserror::Error;

/// 应用级错误枚举
#[derive(Debug, Error)]
pub enum AppError {
    #[error("数据库连接池错误: {0}")]
    DbPool(String),

    #[error("数据库操作错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("HTTP 请求错误: {0}")]
    Http(String),

    #[error("序列化错误: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("加密/解密错误: {0}")]
    Crypto(String),

    #[error("数据校验错误: {0}")]
    Validation(String),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("业务逻辑错误: {0}")]
    Business(String),

    #[error("{0}")]
    General(String),
}

// 序列化为字符串，使 AppError 可直接作为 Tauri 命令的 Err 类型
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::General(e.to_string())
    }
}

impl From<r2d2::Error> for AppError {
    fn from(e: r2d2::Error) -> Self {
        AppError::DbPool(e.to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Business(s)
    }
}
