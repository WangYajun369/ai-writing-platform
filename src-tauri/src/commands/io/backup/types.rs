//! 备份共享类型与常量
//!
//! v2 载荷结构（ExportPayload / DatabaseExport / ChapterExport / EmbeddingMetaExport）、
//! 导入作用域（ImportScope）、导入策略（ImportStrategy）、写入统计（WriteStats）与指纹工具。

use crate::error::AppError;
use crate::models::{Book, Snapshot, Volume, WorldCard};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 备份文件大小上限：200 MB
pub(crate) const MAX_BACKUP_FILE_BYTES: u64 = 200 * 1024 * 1024;

/// 备份行数上限（超限拒绝，防超大事务与内存占用）
pub(crate) const MAX_BACKUP_ROWS: &[(&str, usize)] = &[
    ("books", 10_000),
    ("volumes", 50_000),
    ("chapters", 100_000),
    ("snapshots", 200_000),
    ("worldCards", 100_000),
    ("embeddings", 200_000),
];

/// 导入作用域：全库或单个作品（与备份类型解耦，覆盖「replace 语义」的受影响范围）
#[derive(Clone, Debug)]
pub(crate) enum ImportScope {
    Full,
    Single(String),
}

impl ImportScope {
    pub(crate) fn as_str(&self) -> String {
        match self {
            ImportScope::Full => "full".to_string(),
            ImportScope::Single(id) => format!("single:{}", id),
        }
    }

    pub(crate) fn parse(s: &str) -> Option<ImportScope> {
        if s == "full" {
            Some(ImportScope::Full)
        } else if let Some(id) = s.strip_prefix("single:") {
            Some(ImportScope::Single(id.to_string()))
        } else {
            None
        }
    }
}

// ---- 导出结构 ----

/// 章节导出结构（含 HTML 正文内容）
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ChapterExport {
    pub(crate) id: String,
    #[serde(rename = "bookId")]
    pub(crate) book_id: String,
    #[serde(rename = "volumeId")]
    pub(crate) volume_id: Option<String>,
    pub(crate) title: String,
    #[serde(rename = "contentHtml")]
    pub(crate) content_html: String,
    #[serde(rename = "wordCount")]
    pub(crate) word_count: i64,
    pub(crate) status: String,
    #[serde(rename = "sortOrder")]
    pub(crate) sort_order: i64,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: String,
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: String,
    #[serde(rename = "deletedAt")]
    pub(crate) deleted_at: Option<String>,
    pub(crate) summary: Option<String>,
    #[serde(rename = "summaryAt")]
    pub(crate) summary_at: Option<String>,
    pub(crate) outline: String,
}

/// Embedding 元数据导出（不含 BLOB 向量，可重新生成）
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct EmbeddingMetaExport {
    #[serde(rename = "sourceType")]
    pub(crate) source_type: String,
    #[serde(rename = "sourceId")]
    pub(crate) source_id: String,
    pub(crate) model: String,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: String,
}

/// 数据库全量导出子模块
#[derive(Serialize, Deserialize)]
pub(crate) struct DatabaseExport {
    pub(crate) books: Vec<Book>,
    pub(crate) volumes: Vec<Volume>,
    pub(crate) chapters: Vec<ChapterExport>,
    pub(crate) snapshots: Vec<Snapshot>,
    #[serde(rename = "worldCards")]
    pub(crate) world_cards: Vec<WorldCard>,
    pub(crate) embeddings: Vec<EmbeddingMetaExport>,
}

/// 全量导出总载荷（v1 字段兼容保留；v2 新增 schemaVersion / appVersion / payloadHash，均缺失时自动兼容旧文件）
#[derive(Serialize, Deserialize)]
pub(crate) struct ExportPayload {
    pub(crate) version: String,
    #[serde(rename = "exportedAt")]
    pub(crate) exported_at: String,
    #[serde(rename = "backupType")]
    pub(crate) backup_type: String,
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: Option<i64>,
    #[serde(rename = "appVersion")]
    pub(crate) app_version: Option<String>,
    #[serde(rename = "payloadHash")]
    pub(crate) payload_hash: Option<String>,
    pub(crate) database: DatabaseExport,
    pub(crate) cache: serde_json::Value,
}

/// SHA-256 十六进制（载荷指纹 / 行内容短指纹共用）
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// 单条写入统计（供 merge / fill-gaps 报告）
#[derive(Default, Clone, Copy, Debug)]
pub(crate) struct WriteStats {
    pub(crate) inserted: usize,
    pub(crate) updated: usize,
    pub(crate) skipped: usize,
}

pub(crate) fn stats_to_json(s: &WriteStats) -> serde_json::Value {
    serde_json::json!({
        "inserted": s.inserted,
        "updated": s.updated,
        "skipped": s.skipped,
    })
}

/// 备份时间戳是否新于目标行（RFC3339 / 同构时间串按字典序可比较；
/// 格式混用导致误判时，merge 只会保守地保留目标行，绝不丢目标新数据）
pub(crate) fn backup_is_newer(backup: &str, target: &str) -> bool {
    backup > target
}

// ---- 统一数据导入 ----

/// 导入写入策略（Spec §5.4）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImportStrategy {
    /// 清空受影响范围后按备份重建（默认，保持向后兼容；可回退）
    Replace,
    /// 逐行择优合并：备份更新（updated_at 新）的行全字段覆盖，其余保留目标行 —— 目标库新增数据不丢
    Merge,
    /// 仅插入目标库缺失行，绝不触碰已存在行
    FillGaps,
}

impl ImportStrategy {
    pub(crate) fn parse(s: Option<&str>) -> Result<ImportStrategy, AppError> {
        match s.unwrap_or("replace") {
            "replace" => Ok(ImportStrategy::Replace),
            "merge" => Ok(ImportStrategy::Merge),
            "fill-gaps" => Ok(ImportStrategy::FillGaps),
            other => Err(AppError::Business(format!(
                "E_BACKUP_STRATEGY：不支持的导入策略 \"{}\"（可选：replace / merge / fill-gaps）",
                other
            ))),
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ImportStrategy::Replace => "replace",
            ImportStrategy::Merge => "merge",
            ImportStrategy::FillGaps => "fill-gaps",
        }
    }
}
