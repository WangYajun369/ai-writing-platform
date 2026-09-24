//! 只读对账（Spec §5.5）
//!
//! 备份各行 vs 目标库：按 id + updated_at + 内容指纹分为
//! matched / missing / targetStale / targetNewer 四类，供导入预览与 merge 预判。

use super::types::{backup_is_newer, ChapterExport, DatabaseExport};
use crate::error::AppError;
use crate::models::{Book, Snapshot, Volume, WorldCard};
use rusqlite::params;
use serde::Serialize;

/// 行级对账分类（Spec §5.5）：
/// - matched：与目标库完全一致（updated_at + 内容指纹同）
/// - missing：备份有、目标库无 → 可补
/// - targetStale：目标库比备份旧 → 以备份覆盖才更新（merge 将覆盖）
/// - targetNewer：目标库比备份新 / 同时间戳内容冲突 → merge 保留目标库
#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct RowReconcile {
    pub(crate) matched: usize,
    #[serde(rename = "targetStale")]
    pub(crate) target_stale: usize,
    #[serde(rename = "targetNewer")]
    pub(crate) target_newer: usize,
    pub(crate) missing: usize,
}

/// 按表对账汇总（embeddings 无内容行，不参与；向量由本机重新索引）
#[derive(Debug, Default, Serialize)]
pub(crate) struct ReconcileReport {
    pub(crate) books: RowReconcile,
    pub(crate) volumes: RowReconcile,
    pub(crate) chapters: RowReconcile,
    pub(crate) snapshots: RowReconcile,
    #[serde(rename = "worldCards")]
    pub(crate) world_cards: RowReconcile,
}

/// 归一化可选字符串：None 与 Some("") 等价（跨库存储差异容忍）
pub(crate) fn fp_opt(v: Option<String>) -> String {
    v.unwrap_or_default()
}

pub(crate) fn classify_ts_row(
    out: &mut RowReconcile,
    backup_ts: &str,
    backup_fp: &str,
    target: Option<(String, String)>,
) {
    match target {
        None => out.missing += 1,
        Some((target_ts, target_fp)) => {
            if target_ts == backup_ts {
                if target_fp == backup_fp {
                    out.matched += 1;
                } else {
                    out.target_newer += 1; // 同时间戳内容冲突 → 默认保留目标
                }
            } else if backup_is_newer(backup_ts, &target_ts) {
                out.target_stale += 1;
            } else {
                out.target_newer += 1;
            }
        }
    }
}

pub(crate) fn classify_plain_row(out: &mut RowReconcile, backup_fp: &str, target: Option<String>) {
    match target {
        None => out.missing += 1,
        Some(target_fp) => {
            if target_fp == backup_fp {
                out.matched += 1;
            } else {
                out.target_newer += 1; // 无内容时钟的表，merge 对已存在行一律保留目标
            }
        }
    }
}

pub(crate) fn reconcile_books(conn: &rusqlite::Connection, rows: &[Book]) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT updated_at, title, author, description, cover_image, db_path, tags, deleted_at, outline \
         FROM books WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for b in rows {
        let target = {
            let mut q = stmt.query(params![b.id])?;
            match q.next()? {
                None => None,
                Some(r) => {
                    let target_fp = vec![
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        fp_opt(r.get::<_, Option<String>>(4)?),
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        fp_opt(r.get::<_, Option<String>>(7)?),
                        r.get::<_, String>(8)?,
                    ]
                    .join("\u{1}");
                    Some((r.get::<_, String>(0)?, target_fp))
                }
            }
        };
        let tags_json = serde_json::to_string(&b.tags).unwrap_or_else(|_| "[]".to_string());
        let backup_fp = vec![
            b.title.clone(),
            b.author.clone(),
            b.description.clone(),
            fp_opt(b.cover_image.clone()),
            b.db_path.clone(),
            tags_json,
            fp_opt(b.deleted_at.clone()),
            b.outline.clone(),
        ]
        .join("\u{1}");
        classify_ts_row(&mut out, &b.updated_at, &backup_fp, target);
    }
    Ok(out)
}

pub(crate) fn reconcile_volumes(
    conn: &rusqlite::Connection,
    rows: &[Volume],
) -> Result<RowReconcile, AppError> {
    let mut stmt =
        conn.prepare("SELECT title, sort_order, deleted_at FROM volumes WHERE id = ?1")?;
    let mut out = RowReconcile::default();
    for v in rows {
        let target = {
            let mut q = stmt.query(params![v.id])?;
            match q.next()? {
                None => None,
                Some(r) => Some(
                    vec![
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?.to_string(),
                        fp_opt(r.get::<_, Option<String>>(2)?),
                    ]
                    .join("\u{1}"),
                ),
            }
        };
        let backup_fp = vec![
            v.title.clone(),
            v.sort_order.to_string(),
            fp_opt(v.deleted_at.clone()),
        ]
        .join("\u{1}");
        classify_plain_row(&mut out, &backup_fp, target);
    }
    Ok(out)
}

pub(crate) fn reconcile_chapters(
    conn: &rusqlite::Connection,
    rows: &[ChapterExport],
) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT updated_at, volume_id, title, content_html, word_count, status, sort_order, \
                deleted_at, summary, summary_at, outline \
         FROM chapters WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for c in rows {
        let target = {
            let mut q = stmt.query(params![c.id])?;
            match q.next()? {
                None => None,
                Some(r) => {
                    let target_fp = vec![
                        fp_opt(r.get::<_, Option<String>>(1)?),
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?.to_string(),
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?.to_string(),
                        fp_opt(r.get::<_, Option<String>>(7)?),
                        fp_opt(r.get::<_, Option<String>>(8)?),
                        fp_opt(r.get::<_, Option<String>>(9)?),
                        r.get::<_, String>(10)?,
                    ]
                    .join("\u{1}");
                    Some((r.get::<_, String>(0)?, target_fp))
                }
            }
        };
        let backup_fp = vec![
            fp_opt(c.volume_id.clone()),
            c.title.clone(),
            c.content_html.clone(),
            c.word_count.to_string(),
            c.status.clone(),
            c.sort_order.to_string(),
            fp_opt(c.deleted_at.clone()),
            fp_opt(c.summary.clone()),
            fp_opt(c.summary_at.clone()),
            c.outline.clone(),
        ]
        .join("\u{1}");
        classify_ts_row(&mut out, &c.updated_at, &backup_fp, target);
    }
    Ok(out)
}

pub(crate) fn reconcile_snapshots(
    conn: &rusqlite::Connection,
    rows: &[Snapshot],
) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT chapter_id, content_html, word_count, type, label FROM snapshots WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for s in rows {
        let target = {
            let mut q = stmt.query(params![s.id])?;
            match q.next()? {
                None => None,
                Some(r) => Some(
                    vec![
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?.to_string(),
                        r.get::<_, String>(3)?,
                        fp_opt(r.get::<_, Option<String>>(4)?),
                    ]
                    .join("\u{1}"),
                ),
            }
        };
        let backup_fp = vec![
            s.chapter_id.clone(),
            s.content_html.clone(),
            s.word_count.to_string(),
            s.snapshot_type.clone(),
            fp_opt(s.label.clone()),
        ]
        .join("\u{1}");
        classify_plain_row(&mut out, &backup_fp, target);
    }
    Ok(out)
}

pub(crate) fn reconcile_world_cards(
    conn: &rusqlite::Connection,
    rows: &[WorldCard],
) -> Result<RowReconcile, AppError> {
    let mut stmt = conn.prepare(
        "SELECT updated_at, type, title, content, content_html, tags, vectorized \
         FROM world_cards WHERE id = ?1",
    )?;
    let mut out = RowReconcile::default();
    for w in rows {
        let target = {
            let mut q = stmt.query(params![w.id])?;
            match q.next()? {
                None => None,
                Some(r) => {
                    let target_fp = vec![
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?.to_string(),
                    ]
                    .join("\u{1}");
                    Some((r.get::<_, String>(0)?, target_fp))
                }
            }
        };
        let tags_json = serde_json::to_string(&w.tags).unwrap_or_else(|_| "[]".to_string());
        let backup_fp = vec![
            w.card_type.clone(),
            w.title.clone(),
            w.content.clone(),
            w.content_html.clone(),
            tags_json,
            (w.vectorized as i64).to_string(),
        ]
        .join("\u{1}");
        classify_ts_row(&mut out, &w.updated_at, &backup_fp, target);
    }
    Ok(out)
}

/// 只读对账：备份各行 vs 目标库（Spec §5.5 快速预判：id + updated_at + 内容指纹）
pub(crate) fn reconcile_backup(
    conn: &rusqlite::Connection,
    dbx: &DatabaseExport,
) -> Result<ReconcileReport, AppError> {
    Ok(ReconcileReport {
        books: reconcile_books(conn, &dbx.books)?,
        volumes: reconcile_volumes(conn, &dbx.volumes)?,
        chapters: reconcile_chapters(conn, &dbx.chapters)?,
        snapshots: reconcile_snapshots(conn, &dbx.snapshots)?,
        world_cards: reconcile_world_cards(conn, &dbx.world_cards)?,
    })
}
