//! 导入幂等日志（Spec §4）
//!
//! v2 载荷内容指纹（database 规范化 JSON 的 SHA-256）+ import_log 滚动记录（保留 20 条），
//! 支撑「曾于 xx 导入」幂等提示与 payloadHash 防篡改校验。

use super::types::{sha256_hex, ExportPayload};
use crate::error::AppError;
use chrono::Utc;
use rusqlite::params;

// ---- Phase C：内容指纹 / 幂等日志 / 对账（Spec §4 / §5.5） ----

/// import_log 保留条数（滚动清理，运行态表）
pub(crate) const IMPORT_LOG_KEEP: usize = 20;

/// 载荷内容指纹：`database` 规范化 JSON 的 SHA-256（Spec §4.2）。
/// 序列化使用 struct 固定字段序，因此「导出时序列化」与「导入解析后再序列化」字节一致；
/// 天然排除 exportedAt / cache / backupType / appVersion / schemaVersion / payloadHash。
pub(crate) fn database_canonical_hash(payload: &ExportPayload) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(&payload.database)
        .map_err(|e| AppError::Business(format!("E_BACKUP_SERIALIZE：载荷指纹计算失败: {}", e)))?;
    Ok(sha256_hex(&bytes))
}

/// v2 载荷：校验声明的 payloadHash 与内容指纹一致（防篡改误判，Spec §4.2）。
/// 返回内容指纹；v1 旧文件（无 payloadHash 字段）返回 None —— 不判重但照常对账。
pub(crate) fn verified_payload_hash(payload: &ExportPayload) -> Result<Option<String>, AppError> {
    let Some(declared) = &payload.payload_hash else {
        return Ok(None);
    };
    let computed = database_canonical_hash(payload)?;
    if declared != &computed {
        return Err(AppError::Business(
            "E_BACKUP_SCHEMA：载荷指纹校验失败（文件内容与声明的 payloadHash 不一致，文件可能被篡改）。已拒绝导入，目标库未受影响。"
                .into(),
        ));
    }
    Ok(Some(computed))
}

/// 写入导入日志（幂等判定基础）：仅在导入事务**成功提交后**调用；v1 文件不写入。
/// 顺带滚动清理，仅保留最近 20 条。
pub(crate) fn record_import_log(
    conn: &rusqlite::Connection,
    payload_hash: &str,
    file_name: &str,
    backup_type: &str,
    source_size: i64,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO import_log (payload_hash, file_name, backup_type, source_size, imported_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            payload_hash,
            file_name,
            backup_type,
            source_size,
            Utc::now().to_rfc3339()
        ],
    )?;
    conn.execute(
        "DELETE FROM import_log WHERE id NOT IN \
         (SELECT id FROM import_log ORDER BY id DESC LIMIT ?1)",
        params![IMPORT_LOG_KEEP as i64],
    )?;
    Ok(())
}

/// 查最近一条同指纹 + 同类型 + 同大小的导入记录（幂等提示，Spec §4.3 判定）
pub(crate) fn lookup_import_log(
    conn: &rusqlite::Connection,
    payload_hash: &str,
    backup_type: &str,
    source_size: i64,
) -> Result<Option<(String, String)>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT imported_at, file_name FROM import_log \
         WHERE payload_hash = ?1 AND backup_type = ?2 AND source_size = ?3 \
         ORDER BY id DESC LIMIT 1",
    )?;
    let mut rows = stmt.query_map(params![payload_hash, backup_type, source_size], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.into()),
        None => Ok(None),
    }
}

/// 导入成功提交后统一记录入口（仅 v2 载荷；v1 无指纹不写日志）
pub(crate) fn record_import_success(
    conn: &rusqlite::Connection,
    payload: &ExportPayload,
    payload_hash: &Option<String>,
    file_name: &str,
    file_size: u64,
) -> Result<(), AppError> {
    let Some(hash) = payload_hash else {
        return Ok(());
    };
    record_import_log(
        conn,
        hash,
        file_name,
        &payload.backup_type,
        file_size as i64,
    )
}
