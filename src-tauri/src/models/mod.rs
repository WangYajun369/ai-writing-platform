use serde::{Deserialize, Serialize};

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
}

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
