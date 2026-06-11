//! 数据库 Schema 定义
//!
//! 集中管理所有表的列定义，供 validate.rs 和 repository 层复用。
//! 避免在多处硬编码列名导致维护不一致。

/// 每张表的预期列定义（表名, [列名列表]）
pub const TABLE_SCHEMA: &[(&str, &[&str])] = &[
    (
        "books",
        &[
            "id", "title", "author", "description", "cover_image", "word_count",
            "daily_target", "today_count", "db_path", "tags", "created_at",
            "updated_at", "deleted_at", "outline",
        ],
    ),
    (
        "volumes",
        &["id", "book_id", "title", "sort_order", "created_at", "deleted_at"],
    ),
    (
        "chapters",
        &[
            "id", "book_id", "volume_id", "title", "content_html", "word_count",
            "status", "sort_order", "deleted_at", "created_at", "updated_at",
            "summary", "summary_at", "outline",
        ],
    ),
    (
        "snapshots",
        &["id", "chapter_id", "content_html", "word_count", "type", "label", "created_at"],
    ),
    (
        "world_cards",
        &[
            "id", "book_id", "type", "title", "content", "content_html", "tags",
            "vectorized", "created_at", "updated_at",
        ],
    ),
    (
        "embeddings",
        &["id", "source_type", "source_id", "embedding", "model", "created_at"],
    ),
];
