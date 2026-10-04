//! 关键字段索引 DDL —— 一次性创建全部业务索引
//!
//! 索引全部使用 `CREATE INDEX IF NOT EXISTS`，幂等。
//! 维护约定：新增字段需要查询时，同步在此处补索引，避免遗漏。

use anyhow::Context;
use rusqlite::Connection;

/// 一次性应用全部索引 DDL。
pub fn apply(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
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
            -- 父子任务层级查询（subtree 递归 CTE / 防环逐级上溯均按 parent_id 查找）
            CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
            CREATE INDEX IF NOT EXISTS idx_task_tags_tag_id ON task_tags(tag_id);
            -- 任务卡 P2 扩展索引
            CREATE INDEX IF NOT EXISTS idx_task_subtasks_task ON task_subtasks(task_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
            CREATE INDEX IF NOT EXISTS idx_activity_logs_task ON task_activity_logs(task_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_activity_logs_project ON task_activity_logs(project_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(project_id, sort_order);
            CREATE INDEX IF NOT EXISTS idx_templates_project ON task_templates(project_id);
        "#,
    )
    .context("创建索引失败")
}
