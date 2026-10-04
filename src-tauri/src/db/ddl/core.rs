//! 核心业务表 DDL —— 书籍创作 / 日记 / 生词本 / Agent 记忆
//!
//! 覆盖 11 张表：books / volumes / chapters / snapshots / world_cards /
//! embeddings / memories / diaries / schedules / vocab_words / vocab_reviews。
//! 任务卡相关 12 张表见 [`super::taskcard`]。
//!
//! 全部 DDL 幂等（`CREATE TABLE IF NOT EXISTS`），可重复执行。

use anyhow::Context;
use rusqlite::Connection;

/// 一次性应用核心业务表 DDL。
pub fn apply(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
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

            -- Agent 记忆体（由原 Python Agent 迁移而来，用于注入 Skill 对话上下文）
            CREATE TABLE IF NOT EXISTS memories (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                book_id         TEXT NOT NULL,
                skill_type      TEXT NOT NULL,
                memory_type     TEXT NOT NULL,
                content         TEXT NOT NULL,
                keywords        TEXT NOT NULL DEFAULT '',
                relevance_score REAL NOT NULL DEFAULT 1.0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                last_hit_at     TEXT
            );

            -- 日记（每天最多一篇，diary_date 唯一）
            CREATE TABLE IF NOT EXISTS diaries (
                id           TEXT PRIMARY KEY,
                diary_date   TEXT NOT NULL UNIQUE,
                content_html TEXT NOT NULL DEFAULT '',
                word_count   INTEGER NOT NULL DEFAULT 0,
                keywords     TEXT NOT NULL DEFAULT '[]',
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            );

            -- 日程（某天可有多条）
            CREATE TABLE IF NOT EXISTS schedules (
                id            TEXT PRIMARY KEY,
                schedule_date TEXT NOT NULL,
                content       TEXT NOT NULL,
                done          INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );

            -- 英语生词本（word 小写唯一；SM-2 动态间隔复习）
            CREATE TABLE IF NOT EXISTS vocab_words (
                id             TEXT PRIMARY KEY,
                word           TEXT NOT NULL UNIQUE,
                phonetic       TEXT NOT NULL DEFAULT '',
                meanings       TEXT NOT NULL DEFAULT '[]',
                example        TEXT NOT NULL DEFAULT '',
                example_zh     TEXT NOT NULL DEFAULT '',
                repetition     INTEGER NOT NULL DEFAULT 0,
                interval_days  INTEGER NOT NULL DEFAULT 0,
                ease_factor    REAL NOT NULL DEFAULT 2.5,
                status         TEXT NOT NULL DEFAULT 'learning',
                next_review_at TEXT,
                last_review_at TEXT,
                review_count   INTEGER NOT NULL DEFAULT 0,
                correct_count  INTEGER NOT NULL DEFAULT 0,
                source         TEXT NOT NULL DEFAULT 'manual',
                -- DeepSeek AI 翻译生成的学习知识 JSON（词根词缀/近反义词/词组/动词变形/词性例句）
                ai_details     TEXT NOT NULL DEFAULT '',
                created_at     TEXT NOT NULL,
                updated_at     TEXT NOT NULL
            );

            -- 复习记录（每次复习一条，用于统计曲线）
            CREATE TABLE IF NOT EXISTS vocab_reviews (
                id            TEXT PRIMARY KEY,
                word_id       TEXT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
                review_date   TEXT NOT NULL,
                rating        INTEGER NOT NULL,
                repetition    INTEGER NOT NULL,
                interval_days INTEGER NOT NULL,
                ease_factor   REAL NOT NULL,
                reviewed_at   TEXT NOT NULL
            );
        "#,
    )
    .context("创建核心业务表失败")
}
