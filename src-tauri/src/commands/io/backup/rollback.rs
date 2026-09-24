//! 导入回退点（replace 语义，24h 可撤销）
//!
//! 导入事务内把受影响范围快照为 __tw_rb_{ts}_{table} 克隆表（与导入同事务提交），
//! 供 rollback_import 消费撤销；过期点由 prune_expired_rollbacks 清理。

use super::types::ImportScope;
use crate::error::AppError;
use crate::repository::embedding_repo;
use chrono::Utc;
use rusqlite::params;

// ==================== 导入回退点（运行态，24h 可撤销） ====================

/// 回退点保留时长：24 小时
pub(crate) const RB_TTL_HOURS: i64 = 24;

/// 需要参与快照/回滚的表（顺序无关快照，恢复/清空按需排列）
pub(crate) const RB_TABLES: &[&str] = &[
    "books",
    "volumes",
    "chapters",
    "snapshots",
    "world_cards",
    "embeddings",
];

/// 回退点克隆表名：__tw_rb_{ts}_{table}
pub(crate) fn rb_table(ts: &str, table: &str) -> String {
    format!("__tw_rb_{}_{}", ts, table)
}

/// 生成新的回退点分组 id（UTC 纳秒戳，表名唯一性足够）
pub(crate) fn new_rollback_ts() -> String {
    format!("{}", Utc::now().timestamp_nanos_opt().unwrap_or_default())
}

/// 记录回退点元信息（须在快照表创建后、同一事务内调用）
pub(crate) fn insert_rollback_log(
    conn: &rusqlite::Connection,
    ts: &str,
    scope: &ImportScope,
    file_name: &str,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO import_rollback_log (ts, scope, file_name, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![ts, scope.as_str(), file_name, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// 读取回退点元信息
pub(crate) fn get_rollback_log(
    conn: &rusqlite::Connection,
    ts: &str,
) -> Result<Option<(String, String)>, AppError> {
    let mut stmt =
        conn.prepare("SELECT scope, file_name FROM import_rollback_log WHERE ts = ?1")?;
    let mut rows = stmt.query_map(params![ts], |r| Ok((r.get(0)?, r.get(1)?)))?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// 单作品作用域下某张表的过滤谓词（列引用与现有导入删除逻辑保持一致）
pub(crate) fn single_scope_where(table: &str) -> &'static str {
    match table {
        "books" => "WHERE id = ?1",
        "volumes" => "WHERE book_id = ?1",
        "chapters" => "WHERE book_id = ?1",
        "snapshots" => "WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id = ?1)",
        "world_cards" => "WHERE book_id = ?1",
        "embeddings" => {
            "WHERE source_id IN (SELECT id FROM chapters WHERE book_id = ?1) \
                         OR source_id IN (SELECT id FROM world_cards WHERE book_id = ?1)"
        }
        _ => "WHERE 0", // 不会到达
    }
}

/// 在导入事务内、删除数据前，把受影响范围快照为克隆表（replace 语义的回退点）
///
/// 快照与导入写入处于同一事务：导入失败自动整体回滚（快照随之消失，无残留）；
/// 导入成功则快照随事务一并提交，供后续 rollback_import 撤销。
pub(crate) fn snapshot_scope(
    conn: &rusqlite::Connection,
    ts: &str,
    scope: &ImportScope,
) -> Result<(), AppError> {
    for table in RB_TABLES {
        let rb = rb_table(ts, table);
        let sql = match scope {
            ImportScope::Full => format!("CREATE TABLE {} AS SELECT * FROM {}", rb, table),
            ImportScope::Single(_) => format!(
                "CREATE TABLE {} AS SELECT * FROM {} {}",
                rb,
                table,
                single_scope_where(table)
            ),
        };
        match scope {
            ImportScope::Single(book_id) => {
                conn.execute(&sql, params![book_id])?;
            }
            ImportScope::Full => {
                conn.execute(&sql, [])?;
            }
        }
    }
    Ok(())
}

/// 统计快照行数（回滚时用于报告影响规模）
pub(crate) fn count_rb_table(conn: &rusqlite::Connection, ts: &str, table: &str) -> Result<i64, AppError> {
    let rb = rb_table(ts, table);
    let cnt: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {}", rb), [], |r| r.get(0))?;
    Ok(cnt)
}

/// 清空全库数据（与删除顺序保持一致：镜像 → 事实源，子表先于父表）。
/// 供 full 导入与 full 回滚共用。
pub(crate) fn clear_full_tables(conn: &rusqlite::Connection) -> Result<(), AppError> {
    // 先清 vec0 KNN 镜像（表不存在则跳过），再清事实源
    embedding_repo::clear_vec_table(conn)?;
    conn.execute("DELETE FROM embeddings", [])?;
    conn.execute("DELETE FROM snapshots", [])?;
    conn.execute("DELETE FROM world_cards", [])?;
    conn.execute("DELETE FROM chapters", [])?;
    conn.execute("DELETE FROM volumes", [])?;
    conn.execute("DELETE FROM books", [])?;
    Ok(())
}

/// 清空单个作品的数据（含其 embedding 与 vec 镜像）。供 single 导入与回滚共用。
pub(crate) fn clear_book_scope(conn: &rusqlite::Connection, book_id: &str) -> Result<(), AppError> {
    // 先删该书在 vec0 KNN 镜像中的行（rowid ↔ embeddings.id），再清事实源
    let book_emb_ids = embedding_repo::list_ids_by_book(conn, book_id)?;
    embedding_repo::delete_vec_rows(conn, &book_emb_ids)?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_id IN (SELECT id FROM chapters WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute(
        "DELETE FROM embeddings WHERE source_id IN (SELECT id FROM world_cards WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute(
        "DELETE FROM snapshots WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id=?1)",
        params![book_id],
    )?;
    conn.execute("DELETE FROM world_cards WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM chapters WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM volumes WHERE book_id=?1", params![book_id])?;
    conn.execute("DELETE FROM books WHERE id=?1", params![book_id])?;
    Ok(())
}

/// 当前作用域下的数据清理（full / single），供回滚撤销「导入后状态」用
pub(crate) fn clear_scope_data(conn: &rusqlite::Connection, scope: &ImportScope) -> Result<(), AppError> {
    match scope {
        ImportScope::Full => clear_full_tables(conn),
        ImportScope::Single(book_id) => clear_book_scope(conn, book_id),
    }
}

/// 从克隆表恢复数据到目标表（books → volumes → chapters → snapshots → world_cards → embeddings，
/// 父表先于子表，满足外键依赖）
pub(crate) fn restore_from_clones(
    conn: &rusqlite::Connection,
    ts: &str,
) -> Result<serde_json::Value, AppError> {
    let mut restored = serde_json::Map::new();
    // INSERT INTO t SELECT * FROM rb：克隆表由 SELECT * 创建，列序与当前目标表一致
    for table in RB_TABLES {
        let rb = rb_table(ts, table);
        let sql = format!("INSERT INTO {} SELECT * FROM {}", table, rb);
        let n = conn.execute(&sql, [])?;
        restored.insert(table.to_string(), serde_json::json!(n));
    }
    Ok(serde_json::Value::Object(restored))
}

/// 删除回退点克隆表与元信息（回滚消费或过期清理）
pub(crate) fn drop_rollback_point(conn: &rusqlite::Connection, ts: &str) -> Result<(), AppError> {
    for table in RB_TABLES {
        let rb = rb_table(ts, table);
        conn.execute(&format!("DROP TABLE IF EXISTS {}", rb), [])?;
    }
    conn.execute("DELETE FROM import_rollback_log WHERE ts = ?1", params![ts])?;
    Ok(())
}

/// 清理过期回退点（超过 RB_TTL_HOURS）。返回清理的回退点数量。
pub fn prune_expired_rollbacks(conn: &rusqlite::Connection) -> Result<usize, AppError> {
    let cutoff = (Utc::now() - chrono::Duration::hours(RB_TTL_HOURS)).to_rfc3339();
    let mut stmt = conn
        .prepare("SELECT ts FROM import_rollback_log WHERE created_at < ?1 ORDER BY created_at")?;
    let expired: Vec<String> = stmt
        .query_map(params![cutoff], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for ts in &expired {
        drop_rollback_point(conn, ts)?;
    }
    if !expired.is_empty() {
        crate::app_log!("[Rollback] 已清理 {} 个过期导入回退点", expired.len());
    }
    Ok(expired.len())
}

/// 撤销一次导入：把目标库恢复至该回退点快照状态（事务内，commit 后重建 vec 镜像）
pub fn execute_rollback(
    conn: &mut rusqlite::Connection,
    ts: &str,
) -> Result<serde_json::Value, AppError> {
    let Some((scope_str, file_name)) = get_rollback_log(conn, ts)? else {
        return Err(AppError::Business(format!(
            "E_BACKUP_ROLLBACK：回退点不存在或已过期：{}",
            ts
        )));
    };
    let scope = ImportScope::parse(&scope_str).ok_or_else(|| {
        AppError::Business(format!(
            "E_BACKUP_ROLLBACK：回退点作用域异常：{}",
            scope_str
        ))
    })?;

    // 先确认快照表可读（避免回滚到一半才发现数据缺失）
    for table in RB_TABLES {
        count_rb_table(conn, ts, table)?;
    }

    let tx = conn
        .transaction()
        .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：开始回滚事务失败: {}", e)))?;

    // 1) 删除当前导入后的数据（撤销 replace 的效果）
    clear_scope_data(&tx, &scope)?;
    // 2) 从快照恢复导入前状态
    let restored = restore_from_clones(&tx, ts)?;
    // 3) 消费回退点
    drop_rollback_point(&tx, ts)?;
    tx.commit()
        .map_err(|e| AppError::Business(format!("E_BACKUP_TXN：提交回滚事务失败: {}", e)))?;

    // 4) vec 镜像与 embeddings 对齐（回滚恢复的 embedding 行可能为空或非空）
    if let Err(e) = embedding_repo::rebuild_chunks_vec(conn) {
        crate::app_log_error!("[Rollback] vec 镜像重建失败（可后续由检索自动修复）: {}", e);
    }

    Ok(serde_json::json!({
        "rolledBack": true,
        "ts": ts,
        "scope": scope_str,
        "file_name": file_name,
        "restored": restored,
    }))
}
