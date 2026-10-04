//! FTS5 全文检索 DDL —— 虚拟表 / 同步触发器 / 既有数据回填
//!
//! 章节（chapters_fts）与世界观卡片（world_cards_fts）各一个 FTS5 虚拟表，
//! 由 AFTER INSERT/DELETE/UPDATE 触发器自动同步。
//! 使用 `unicode61` 分词器，配合 `INSERT OR REPLACE` 避免行冲突。

use anyhow::Context;
use rusqlite::Connection;

/// 一次性应用 FTS5 全文检索 DDL：建虚拟表、(重)建触发器、回填既有数据。
pub fn apply(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
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
        "#,
    )
    .context("创建 FTS5 全文搜索表失败")
}
