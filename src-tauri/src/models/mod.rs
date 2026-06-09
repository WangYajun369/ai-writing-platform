//! TimeWrite 数据模型定义
//!
//! 与前端 TypeScript 类型保持一致，使用 serde 序列化/反序列化，
//! 字段名通过 `#[serde(rename)]` 映射为 camelCase。

use serde::{Deserialize, Serialize};

/// 书籍 — 对应 `books` 表
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: String,
    #[serde(rename = "coverImage")]
    pub cover_image: Option<String>,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    #[serde(rename = "dailyTarget")]
    pub daily_target: i64,
    #[serde(rename = "todayCount")]
    pub today_count: i64,
    #[serde(rename = "dbPath")]
    pub db_path: String,
    pub tags: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 卷 — 对应 `volumes` 表，按 sort_order 排序，支持软删除 (deleted_at)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Volume {
    pub id: String,
    #[serde(rename = "bookId")]
    pub book_id: String,
    pub title: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: Option<String>,
}

/// 章节 — 对应 `chapters` 表，支持软删除 (deleted_at)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Chapter {
    pub id: String,
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "volumeId")]
    pub volume_id: Option<String>,
    pub title: String,
    #[serde(rename = "contentHtml")]
    pub content_html: Option<String>,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    pub status: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: Option<String>,
}

/// 版本快照 — 对应 `snapshots` 表，type 为 auto 或 milestone
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Snapshot {
    pub id: String,
    #[serde(rename = "chapterId")]
    pub chapter_id: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    #[serde(rename = "type")]
    pub snapshot_type: String,
    pub label: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// 世界观卡片 — 对应 `world_cards` 表，6 种类型，vectorized 标识向量化状态
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorldCard {
    pub id: String,
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "type")]
    pub card_type: String,
    pub title: String,
    pub content: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    pub tags: Vec<String>,
    pub vectorized: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}
