//! 统一错误类型
//!
//! 使用 thiserror 定义项目中所有可能的错误类型，
//! 实现自动 Display 和 From 转换以简化错误传播。
//!
//! AppError 实现 Serialize，可作为 Tauri 命令的 Err 类型直接返回。
//! 序列化输出结构为 `{ code, message }`：
//! - `code`：稳定错误码（Spec §10，`E_` 前缀）。消息文本自带 `E_XXX：` 前缀时
//!   原样提取；否则按变体归入默认码（`E_BUSINESS` / `E_DB` / `E_IO` …）。
//! - `message`：人类可读描述（Display 文本，兼容既有日志与测试断言）。

use serde::{ser::SerializeMap, Serialize};
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

impl AppError {
    /// 消息文本内的稳定错误码（`E_` 前缀 + 大写字母/数字/下划线），
    /// 形如 `E_TXT_READ：读取 TXT 失败`，冒号可为全角 `：` 或半角 `:`。
    fn extract_code(message: &str) -> Option<&str> {
        if !message.starts_with("E_") {
            return None;
        }
        let mut end = message.len();
        for (i, c) in message.char_indices().skip(2) {
            if !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
                end = i;
                break;
            }
        }
        let code = &message[..end];
        (code.len() > 2).then_some(code)
    }

    /// 稳定错误码（Spec §10）：优先提取消息内 `E_` 前缀，否则按变体归默认码。
    pub fn code(&self) -> String {
        match self {
            AppError::DbPool(_) => "E_DB_POOL".to_string(),
            AppError::Db(_) => "E_DB".to_string(),
            AppError::Http(_) => "E_HTTP".to_string(),
            AppError::Serde(_) => "E_SERDE".to_string(),
            AppError::Io(_) => "E_IO".to_string(),
            AppError::Crypto(_) => "E_CRYPTO".to_string(),
            AppError::Validation(_) => "E_VALIDATION".to_string(),
            AppError::NotFound(_) => "E_NOT_FOUND".to_string(),
            AppError::Business(msg) => Self::extract_code(msg).unwrap_or("E_BUSINESS").to_string(),
            AppError::General(msg) => Self::extract_code(msg).unwrap_or("E_GENERAL").to_string(),
        }
    }
}

// 序列化为 `{ code, message }`，供前端按 code 归类与展示建议动作
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", &self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn code_of(e: AppError) -> String {
        e.code()
    }

    #[test]
    fn extracts_prefix_code_from_business_message() {
        assert_eq!(
            code_of(AppError::Business("E_TXT_READ：读取 TXT 失败".to_string())),
            "E_TXT_READ"
        );
        // 半角冒号分隔同样支持
        assert_eq!(
            code_of(AppError::Business("E_IO_BUSY: busy".to_string())),
            "E_IO_BUSY"
        );
        // 数字与下划线属于码字符
        assert_eq!(
            code_of(AppError::Business("E_BACKUP_FILE_2：损坏".to_string())),
            "E_BACKUP_FILE_2"
        );
    }

    #[test]
    fn falls_back_to_variant_default_code() {
        assert_eq!(code_of(AppError::Business("无前缀消息".to_string())), "E_BUSINESS");
        assert_eq!(code_of(AppError::NotFound("x".to_string())), "E_NOT_FOUND");
        assert_eq!(code_of(AppError::DbPool("x".to_string())), "E_DB_POOL");
        // General 的裸消息也尝试提取
        assert_eq!(
            code_of(AppError::General("E_EXPORT_CANCELED：已取消".to_string())),
            "E_EXPORT_CANCELED"
        );
        // 仅 "E_" 无码体 → 归默认码
        assert_eq!(code_of(AppError::General("E_：无码体".to_string())), "E_GENERAL");
    }

    #[test]
    fn serializes_to_code_message_object() {
        let e = AppError::Business("E_BACKUP_KEY：密钥不符".to_string());
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(
            v,
            json!({
                "code": "E_BACKUP_KEY",
                "message": "业务逻辑错误: E_BACKUP_KEY：密钥不符"
            })
        );
    }
}
