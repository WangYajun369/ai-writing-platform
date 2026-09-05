//! TimeWrite 数据库模块
//!
//! 基于 rusqlite + r2d2 连接池，WAL 模式 + 外键约束。
//! 管理 7 张表：books / volumes / chapters / snapshots / world_cards / embeddings / memories。

pub mod schema;

use crate::repository::embedding_repo;
use anyhow::Context as _;
use r2d2::{ManageConnection, Pool};
use rusqlite::{Connection, Result};
use std::sync::atomic::{AtomicBool, Ordering};

/// sqlite-vec 扩展全局注册（进程内仅一次）。
///
/// 通过 `sqlite3_auto_extension` 注册 vec0 虚拟表模块，此后新建的每个
/// SQLite 连接都会自动加载该扩展（无需 load_extension 权限，适合 bundled）。
/// 必须在任何 Connection 打开之前调用，故置于 `AppDb::new` 起始处。
pub fn register_sqlite_vec_extension() {
    static REGISTERED: AtomicBool = AtomicBool::new(false);
    if REGISTERED.swap(true, Ordering::SeqCst) {
        return;
    }
    // sqlite-vec crate 在编译期静态链接了 sqlite-vec 的 C 实现并导出 sqlite3_vec_init。
    // bindgen 为 sqlite3_auto_extension 生成了完整三参 C 签名，需经指针转换注册
    // （与 sqlite-vec crate 自身测试一致的写法）。
    unsafe {
        type VecInit = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut std::os::raw::c_char,
            *const rusqlite::ffi::sqlite3_api_routines,
        ) -> std::os::raw::c_int;
        let init: VecInit = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
        let _ = rusqlite::ffi::sqlite3_auto_extension(Some(init));
    }
    crate::app_log!("[sqlite-vec] vec0 扩展已注册（KNN 语义检索可用）");
}

/// SQLite 连接管理器，实现 r2d2::ManageConnection
pub struct SqliteConnectionManager {
    pub path: String,
}

impl SqliteConnectionManager {
    /// 创建新的连接管理器
    pub fn new(path: String) -> Self {
        Self { path }
    }
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
///
/// 返回值：`true` = 本次实际新增了该列；`false` = 列已存在（跳过）
///
/// 注意：这里刻意不打印日志，交由调用方汇总输出。
/// 因为绝大多数启动都会命中"列已存在"分支，逐条打印会产生固定噪音。
fn safe_add_column(
    conn: &Connection,
    table: &str,
    column: &str,
    column_def: &str,
) -> anyhow::Result<bool> {
    let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, column_def);
    match conn.execute(&sql, []) {
        Ok(_) => Ok(true),
        Err(e) => {
            if e.to_string().contains("duplicate column name") {
                Ok(false)
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
        // 必须先注册 sqlite-vec 扩展，再打开任何连接（auto-extension 对后续连接生效）
        register_sqlite_vec_extension();

        let manager = SqliteConnectionManager::new(db_path.to_string());
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
        let conn = self
            .pool
            .get()
            .map_err(|e| anyhow::anyhow!("获取数据库连接失败: {}", e))?;

        crate::app_log!("[SQL] PRAGMA → journal_mode=WAL");
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .context("启用 WAL 模式失败")?;
        crate::app_log!("[SQL] PRAGMA → foreign_keys=ON");
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .context("启用外键约束失败")?;

        // 创建表
        crate::app_log!(
            "[SQL] CREATE TABLE → books, volumes, chapters, snapshots, world_cards, embeddings"
        );
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
                updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
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

            -- ══════ 任务卡模块（个人项目管理）══════
            -- 项目：任务的容器；status: active / completed / archived；软删除 deleted_at
            CREATE TABLE IF NOT EXISTS projects (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                description     TEXT NOT NULL DEFAULT '',
                color           TEXT NOT NULL DEFAULT '',
                icon            TEXT NOT NULL DEFAULT '',
                status          TEXT NOT NULL DEFAULT 'active',
                plan_start_date TEXT,
                plan_end_date   TEXT,
                pinned          INTEGER NOT NULL DEFAULT 0,
                sort_order      INTEGER NOT NULL DEFAULT 0,
                deleted_at      TEXT,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );

            -- 任务卡：必属于某项目；status: todo / doing / done
            -- 业务时间（due_time/plan_start_time/completed_time/remind_at）存本地时间字符串
            -- 优先比较与"今天"判断（见 utils::local_now）
            CREATE TABLE IF NOT EXISTS tasks (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                parent_id       TEXT,
                title           TEXT NOT NULL,
                description     TEXT NOT NULL DEFAULT '',
                status          TEXT NOT NULL DEFAULT 'todo',
                priority        TEXT NOT NULL DEFAULT 'medium',
                plan_start_time TEXT,
                due_time        TEXT,
                planned_today   INTEGER NOT NULL DEFAULT 0,
                completed_time  TEXT,
                note            TEXT NOT NULL DEFAULT '',
                remind_at       TEXT,
                remind_type     TEXT NOT NULL DEFAULT '',
                recurrence      TEXT NOT NULL DEFAULT '',
                note_html       TEXT NOT NULL DEFAULT '',
                completion_summary TEXT NOT NULL DEFAULT '',
                started_at      TEXT,
                work_seconds    INTEGER NOT NULL DEFAULT 0,
                sort_order      INTEGER NOT NULL DEFAULT 0,
                deleted_at      TEXT,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );

            -- 标签：name 唯一；status: enabled / disabled
            CREATE TABLE IF NOT EXISTS tags (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                color      TEXT NOT NULL DEFAULT '',
                status     TEXT NOT NULL DEFAULT 'enabled',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- 任务-标签关联（联合主键，删除标签可级联清理）
            CREATE TABLE IF NOT EXISTS task_tags (
                task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                PRIMARY KEY (task_id, tag_id)
            );

            -- 模块级 key-value（提醒偏好、日程迁移幂等标记等）
            CREATE TABLE IF NOT EXISTS task_meta (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- ══════ 任务卡 P2 扩展（v1.6+）══════
            -- 子任务/任务清单（隶属某任务卡，随任务级联删除）
            CREATE TABLE IF NOT EXISTS task_subtasks (
                id         TEXT PRIMARY KEY,
                task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                title      TEXT NOT NULL,
                done       INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- 附件（本地文件实体，见 PRD 12.4；文件存放应用数据目录 attachments/，与 time_write.db 同数据根）
            CREATE TABLE IF NOT EXISTS attachments (
                id         TEXT PRIMARY KEY,
                task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                file_name  TEXT NOT NULL,
                file_type  TEXT NOT NULL DEFAULT '',
                file_size  INTEGER NOT NULL DEFAULT 0,
                local_path TEXT NOT NULL,
                deleted    INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                created_at TEXT NOT NULL
            );

            -- 操作日志 / 执行记录时间线（task_id 或 project_id 至少一个非空，用于详情动态与周报）
            CREATE TABLE IF NOT EXISTS task_activity_logs (
                id         TEXT PRIMARY KEY,
                task_id    TEXT,
                project_id TEXT,
                action     TEXT NOT NULL,
                summary    TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            -- 任务模板（一键套用创建相似任务；subtask_titles 存子任务标题 JSON 数组）
            CREATE TABLE IF NOT EXISTS task_templates (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                project_id      TEXT,
                title           TEXT NOT NULL DEFAULT '',
                description     TEXT NOT NULL DEFAULT '',
                priority        TEXT NOT NULL DEFAULT 'medium',
                note            TEXT NOT NULL DEFAULT '',
                due_offset_days INTEGER NOT NULL DEFAULT 0,
                tag_ids         TEXT NOT NULL DEFAULT '[]',
                subtask_titles  TEXT NOT NULL DEFAULT '[]',
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );

            -- 项目里程碑/阶段（隶属项目；status: planned / doing / done）
            CREATE TABLE IF NOT EXISTS project_milestones (
                id          TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                color       TEXT NOT NULL DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'planned',
                due_date    TEXT,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            -- 写作统计（按日累计净增字数，支撑日更进度/连续天数/字数曲线；
            --    衍生展示表，不纳入备份导出，随书籍删除级联清理）
            CREATE TABLE IF NOT EXISTS writing_stats (
                book_id   TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                stat_date TEXT NOT NULL,
                words     INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (book_id, stat_date)
            );
        "#).context("创建数据表失败")?;

        // FTS5 全文搜索虚拟表（章节 + 世界观卡片）
        crate::app_log!("[SQL] CREATE VIRTUAL TABLE → chapters_fts, world_cards_fts");
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
        .context("创建 FTS5 全文搜索表失败")?;

        // 迁移现有数据库：为旧表添加字段（列已存在时跳过，其他错误则报错）
        // 注意：必须在索引创建之前执行，否则旧库会因列不存在而创建索引失败
        let mut added_columns: Vec<String> = Vec::new();
        for (table, column, column_def) in [
            ("volumes", "deleted_at", "TEXT"),
            ("chapters", "deleted_at", "TEXT"),
            ("books", "deleted_at", "TEXT"),
            ("chapters", "summary", "TEXT"),
            ("chapters", "summary_at", "TEXT"),
            ("books", "outline", "TEXT NOT NULL DEFAULT ''"),
            ("chapters", "outline", "TEXT NOT NULL DEFAULT ''"),
            ("vocab_words", "ai_details", "TEXT NOT NULL DEFAULT ''"),
            ("vocab_words", "example_zh", "TEXT NOT NULL DEFAULT ''"),
            // 任务卡 P2 补列
            ("tasks", "recurrence", "TEXT NOT NULL DEFAULT ''"),
            ("tasks", "note_html", "TEXT NOT NULL DEFAULT ''"),
            ("tasks", "started_at", "TEXT"),
            ("tasks", "work_seconds", "INTEGER NOT NULL DEFAULT 0"),
            // 任务卡父子任务（甘特图铺路）：parent_id 引用同表任务的 id
            ("tasks", "parent_id", "TEXT"),
            // 任务完成总结（富文本 HTML；勾选完成时填写）
            ("tasks", "completion_summary", "TEXT NOT NULL DEFAULT ''"),
            // 记忆库命中时间（过期清理依据；旧库 ALTER 补列，默认 NULL 表示从未命中）
            ("memories", "last_hit_at", "TEXT"),
        ] {
            if safe_add_column(&conn, table, column, column_def)? {
                added_columns.push(format!("{}.{}", table, column));
            }
        }
        // 汇总输出：常见情况是全部已存在，此时只打印一行，避免逐条刷屏
        if added_columns.is_empty() {
            crate::app_log!("[SQL] ALTER TABLE → 表结构已是最新，无需变更");
        } else {
            crate::app_log!("[SQL] ALTER TABLE → 新增字段: {}", added_columns.join(", "));
        }

        // 关键字段索引（提升查询性能）
        crate::app_log!("[SQL] CREATE INDEX → volumes, chapters, books, snapshots, world_cards, embeddings, memories");
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
            CREATE INDEX IF NOT EXISTS idx_memories_book_skill ON memories(book_id, skill_type);
            CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
            CREATE INDEX IF NOT EXISTS idx_diaries_date ON diaries(diary_date);
            CREATE INDEX IF NOT EXISTS idx_schedules_date ON schedules(schedule_date);
            CREATE INDEX IF NOT EXISTS idx_vocab_words_next ON vocab_words(next_review_at);
            CREATE INDEX IF NOT EXISTS idx_vocab_words_status ON vocab_words(status);
            CREATE INDEX IF NOT EXISTS idx_vocab_reviews_word ON vocab_reviews(word_id);
            CREATE INDEX IF NOT EXISTS idx_vocab_reviews_date ON vocab_reviews(review_date);
            CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
            CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, sort_order);
            CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_time);
            CREATE INDEX IF NOT EXISTS idx_task_tags_tag_id ON task_tags(tag_id);
            -- 任务卡 P2 扩展索引
            CREATE INDEX IF NOT EXISTS idx_task_subtasks_task ON task_subtasks(task_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
            CREATE INDEX IF NOT EXISTS idx_activity_logs_task ON task_activity_logs(task_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_activity_logs_project ON task_activity_logs(project_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(project_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_templates_project ON task_templates(project_id);
        "#).context("创建索引失败")?;

        // sqlite-vec KNN 镜像表：已有向量数据时建表并回填（幂等）；
        // 维度变化（更换 embedding 模型）时自动重建。
        crate::app_log!(
            "[SQL] sqlite-vec → ensure {} 镜像表",
            embedding_repo::VEC_TABLE
        );
        embedding_repo::ensure_chunks_vec(&conn)
            .map_err(|e| anyhow::anyhow!("初始化 sqlite-vec 镜像表失败: {}", e))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// sqlite-vec 冒烟测试：验证 vec0 虚拟表建表、插入、KNN（cosine）与 rowid 删除可用。
    ///
    /// 覆盖运行时最关键的三个假设：auto-extension 注册生效、cosine 距离语义、
    /// 镜像清理所依赖的按 rowid DELETE。
    #[test]
    fn sqlite_vec0_knn_cosine_smoke() {
        register_sqlite_vec_extension();

        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[3] distance_metric=cosine);",
        )
        .expect("create vec0 table");

        let encode = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|f| f.to_le_bytes()).collect() };

        conn.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (1, ?1)",
            params![encode(&[1.0, 0.0, 0.0])],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (2, ?1)",
            params![encode(&[0.0, 1.0, 0.0])],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (3, ?1)",
            params![encode(&[0.0, 0.0, 1.0])],
        )
        .unwrap();

        // 查询 [1,0,0]：最近邻应依次为 rowid 1、rowid 2/3（cosine distance ≈ 0 / 1）
        let q = encode(&[1.0, 0.0, 0.0]);
        let mut stmt = conn
            .prepare(
                "SELECT rowid, distance FROM chunks_vec
                 WHERE embedding MATCH ?1 ORDER BY distance LIMIT 3",
            )
            .unwrap();
        let rows: Vec<(i64, f64)> = stmt
            .query_map(params![q], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].0, 1, "最近邻应为 rowid 1，实际 {:?}", rows);
        assert!(
            rows[0].1.abs() < 1e-5,
            "self cosine distance 应约为 0，实际 {}",
            rows[0].1
        );
        assert!(
            (rows[1].1 - 1.0).abs() < 1e-4,
            "正交向量 cosine distance 应约为 1，实际 {}",
            rows[1].1
        );

        // rowid 删除能力（镜像清理路径依赖）
        conn.execute("DELETE FROM chunks_vec WHERE rowid = 2", [])
            .unwrap();
        let cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks_vec", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cnt, 2);
    }
}
