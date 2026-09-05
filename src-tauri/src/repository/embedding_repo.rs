//! Embedding 数据访问层
//!
//! 提供 embeddings 表（事实来源）与 chunks_vec（sqlite-vec vec0 镜像）的 SQL 操作。
//!
//! ## 存储架构（v1.6 起）
//!
//! - `embeddings` 普通表：唯一事实来源，保存 source 元数据 + 向量 BLOB
//!   （little-endian f32 拼接），兼容现有备份 / 孤儿清理 / 状态统计逻辑。
//! - `chunks_vec` vec0 虚拟表：KNN 检索索引镜像，`rowid` ↔ `embeddings.id`，
//!   使用 cosine 距离（`distance = 1 - cos`）。维度与 embeddings 实际数据一致：
//!   建表时探测，更换 embedding 模型导致维度变化时自动重建镜像。
//!
//! 语义检索不再全量加载向量到内存，而是交给 sqlite-vec 在 SQLite 内完成
//! KNN 扫描，内存占用 O(k)（k 为候选数），解决大书库向量内存爆炸问题。

use rusqlite::{params, Connection, OptionalExtension, Result};

/// vec0 镜像表名（KNN 语义检索）
pub const VEC_TABLE: &str = "chunks_vec";

/// 统计指定书籍已索引的 embedding 总量
pub fn count_indexed_for_book(conn: &Connection, book_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT (
            SELECT COUNT(*) FROM embeddings e
            INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
            WHERE c.book_id = ?1 AND c.deleted_at IS NULL AND c.content_html != ''
        ) + (
            SELECT COUNT(*) FROM embeddings e
            INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
            WHERE w.book_id = ?1 AND w.content_html != ''
        )",
        params![book_id],
        |row| row.get(0),
    )
}

/// 统计已索引的章节 embedding 数
pub fn count_indexed_chapters(conn: &Connection, book_id: &str) -> Result<usize> {
    conn.query_row(
        "SELECT COUNT(*) FROM embeddings e
         INNER JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
         WHERE c.book_id = ?1 AND c.deleted_at IS NULL AND c.content_html != ''",
        params![book_id],
        |row| row.get::<_, i64>(0).map(|v| v as usize),
    )
}

/// 统计已索引的世界观卡片 embedding 数
pub fn count_indexed_world_cards(conn: &Connection, book_id: &str) -> Result<usize> {
    conn.query_row(
        "SELECT COUNT(*) FROM embeddings e
         INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
         WHERE w.book_id = ?1 AND w.content_html != ''",
        params![book_id],
        |row| row.get::<_, i64>(0).map(|v| v as usize),
    )
}

/// 列出所有 embedding 元数据（不含 BLOB），用于备份导出
pub fn list_all_meta(conn: &Connection) -> Result<Vec<(String, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT source_type, source_id, COALESCE(model, '') as model, COALESCE(created_at, '') as created_at FROM embeddings"
    )?;
    let items = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    items.collect::<Result<Vec<_>, _>>()
}

/// 插入或替换一条 embedding
pub fn upsert(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    embedding: &[u8],
    model: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO embeddings (source_type, source_id, embedding, model)
         VALUES (?1, ?2, ?3, ?4)",
        params![source_type, source_id, embedding, model],
    )?;
    Ok(())
}

// ---- vec0 KNN 镜像表（sqlite-vec） ----

/// vec0 镜像表是否存在
pub fn vec_table_exists(conn: &Connection) -> Result<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        params![VEC_TABLE],
        |_| Ok(()),
    )
    .optional()
    .map(|v| v.is_some())
}

/// 探测 embeddings 中实际向量维度（BLOB 字节数 / 4）；无数据 → None
pub fn probe_embedding_dim(conn: &Connection) -> Result<Option<usize>> {
    conn.query_row(
        "SELECT CAST(MAX(length(embedding)) / 4 AS INTEGER) FROM embeddings",
        [],
        |row| row.get::<_, Option<i64>>(0).map(|v| v.map(|n| n as usize)),
    )
}

/// 读取 vec0 表声明维度（解析 sqlite_master.sql 中 float[N]）；表不存在 → None
fn vec_table_dim(conn: &Connection) -> Result<Option<usize>> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            params![VEC_TABLE],
            |row| row.get(0),
        )
        .optional()?;
    Ok(sql.as_deref().and_then(|s| {
        s.find("float[").and_then(|start| {
            let rest = &s[start + 6..];
            let end = rest.find(']')?;
            rest[..end].trim().parse::<usize>().ok()
        })
    }))
}

/// 创建 vec0 虚拟表（固定维度 + cosine 距离度量）
fn create_chunks_vec(conn: &Connection, dim: usize) -> Result<()> {
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS {VEC_TABLE} USING vec0(
            embedding float[{dim}] distance_metric=cosine
        );"
    ))
}

/// 从 embeddings 全量回填 vec 镜像（rowid = embeddings.id）
fn backfill_chunks_vec(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!(
        "INSERT INTO {VEC_TABLE} (rowid, embedding) SELECT id, embedding FROM embeddings;"
    ))
}

/// 删除 vec0 镜像表（含 shadow 表）
fn drop_chunks_vec(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!("DROP TABLE IF EXISTS {VEC_TABLE};"))
}

/// 幂等对齐 vec0 镜像表（migrate 启动时调用）：
/// - 表缺失且有向量数据 → 建表并回填（覆盖旧库首次升级到 sqlite-vec 的场景）
/// - 表维度与现数据不符（更换了 embedding 模型）→ 重建镜像
pub fn ensure_chunks_vec(conn: &Connection) -> Result<()> {
    let Some(dim) = probe_embedding_dim(conn)? else {
        return Ok(());
    };
    if vec_table_exists(conn)? {
        if vec_table_dim(conn)? == Some(dim) {
            return Ok(());
        }
        drop_chunks_vec(conn)?;
    }
    create_chunks_vec(conn, dim)?;
    backfill_chunks_vec(conn)
}

/// 全量重建 vec0 镜像表（trigger_embedding / 备份导入之后调用）。
/// 先删除镜像再按 embeddings 现数据回填，保证维度与内容一致；
/// embeddings 为空（无任何向量）时镜像表保持不存在。
pub fn rebuild_chunks_vec(conn: &Connection) -> Result<()> {
    drop_chunks_vec(conn)?;
    let Some(dim) = probe_embedding_dim(conn)? else {
        return Ok(());
    };
    create_chunks_vec(conn, dim)?;
    backfill_chunks_vec(conn)
}

/// 删除指定 embeddings 行的 vec 镜像（ids 为 embeddings.id，表不存在则跳过）
pub fn delete_vec_rows(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() || !vec_table_exists(conn)? {
        return Ok(());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    conn.execute(
        &format!("DELETE FROM {VEC_TABLE} WHERE rowid IN ({placeholders})"),
        rusqlite::params_from_iter(ids.iter()),
    )?;
    Ok(())
}

/// 清空 vec0 镜像表（备份全量导入等场景，表不存在则跳过）
pub fn clear_vec_table(conn: &Connection) -> Result<()> {
    if vec_table_exists(conn)? {
        conn.execute(&format!("DELETE FROM {VEC_TABLE}"), [])?;
    }
    Ok(())
}

/// 列出某本书关联的全部 embeddings 行 id（单书导入前清理 vec 镜像用）
pub fn list_ids_by_book(conn: &Connection, book_id: &str) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT e.id FROM embeddings e
         LEFT JOIN chapters c ON e.source_id = c.id AND e.source_type = 'chapter'
         LEFT JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
         WHERE c.book_id = ?1 OR w.book_id = ?1",
    )?;
    let rows = stmt.query_map(params![book_id], |row| row.get::<_, i64>(0))?;
    rows.collect()
}

/// KNN 检索：返回 (embeddings.id, cosine distance)，按距离升序（最近优先）
pub fn knn_search(conn: &Connection, query_blob: &[u8], limit: i64) -> Result<Vec<(i64, f64)>> {
    if !vec_table_exists(conn)? {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT rowid, distance FROM {VEC_TABLE}
         WHERE embedding MATCH ?1
         ORDER BY distance
         LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![query_blob, limit], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
    })?;
    rows.collect()
}

/// 按 embeddings.id 批量取章节元数据（KNN 结果组装用，已按书过滤）
///
/// 返回 (embedding_id, source_id, title, content_html)
pub fn find_chapter_meta_by_ids(
    conn: &Connection,
    ids: &[i64],
    book_id: &str,
) -> Result<Vec<(i64, String, String, String)>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT e.id, e.source_id, c.title, c.content_html
         FROM embeddings e
         INNER JOIN chapters c ON c.id = e.source_id AND e.source_type = 'chapter'
         WHERE e.id IN ({placeholders}) AND c.book_id = ?{book_param} AND c.deleted_at IS NULL",
        book_param = ids.len() + 1
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = ids
        .iter()
        .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    params.push(Box::new(book_id.to_string()));
    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = stmt.query_map(refs.as_slice(), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        ))
    })?;
    rows.collect()
}

/// 按 embeddings.id 批量取世界观卡片元数据（KNN 结果组装用，已按书过滤）
///
/// 返回 (embedding_id, source_id, title, content_html)
pub fn find_world_card_meta_by_ids(
    conn: &Connection,
    ids: &[i64],
    book_id: &str,
) -> Result<Vec<(i64, String, String, String)>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT e.id, e.source_id, w.title, w.content_html
         FROM embeddings e
         INNER JOIN world_cards w ON e.source_id = w.id AND e.source_type = 'world_card'
         WHERE e.id IN ({placeholders}) AND w.book_id = ?{book_param}",
        book_param = ids.len() + 1
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = ids
        .iter()
        .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
        .collect();
    params.push(Box::new(book_id.to_string()));
    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = stmt.query_map(refs.as_slice(), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        ))
    })?;
    rows.collect()
}
