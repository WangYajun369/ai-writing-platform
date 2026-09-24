//! 数据库 Schema 定义
//!
//! 集中管理所有表的列定义，供 validate.rs 和 repository 层复用。
//! 避免在多处硬编码列名导致维护不一致。

/// 每张表的预期列定义（表名, [列名列表]）
///
/// 供 validate.rs 做表结构完整性检查（缺表 / 缺列 / 外键孤儿检测）。
/// 覆盖范围：书籍创作模块核心表 + embeddings / memories；
/// 任务卡、生词本、日记等后加入模块的表不在此清单内。
/// 维护约定：db::mod::migrate 若通过 safe_add_column 给旧库补列，
/// 需同步更新此处对应表的列清单，否则 validate_database 会误报缺列。
pub const TABLE_SCHEMA: &[(&str, &[&str])] = &[
    (
        "books",
        &[
            "id",
            "title",
            "author",
            "description",
            "cover_image",
            "word_count",
            "daily_target",
            "today_count",
            "db_path",
            "tags",
            "created_at",
            "updated_at",
            "deleted_at",
            "outline",
        ],
    ),
    (
        "volumes",
        &[
            "id",
            "book_id",
            "title",
            "sort_order",
            "created_at",
            "deleted_at",
        ],
    ),
    (
        "chapters",
        &[
            "id",
            "book_id",
            "volume_id",
            "title",
            "content_html",
            "word_count",
            "status",
            "sort_order",
            "deleted_at",
            "created_at",
            "updated_at",
            "summary",
            "summary_at",
            "outline",
        ],
    ),
    (
        "snapshots",
        &[
            "id",
            "chapter_id",
            "content_html",
            "word_count",
            "type",
            "label",
            "created_at",
        ],
    ),
    (
        "world_cards",
        &[
            "id",
            "book_id",
            "type",
            "title",
            "content",
            "content_html",
            "tags",
            "vectorized",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "embeddings",
        &[
            "id",
            "source_type",
            "source_id",
            "embedding",
            "model",
            "created_at",
        ],
    ),
    // 注：chunks_vec 为 sqlite-vec vec0 虚拟表（KNN 镜像，rowid ↔ embeddings.id），
    // 列结构由 vec0 模块管理，不参与本清单的列名校验，也不在备份导出范围内。
    (
        "memories",
        &[
            "id",
            "book_id",
            "skill_type",
            "memory_type",
            "content",
            "keywords",
            "relevance_score",
            "created_at",
            "updated_at",
            "last_hit_at",
        ],
    ),
];
