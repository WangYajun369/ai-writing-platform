//! TimeWrite 数据库模块
//!
//! 基于 rusqlite + r2d2 连接池，WAL 模式 + 外键约束。
//! 管理 6 张表：books / volumes / chapters / snapshots / world_cards / embeddings。

pub mod schema;

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
        let conn = Connection::open(&self.path)?;
        // 每个连接必须启用外键约束和 WAL 模式
        // foreign_keys 是每连接级别的设置，不会持久化到数据库文件
        let _ = conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
        Ok(conn)
    }

    fn is_valid(&self, conn: &mut Self::Connection) -> Result<(), Self::Error> {
        conn.execute_batch("SELECT 1").map(|_| ())
    }

    fn has_broken(&self, _conn: &mut Self::Connection) -> bool {
        false
    }
}

/// 执行 ALTER TABLE ADD COLUMN，若列已存在则跳过，其他错误向上传播
fn safe_add_column(conn: &Connection, table: &str, column: &str, column_def: &str) -> anyhow::Result<()> {
    let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, column_def);
    match conn.execute(&sql, []) {
        Ok(_) => {
            eprintln!("[SQL] ALTER TABLE → {}.{} 添加成功", table, column);
            Ok(())
        }
        Err(e) => {
            if e.to_string().contains("duplicate column name") {
                eprintln!("[SQL] ALTER TABLE → {}.{} 已存在，跳过", table, column);
                Ok(())
            } else {
                Err(e).with_context(|| format!("ALTER TABLE {}.{} 失败", table, column))
            }
        }
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
            .connection_timeout(std::time::Duration::from_secs(10))
            .idle_timeout(Some(std::time::Duration::from_secs(300)))
            .max_lifetime(Some(std::time::Duration::from_secs(1800)))
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

        eprintln!("[SQL] PRAGMA → journal_mode=WAL");
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .context("启用 WAL 模式失败")?;
        eprintln!("[SQL] PRAGMA → foreign_keys=ON");
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .context("启用外键约束失败")?;

        // 创建表
        eprintln!("[SQL] CREATE TABLE → books, volumes, chapters, snapshots, world_cards, embeddings");
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

        // FTS5 全文搜索虚拟表（章节 + 世界观卡片）
        eprintln!("[SQL] CREATE VIRTUAL TABLE → chapters_fts, world_cards_fts");
        conn.execute_batch(r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
                title, content, tokenize='unicode61'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS world_cards_fts USING fts5(
                title, content, tokenize='unicode61'
            );

            -- 先删除旧版触发器（如有），确保总是使用最新定义
            DROP TRIGGER IF EXISTS chapters_fts_ai;
            DROP TRIGGER IF EXISTS chapters_fts_ad;
            DROP TRIGGER IF EXISTS chapters_fts_au;
            DROP TRIGGER IF EXISTS world_cards_fts_ai;
            DROP TRIGGER IF EXISTS world_cards_fts_ad;
            DROP TRIGGER IF EXISTS world_cards_fts_au;

            -- chapters FTS 同步触发器（使用 INSERT OR REPLACE 避免行冲突）
            CREATE TRIGGER chapters_fts_ai AFTER INSERT ON chapters BEGIN
                INSERT OR REPLACE INTO chapters_fts(rowid, title, content)
                    VALUES (new.rowid, new.title, new.content_html);
            END;
            -- 使用 DELETE 直接移除 FTS 索引项，无需经过分词器
            CREATE TRIGGER chapters_fts_ad AFTER DELETE ON chapters BEGIN
                DELETE FROM chapters_fts WHERE rowid = old.rowid;
            END;
            CREATE TRIGGER chapters_fts_au AFTER UPDATE ON chapters BEGIN
                INSERT OR REPLACE INTO chapters_fts(rowid, title, content)
                    VALUES (new.rowid, new.title, new.content_html);
            END;

            -- world_cards FTS 同步触发器（使用 INSERT OR REPLACE 避免行冲突）
            CREATE TRIGGER world_cards_fts_ai AFTER INSERT ON world_cards BEGIN
                INSERT OR REPLACE INTO world_cards_fts(rowid, title, content)
                    VALUES (new.rowid, new.title, new.content || ' ' || new.content_html);
            END;
            -- 使用 DELETE 直接移除 FTS 索引项，无需经过分词器
            CREATE TRIGGER world_cards_fts_ad AFTER DELETE ON world_cards BEGIN
                DELETE FROM world_cards_fts WHERE rowid = old.rowid;
            END;
            CREATE TRIGGER world_cards_fts_au AFTER UPDATE ON world_cards BEGIN
                INSERT OR REPLACE INTO world_cards_fts(rowid, title, content)
                    VALUES (new.rowid, new.title, new.content || ' ' || new.content_html);
            END;

            -- 为已有数据重建 FTS 索引（INSERT OR REPLACE 确保幂等）
            INSERT OR REPLACE INTO chapters_fts(rowid, title, content)
                SELECT rowid, title, content_html FROM chapters WHERE deleted_at IS NULL;
            INSERT OR REPLACE INTO world_cards_fts(rowid, title, content)
                SELECT rowid, title, content || ' ' || content_html FROM world_cards;
        "#).context("创建 FTS5 全文搜索表失败")?;

        // 迁移现有数据库：为旧表添加字段（列已存在时跳过，其他错误则报错）
        // 注意：必须在索引创建之前执行，否则旧库会因列不存在而创建索引失败
        safe_add_column(&conn, "volumes", "deleted_at", "TEXT")?;
        safe_add_column(&conn, "chapters", "deleted_at", "TEXT")?;
        safe_add_column(&conn, "books", "deleted_at", "TEXT")?;
        safe_add_column(&conn, "chapters", "summary", "TEXT")?;
        safe_add_column(&conn, "chapters", "summary_at", "TEXT")?;
        safe_add_column(&conn, "books", "outline", "TEXT NOT NULL DEFAULT ''")?;
        safe_add_column(&conn, "chapters", "outline", "TEXT NOT NULL DEFAULT ''")?;

        // 关键字段索引（提升查询性能）
        eprintln!("[SQL] CREATE INDEX → volumes, chapters, books, snapshots, world_cards, embeddings");
        conn.execute_batch(r#"
            CREATE INDEX IF NOT EXISTS idx_volumes_book_id ON volumes(book_id);
            CREATE INDEX IF NOT EXISTS idx_volumes_deleted_at ON volumes(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
            CREATE INDEX IF NOT EXISTS idx_chapters_book_sort ON chapters(book_id, sort_order);
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
