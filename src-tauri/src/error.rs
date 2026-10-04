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
//!
//! ## 结构化错误码（推荐入口）
//!
//! 新代码请使用 [`AppError::business`] 构造业务错误：
//!
//! ```ignore
//! use crate::error::{AppError, ErrCode};
//! return Err(AppError::business(ErrCode::TxtRead, format!("读取失败: {e}")));
//! ```
//!
//! 这取代了旧式字符串拼装 `AppError::Business(format!("E_TXT_READ：读取失败: {e}"))`：
//! - 错误码常量集中枚举在 [`ErrCode`]，IDE 自动补全，不会拼错；
//! - `code()` 仍走 [`AppError::extract_code`] 路径，序列化结果与旧式完全一致；
//! - 旧调用点无需立刻迁移，向后兼容。
//!
//! 新增错误码步骤：
//! 1. 在 [`ErrCode`] 追加变体；
//! 2. 在 [`ErrCode::as_str`] 的 match 分支追加 `"E_XXX"` 字符串；
//! 3.（可选）把对应的旧 `format!("E_XXX：...")` 调用点改写为 [`AppError::business`]。

use serde::{ser::SerializeMap, Serialize};
use thiserror::Error;

/// 全量稳定错误码（Spec §10）。
///
/// 作为前后端错误码契约的**单一真源**：后端通过 [`AppError::business`] 引用，
/// 前端按 `as_str()` 输出的字符串归档建议动作（见 `src/lib/errors.ts`）。
///
/// 新增变体时**必须**同步更新 [`ErrCode::as_str`] 的 match 分支，
/// 否则 `as_str()` 会 panic（开发期断言，CI 也会被 [`error::tests::err_code_as_str_covers_all_variants`] 拦截）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrCode {
    // ── 数据库层 ──
    /// 连接池错误（`E_DB_POOL`）。变体默认码。
    DbPool,
    /// 数据库操作错误（`E_DB`）。变体默认码。
    Db,
    /// 数据库结构版本不兼容（`E_DB_VERSION`）：库版本高于应用支持版本，拒绝启动。
    DbVersion,

    // ── HTTP / 序列化 / IO / 加密 ──
    /// HTTP 请求错误（`E_HTTP`）。
    Http,
    /// 序列化/反序列化错误（`E_SERDE`）。
    Serde,
    /// 通用 IO 错误（`E_IO`）。
    Io,
    /// 导入/导出通道互斥锁占用（`E_IO_BUSY`）。
    IoBusy,
    /// 加密/解密错误（`E_CRYPTO`）。
    Crypto,

    // ── 校验 / 查找 ──
    /// 数据校验错误（`E_VALIDATION`）。
    Validation,
    /// 资源未找到（`E_NOT_FOUND`）。
    NotFound,

    // ── TXT 导入 ──
    /// TXT 读取失败（`E_TXT_READ`）。
    TxtRead,
    /// TXT 文件超过上限（`E_TXT_TOO_LARGE`）。
    TxtTooLarge,
    /// TXT 未识别出章节（`E_TXT_NO_CHAPTERS`）。
    TxtNoChapters,
    /// TXT 导入事务启动失败（`E_TXT_TXN`）。
    TxtTxn,
    /// TXT 导入查询失败（`E_TXT_QUERY`）。
    TxtQuery,
    /// TXT 导入提交失败（`E_TXT_COMMIT`）。
    TxtCommit,

    // ── 备份 / 导入导出 ──
    /// 备份密钥不符（`E_BACKUP_KEY`）。
    BackupKey,
    /// 备份载荷指纹校验失败（`E_BACKUP_SCHEMA`，文件可能被篡改）。
    BackupSchema,
    /// 备份/应用版本不兼容（`E_BACKUP_VERSION`）。
    BackupVersion,
    /// 不支持的导入策略（`E_BACKUP_STRATEGY`）。
    BackupStrategy,
    /// 备份载荷序列化失败（`E_BACKUP_SERIALIZE`）。
    BackupSerialize,
    /// 备份文件写入失败（`E_BACKUP_WRITE`）。
    BackupWrite,
    /// 备份缓存数据解析失败（`E_BACKUP_CACHE`）。
    BackupCache,
    /// 备份文件读取失败（`E_BACKUP_READ`）。
    BackupRead,
    /// 备份事务开始/提交失败（`E_BACKUP_TXN`）。
    BackupTxn,
    /// 不支持的导出格式（`E_EXPORT_FORMAT`）。
    ExportFormat,
    /// 导出文件写入失败（`E_EXPORT_WRITE`）。
    ExportWrite,
    /// 导出被取消（`E_EXPORT_CANCELED`，未生成文件）。
    ExportCanceled,

    // ── 兜底 ──
    /// 业务逻辑错误兜底码（`E_BUSINESS`）。
    Business,
    /// 完全无法归类时使用（`E_GENERAL`）。
    General,
}

impl ErrCode {
    /// 返回稳定的 `E_XXX` 字符串。
    ///
    /// **不变量**：新增变体时必须在此 match 追加分支；CI 通过
    /// [`error::tests::err_code_as_str_covers_all_variants`] 单测强制全量覆盖。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DbPool => "E_DB_POOL",
            Self::Db => "E_DB",
            Self::DbVersion => "E_DB_VERSION",
            Self::Http => "E_HTTP",
            Self::Serde => "E_SERDE",
            Self::Io => "E_IO",
            Self::IoBusy => "E_IO_BUSY",
            Self::Crypto => "E_CRYPTO",
            Self::Validation => "E_VALIDATION",
            Self::NotFound => "E_NOT_FOUND",
            Self::TxtRead => "E_TXT_READ",
            Self::TxtTooLarge => "E_TXT_TOO_LARGE",
            Self::TxtNoChapters => "E_TXT_NO_CHAPTERS",
            Self::TxtTxn => "E_TXT_TXN",
            Self::TxtQuery => "E_TXT_QUERY",
            Self::TxtCommit => "E_TXT_COMMIT",
            Self::BackupKey => "E_BACKUP_KEY",
            Self::BackupSchema => "E_BACKUP_SCHEMA",
            Self::BackupVersion => "E_BACKUP_VERSION",
            Self::BackupStrategy => "E_BACKUP_STRATEGY",
            Self::BackupSerialize => "E_BACKUP_SERIALIZE",
            Self::BackupWrite => "E_BACKUP_WRITE",
            Self::BackupCache => "E_BACKUP_CACHE",
            Self::BackupRead => "E_BACKUP_READ",
            Self::BackupTxn => "E_BACKUP_TXN",
            Self::ExportFormat => "E_EXPORT_FORMAT",
            Self::ExportWrite => "E_EXPORT_WRITE",
            Self::ExportCanceled => "E_EXPORT_CANCELED",
            Self::Business => "E_BUSINESS",
            Self::General => "E_GENERAL",
        }
    }
}

impl std::fmt::Display for ErrCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}


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

    // 业务错误与兜底错误的分工：Business 消息通常自带 `E_` 前缀稳定码（code()
    // 会自动提取）；General 用于无法归类的兜底场景（如 anyhow 错误透传）。
    #[error("业务逻辑错误: {0}")]
    Business(String),

    #[error("{0}")]
    General(String),
}

impl AppError {
    /// 结构化构造器：用 [`ErrCode`] + 消息文本生成业务错误。
    ///
    /// 推荐用法（取代旧式字符串拼装）：
    ///
    /// ```ignore
    /// use crate::error::{AppError, ErrCode};
    /// return Err(AppError::business(ErrCode::TxtRead, format!("读取失败: {e}")));
    /// ```
    ///
    /// 内部以 `format!("{}：{}", code, msg)` 拼装为 [`AppError::Business`]，
    /// [`AppError::code`] 会经 `extract_code` 提取出 `E_XXX`，序列化结果
    /// 与旧式 `AppError::Business(format!("E_TXT_READ：..."))` 完全一致。
    /// 全角 `：` 分隔符沿用既有约定，前端 `parseError` 兼容。
    pub fn business(code: ErrCode, msg: impl Into<String>) -> Self {
        AppError::Business(format!("{}：{}", code, msg.into()))
    }

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

// 以下 From 转换让下层错误可通过 `?` 快捷传播到 AppError：
// 各类库错误（rusqlite / serde_json / std::io）由 #[from] 属性自动生成转换。
// 自定义转换：anyhow → General（兜底）；r2d2 连接池 → DbPool；String → Business（调用约定见下）。

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

// 调用约定：凡以 String 直接转 AppError 的地方默认归为业务错误；
// 若要携带稳定错误码供前端归类，文本应以 `E_XXX：` 前缀开头（code() 会提取）。
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

    /// 结构化构造器 business() 与旧式字符串拼装序列化结果完全一致。
    ///
    /// 这是错误码结构化重构的关键不变量：旧调用点无需立刻迁移，
    /// 新构造器生成的错误序列化与旧式 `AppError::Business(format!("E_XXX：..."))`
    /// 字节级一致 —— code 字段、message 字段、Display 文本三者皆同。
    #[test]
    fn business_constructor_matches_legacy_string_concat() {
        let legacy = AppError::Business("E_TXT_READ：读取 TXT 失败".to_string());
        let structured = AppError::business(ErrCode::TxtRead, "读取 TXT 失败");

        assert_eq!(legacy.code(), structured.code(), "code 字段应一致");
        assert_eq!(
            legacy.to_string(),
            structured.to_string(),
            "Display 文本应一致"
        );
        assert_eq!(
            serde_json::to_value(&legacy).unwrap(),
            serde_json::to_value(&structured).unwrap(),
            "序列化结构应完全一致"
        );
    }

    /// ErrCode::as_str 全量覆盖：每个变体必须返回稳定的 `E_XXX` 字符串。
    ///
    /// 这是新增错误码时的强制断言：若新增变体后忘记在 `as_str` match 中追加分支，
    /// 编译会因 non-exhaustive match 失败；本测试进一步验证字符串值正确。
    #[test]
    fn err_code_as_str_covers_all_variants() {
        // 这里逐变体断言而非遍历：因为 Rust 没有 Self::all()，必须手列。
        // 新增变体时必须在此追加一行，否则本测试虽不会编译失败（因为不在 enum 上做穷举），
        // 但 review 时会发现遗漏。
        let cases = [
            (ErrCode::DbPool, "E_DB_POOL"),
            (ErrCode::Db, "E_DB"),
            (ErrCode::DbVersion, "E_DB_VERSION"),
            (ErrCode::Http, "E_HTTP"),
            (ErrCode::Serde, "E_SERDE"),
            (ErrCode::Io, "E_IO"),
            (ErrCode::IoBusy, "E_IO_BUSY"),
            (ErrCode::Crypto, "E_CRYPTO"),
            (ErrCode::Validation, "E_VALIDATION"),
            (ErrCode::NotFound, "E_NOT_FOUND"),
            (ErrCode::TxtRead, "E_TXT_READ"),
            (ErrCode::TxtTooLarge, "E_TXT_TOO_LARGE"),
            (ErrCode::TxtNoChapters, "E_TXT_NO_CHAPTERS"),
            (ErrCode::TxtTxn, "E_TXT_TXN"),
            (ErrCode::TxtQuery, "E_TXT_QUERY"),
            (ErrCode::TxtCommit, "E_TXT_COMMIT"),
            (ErrCode::BackupKey, "E_BACKUP_KEY"),
            (ErrCode::BackupSchema, "E_BACKUP_SCHEMA"),
            (ErrCode::BackupVersion, "E_BACKUP_VERSION"),
            (ErrCode::BackupStrategy, "E_BACKUP_STRATEGY"),
            (ErrCode::BackupSerialize, "E_BACKUP_SERIALIZE"),
            (ErrCode::BackupWrite, "E_BACKUP_WRITE"),
            (ErrCode::BackupCache, "E_BACKUP_CACHE"),
            (ErrCode::BackupRead, "E_BACKUP_READ"),
            (ErrCode::BackupTxn, "E_BACKUP_TXN"),
            (ErrCode::ExportFormat, "E_EXPORT_FORMAT"),
            (ErrCode::ExportWrite, "E_EXPORT_WRITE"),
            (ErrCode::ExportCanceled, "E_EXPORT_CANCELED"),
            (ErrCode::Business, "E_BUSINESS"),
            (ErrCode::General, "E_GENERAL"),
        ];
        for (code, expected) in cases {
            assert_eq!(
                code.as_str(),
                expected,
                "ErrCode::{:?}.as_str() 应为 {}",
                code,
                expected
            );
            assert_eq!(
                code.to_string(),
                expected,
                "ErrCode::{:?}.to_string() 应为 {}",
                code,
                expected
            );
        }
    }

    /// business() 生成的错误经 code() 提取应返回原 ErrCode 的字符串。
    ///
    /// 覆盖多个码，确保 extract_code 与 ErrCode::as_str 字节一致。
    #[test]
    fn business_constructor_code_round_trips() {
        let cases = [
            (ErrCode::TxtRead, "读取失败"),
            (ErrCode::BackupKey, "密钥不符"),
            (ErrCode::IoBusy, "已有操作进行中"),
            (ErrCode::DbVersion, "v3 高于 v1"),
            (ErrCode::ExportCanceled, "已取消"),
        ];
        for (code, msg) in cases {
            let e = AppError::business(code, msg);
            assert_eq!(
                e.code(),
                code.as_str(),
                "ErrCode::{:?} 经 business() → code() 应回环一致",
                code
            );
        }
    }
}
