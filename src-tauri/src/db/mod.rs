use rusqlite::{Connection, Result};
use std::sync::Mutex;

/// 应用级数据库（存储书籍元数据）
pub struct AppDb {
    pub conn: Mutex<Connection>,
}

impl AppDb {
    pub fn new(db_path: &str) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        let db = AppDb { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;

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
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS volumes (
                id          TEXT PRIMARY KEY,
                book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL
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
                updated_at   TEXT NOT NULL
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
        "#)?;
        Ok(())
    }
}
