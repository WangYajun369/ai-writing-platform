//! TimeWrite 数据库模块
//!
//! 基于 rusqlite + r2d2 连接池，WAL 模式 + 外键约束。
//! 管理 6 张表：books / volumes / chapters / snapshots / world_cards / embeddings。

use r2d2::{Pool, ManageConnection};
use rusqlite::{Connection, Result};
use anyhow::Context as _;

/// SQLite 连接管理器，实现 r2d2::ManageConnection
pub struct SqliteConnectionManager {
    path: String,
}

impl ManageConnection for SqliteConnectionManager {
    type Connection = Connection;
    type Error = rusqlite::Error;

    fn connect(&self) -> Result<Self::Connection, Self::Error> {
        Connection::open(&self.path)
    }

    fn is_valid(&self, conn: &mut Self::Connection) -> Result<(), Self::Error> {
        conn.execute_batch("SELECT 1").map(|_| ())
    }

    fn has_broken(&self, _conn: &mut Self::Connection) -> bool {
        false
    }
}

/// 应用级数据库（连接池版本）
pub struct AppDb {
    pub pool: Pool<SqliteConnectionManager>,
}

impl AppDb {
    /// 创建数据库实例并执行自动迁移（建表 + 索引）
    pub fn new(db_path: &str) -> anyhow::Result<Self> {
        let manager = SqliteConnectionManager { path: db_path.to_string() };
        let pool = Pool::builder()
            .max_size(10)
            .build(manager)
            .map_err(|e| anyhow::anyhow!("创建连接池失败: {}", e))?;

        let db = AppDb { pool };
        db.migrate()?;
        Ok(db)
    }

    /// 执行数据库自动迁移：启用 WAL + 外键 + 创建 6 张表 + 索引
    fn migrate(&self) -> anyhow::Result<()> {
        let conn = self.pool
            .get()
            .map_err(|e| anyhow::anyhow!("获取数据库连接失败: {}", e))?;

        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .context("启用 WAL 模式失败")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .context("启用外键约束失败")?;

        // 创建表
        conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS books (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                author      TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                cover_image TEXT,
                word_count  INTEGER NOT NULL DEFAULT 0,
                daily_target INTEGER NOT NULL DEFAULT 0,
                today_count INTEGER NOT NULL DEFAULT 0,
                db_path     TEXT NOT NULL DEFAULT '',
                tags        TEXT NOT NULL DEFAULT '[]',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                deleted_at  TEXT,
                outline     TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS volumes (
                id          TEXT PRIMARY KEY,
                book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL,
                deleted_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id           TEXT PRIMARY KEY,
                book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                volume_id    TEXT REFERENCES volumes(id) ON DELETE SET NULL,
                title        TEXT NOT NULL,
                content_html TEXT NOT NULL DEFAULT '',
                word_count   INTEGER NOT NULL DEFAULT 0,
                status       TEXT NOT NULL DEFAULT 'draft',
                sort_order   INTEGER NOT NULL DEFAULT 0,
                deleted_at   TEXT,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                summary      TEXT,
                summary_at   TEXT,
                outline      TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id           TEXT PRIMARY KEY,
                chapter_id   TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
                content_html TEXT NOT NULL DEFAULT '',
                word_count   INTEGER NOT NULL DEFAULT 0,
                type         TEXT NOT NULL DEFAULT 'auto',
                label        TEXT,
                created_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS world_cards (
                id           TEXT PRIMARY KEY,
                book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                type         TEXT NOT NULL DEFAULT 'misc',
                title        TEXT NOT NULL,
                content      TEXT NOT NULL DEFAULT '',
                content_html TEXT NOT NULL DEFAULT '',
                tags         TEXT NOT NULL DEFAULT '[]',
                vectorized   INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS embeddings (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                source_type  TEXT NOT NULL,
                source_id    TEXT NOT NULL,
                embedding    BLOB NOT NULL,
                model        TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(source_type, source_id)
            );
        "#).context("创建数据表失败")?;

        // 迁移现有数据库：为旧表添加 deleted_at 列（如果不存在）
        // 注意：必须在索引创建之前执行，否则旧库会因列不存在而创建索引失败
        let _ = conn.execute("ALTER TABLE volumes ADD COLUMN deleted_at TEXT", []);
        let _ = conn.execute("ALTER TABLE chapters ADD COLUMN deleted_at TEXT", []);
        let _ = conn.execute("ALTER TABLE books ADD COLUMN deleted_at TEXT", []);
        // 迁移：为 chapters 表添加 summary 和 summary_at 列
        let _ = conn.execute("ALTER TABLE chapters ADD COLUMN summary TEXT", []);
        let _ = conn.execute("ALTER TABLE chapters ADD COLUMN summary_at TEXT", []);
        // 迁移：添加大纲字段
        let _ = conn.execute("ALTER TABLE books ADD COLUMN outline TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE chapters ADD COLUMN outline TEXT NOT NULL DEFAULT ''", []);

        // 关键字段索引（提升查询性能）
        conn.execute_batch(r#"
            CREATE INDEX IF NOT EXISTS idx_volumes_book_id ON volumes(book_id);
            CREATE INDEX IF NOT EXISTS idx_volumes_deleted_at ON volumes(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
            CREATE INDEX IF NOT EXISTS idx_chapters_volume_id ON chapters(volume_id);
            CREATE INDEX IF NOT EXISTS idx_chapters_deleted_at ON chapters(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_books_deleted_at ON books(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_snapshots_chapter_id ON snapshots(chapter_id);
            CREATE INDEX IF NOT EXISTS idx_world_cards_book_id ON world_cards(book_id);
            CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
        "#).context("创建索引失败")?;

        Ok(())
    }
}
