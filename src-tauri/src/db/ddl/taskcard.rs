//! 任务卡模块 DDL —— 12 张表
//!
//! 覆盖：projects / tasks / tags / task_tags / task_meta / task_subtasks /
//! attachments / task_activity_logs / task_templates / project_milestones /
//! writing_stats / import_rollback_log / import_log。
//!
//! 全部 DDL 幂等（`CREATE TABLE IF NOT EXISTS`），可重复执行。

use anyhow::Context;
use rusqlite::Connection;

/// 一次性应用任务卡模块 DDL。
pub fn apply(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
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

            -- 导入回退点元信息（运行态：replace 导入前快照，24h 内可经 rollback_import 撤销）。
            -- 数据快照本体为同名克隆表 __tw_rb_{ts}_{table}（CREATE TABLE AS SELECT 生成，
            -- 与主库同事务提交，避免逐行序列化的脆弱性）；本表只记录分组与归属。
            CREATE TABLE IF NOT EXISTS import_rollback_log (
                ts         TEXT PRIMARY KEY,   -- 快照分组 id（UTC 纳秒戳字符串）
                scope      TEXT NOT NULL,      -- "full" | "single:{book_id}"
                file_name  TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL       -- RFC3339，用于 24h 过期清理
            );

            -- 导入日志（运行态幂等判定，Spec §4.3）：仅在导入事务成功提交后写入；
            -- 保留最近 20 条滚动清理；不参与备份导出、不随作品删除。
            CREATE TABLE IF NOT EXISTS import_log (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                payload_hash TEXT NOT NULL,    -- database 规范化 JSON 的 SHA-256（Spec §4.2）
                file_name    TEXT NOT NULL,    -- 原始文件名
                backup_type  TEXT NOT NULL,    -- full / single
                source_size  INTEGER NOT NULL, -- 文件字节数（辅助判定）
                imported_at  TEXT NOT NULL     -- RFC3339
            );
            CREATE INDEX IF NOT EXISTS idx_import_log_hash ON import_log(payload_hash);
        "#,
    )
    .context("创建任务卡模块表失败")
}
