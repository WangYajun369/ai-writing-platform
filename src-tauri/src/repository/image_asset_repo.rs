//! 图片资产数据访问层（v1.20 新增）
//!
//! 提供 image_assets 表的 SQL 操作：按 sha256 查重、插入、按 id 查找。
//! 文件系统操作（存/删图片文件）在上层 service 完成，本层只管 DB。

use crate::models::ImageAsset;
use rusqlite::{params, Connection, OptionalExtension, Result};

const COLS: &str =
    "id, sha256, original_name, original_size, original_width, original_height, \
     original_format, stored_path, stored_width, stored_height, stored_format, \
     source, source_url, created_at";

fn row_to_asset(row: &rusqlite::Row) -> rusqlite::Result<ImageAsset> {
    Ok(ImageAsset {
        id: row.get(0)?,
        sha256: row.get(1)?,
        original_name: row.get(2)?,
        original_size: row.get(3)?,
        original_width: row.get(4)?,
        original_height: row.get(5)?,
        original_format: row.get(6)?,
        stored_path: row.get(7)?,
        stored_width: row.get(8)?,
        stored_height: row.get(9)?,
        stored_format: row.get(10)?,
        source: row.get(11)?,
        source_url: row.get(12)?,
        created_at: row.get(13)?,
    })
}

/// 按 sha256 查找（用于去重：相同内容不重复存文件）
pub fn find_by_sha256(conn: &Connection, sha256: &str) -> Result<Option<ImageAsset>> {
    let sql = format!(
        "SELECT {} FROM image_assets WHERE sha256 = ?1 LIMIT 1",
        COLS
    );
    conn.query_row(&sql, params![sha256], row_to_asset)
        .optional()
}

/// 按 stored_path 查找（完整或相对路径都匹配，用于从 asset:// URL 反查资产）
pub fn find_by_stored_path(conn: &Connection, path: &str) -> Result<Option<ImageAsset>> {
    let sql = format!(
        "SELECT {} FROM image_assets WHERE stored_path = ?1 OR stored_path LIKE ?2 LIMIT 1",
        COLS
    );
    // path 可能是完整绝对路径 images/xxx.jpg，或 asset://... 的末尾部分
    let like = format!("%{}", path.replace('\\', "/"));
    conn.query_row(&sql, params![path, like], row_to_asset)
        .optional()
}

/// 按 id 查找（供 migrate_html_data_urls、资产清理等上层功能使用）
#[allow(dead_code)]
pub fn find_by_id(conn: &Connection, id: &str) -> Result<Option<ImageAsset>> {
    let sql = format!("SELECT {} FROM image_assets WHERE id = ?1", COLS);
    conn.query_row(&sql, params![id], row_to_asset).optional()
}

/// 插入图片资产
pub fn insert(conn: &Connection, asset: &ImageAsset) -> Result<()> {
    conn.execute(
        "INSERT INTO image_assets (id, sha256, original_name, original_size, \
         original_width, original_height, original_format, stored_path, stored_width, \
         stored_height, stored_format, source, source_url, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            asset.id,
            asset.sha256,
            asset.original_name,
            asset.original_size,
            asset.original_width,
            asset.original_height,
            asset.original_format,
            asset.stored_path,
            asset.stored_width,
            asset.stored_height,
            asset.stored_format,
            asset.source,
            asset.source_url,
            asset.created_at,
        ],
    )?;
    Ok(())
}

/// 删除（清理孤立资产时使用）
#[allow(dead_code)]
pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM image_assets WHERE id = ?1", params![id])?;
    Ok(())
}

/// 全部资产列表（用于导出/备份统计、资产面板等）
#[allow(dead_code)]
pub fn list_all(conn: &Connection) -> Result<Vec<ImageAsset>> {
    let sql = format!(
        "SELECT {} FROM image_assets ORDER BY created_at DESC",
        COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_asset)?;
    rows.collect()
}
