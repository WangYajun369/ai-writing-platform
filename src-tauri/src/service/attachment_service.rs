//! 附件业务服务（任务卡 P2，PRD 12.4）
//!
//! 附件文件实体与数据库存放在同一数据根（真正「和 db 存储在一起」）：
//! `{app_data_dir}/attachments/`（文件名 = 附件 id + 扩展名），目录随 db 一起
//! 备份 / 整体搬迁。attachments 表 local_path 存相对数据根的路径
//! （如 `attachments/xxx.png`），历史绝对路径记录在启动时自动清洗为相对路径，
//! 目录搬移后打开 / 删除仍可按文件名兜底解析。
//! 提供：系统对话框选文件并复制入库、列表 / 系统默认应用打开 / 删除（同时清理文件）/
//! 孤儿文件每日清理。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::Attachment;
use crate::repository::attachment_repo;
use crate::service::activity_log_service;
use crate::utils::now;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

/// 附件大小上限（30MB）
pub const MAX_ATTACHMENT_SIZE: u64 = 30 * 1024 * 1024;

/// 附件目录名（与 db time_write.db 同根；DB 中相对路径以它开头）
pub const ATTACHMENT_DIR: &str = "attachments";
/// 历史版本附件目录（此前直接存放于数据根下），启动时自动并入新目录
const LEGACY_ATTACHMENT_DIR: &str = "task-attachments";

/// 应用数据根目录（数据库 time_write.db 所在目录）
fn data_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Business(format!("获取应用数据目录失败: {e}")))?;
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

/// 附件实体目录：{app_data_dir}/attachments（与 db 文件同一数据根）
pub fn attachment_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = data_root(app)?.join(ATTACHMENT_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 启动初始化（lib.rs 建库后调用）：
/// 1. 确保附件目录存在；
/// 2. 旧版 `task-attachments` 目录存在时，把文件并入 `attachments/`；
/// 3. 把 attachments 表中非相对路径的 local_path 统一清洗为
///    `attachments/<磁盘文件名>`，此后 db + 附件目录可整体搬迁而不失效。
pub fn ensure_store(app: &AppHandle, db: &AppDb) -> Result<(), AppError> {
    let root = data_root(app)?;
    let new_dir = root.join(ATTACHMENT_DIR);
    std::fs::create_dir_all(&new_dir)?;

    // 1) 旧目录文件并入：附件磁盘名 = uuid + 扩展名，天然不冲突
    let legacy = root.join(LEGACY_ATTACHMENT_DIR);
    if legacy.is_dir() {
        if move_legacy_files(&legacy, &new_dir) {
            crate::app_log!("[附件] 旧目录 task-attachments 文件已并入 attachments/");
        }
        let _ = std::fs::remove_dir(&legacy); // 遗留失败文件由孤儿清理兜底
    }

    // 2) local_path 规范化（历史绝对路径 → 相对数据根）
    let mut conn = db.pool.get()?;
    let rows = attachment_repo::all_id_paths(&conn)?;
    if rows.is_empty() {
        return Ok(());
    }
    let tx = conn
        .transaction()
        .map_err(|e| AppError::Business(format!("开始附件路径清洗事务失败: {e}")))?;
    let mut changed = 0usize;
    for (id, stored) in rows {
        let name = match Path::new(&stored).file_name().and_then(|n| n.to_str()) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let rel = format!("{ATTACHMENT_DIR}/{name}");
        if rel != stored {
            tx.execute(
                "UPDATE attachments SET local_path=?1 WHERE id=?2",
                rusqlite::params![rel, id],
            )?;
            changed += 1;
        }
    }
    if changed > 0 {
        tx.commit()
            .map_err(|e| AppError::Business(format!("附件路径清洗提交失败: {e}")))?;
        emit_sql_log(
            app,
            "UPDATE",
            "attachments",
            &format!("规范化 {changed} 条路径为相对数据根"),
            file!(),
            line!(),
        );
    }
    Ok(())
}

/// 把旧目录内文件逐项移动到新目录（跨目录 rename，同数据根内安全）
fn move_legacy_files(legacy: &Path, new_dir: &Path) -> bool {
    let mut any = false;
    if let Ok(entries) = std::fs::read_dir(legacy) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            if std::fs::rename(&p, &new_dir.join(entry.file_name())).is_ok() {
                any = true;
            }
        }
    }
    any
}

/// 把存储路径解析为磁盘绝对路径。
/// 兼容三种记录形态：新相对路径（attachments/x）、旧绝对路径（目录搬移后可能失效，
/// 此时按文件名在附件目录兜底查找，附件磁盘名 = uuid+扩展名，全局唯一）。
fn resolve_local(app: &AppHandle, stored: &str) -> Result<PathBuf, AppError> {
    let root = data_root(app)?;
    let p = Path::new(stored);
    let mut cands: Vec<PathBuf> = Vec::new();
    if p.is_absolute() {
        cands.push(p.to_path_buf());
    } else {
        cands.push(root.join(p)); // 相对数据根 → {root}/attachments/x
    }
    if let Some(name) = p.file_name() {
        cands.push(root.join(ATTACHMENT_DIR).join(name)); // 文件名兜底（整体搬移后）
    }
    cands
        .into_iter()
        .find(|c| c.is_file())
        .ok_or_else(|| AppError::NotFound("附件文件不存在（可能已被移动或删除）".into()))
}

/// 列出某任务的附件
pub fn list_attachments(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
) -> Result<Vec<Attachment>, AppError> {
    emit_sql_log(
        app,
        "SELECT",
        "attachments",
        &format!("task_id={task_id}"),
        file!(),
        line!(),
    );
    let conn = db.pool.get()?;
    Ok(attachment_repo::list_by_task(&conn, task_id)?)
}

/// 从系统文件对话框选择文件并复制入库；用户取消返回 Ok(None)。
/// 需在非主线程调用（tauri async command 满足此约束）。
pub fn pick_and_add(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
) -> Result<Option<Attachment>, AppError> {
    {
        let conn = db.pool.get()?;
        conn.query_row(
            "SELECT id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
            rusqlite::params![task_id],
            |_| Ok(()),
        )
        .map_err(|_| AppError::NotFound("任务不存在或已删除".into()))?;
    }
    // 注意：不要在 macOS 上使用 `add_filter(name, &["*"])` 全类型过滤器——
    // 通配符会被映射成无效 UTType，导致面板内所有文件灰置不可选。
    // 不加过滤器即默认所有文件可选（大小/类型限制由服务端校验）。
    let picked = app.dialog().file().blocking_pick_file();
    let Some(fp) = picked else {
        return Ok(None);
    };
    let source: PathBuf = fp
        .into_path()
        .map_err(|e| AppError::Business(format!("无法读取所选文件: {e}")))?;
    add_file(app, db, task_id, &source).map(Some)
}

/// 把已存在文件复制到附件目录并入库
pub fn add_file(
    app: &AppHandle,
    db: &AppDb,
    task_id: &str,
    source: &Path,
) -> Result<Attachment, AppError> {
    if !source.is_file() {
        return Err(AppError::Validation("选择的不是有效文件".into()));
    }
    let meta = std::fs::metadata(source)?;
    if meta.len() == 0 {
        return Err(AppError::Validation("空文件不能作为附件".into()));
    }
    if meta.len() > MAX_ATTACHMENT_SIZE {
        return Err(AppError::Validation(format!(
            "附件超过大小上限（30MB，当前 {:.1}MB）",
            meta.len() as f64 / 1024.0 / 1024.0
        )));
    }
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    // 防重名：若目录已有同名文件，追加随机短后缀
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let id = Uuid::new_v4().to_string();
    let stored = if ext.is_empty() {
        format!("{id}")
    } else {
        format!("{id}.{ext}")
    };
    let dir = attachment_dir(app)?;
    let dest = dir.join(&stored);
    std::fs::copy(source, &dest)?;

    let conn = db.pool.get()?;
    let ts = now();
    let ts_att = ts.clone();
    let result = (|| -> Result<Attachment, AppError> {
        let task_id = task_active_or_err(&conn, task_id)?.0;
        emit_sql_log(
            app,
            "INSERT",
            "attachments",
            &format!("id={id}"),
            file!(),
            line!(),
        );
        // local_path 记录相对数据根的路径（attachments/<磁盘名>），随 db 一起搬迁仍可用
        let rel = format!("{ATTACHMENT_DIR}/{stored}");
        attachment_repo::insert(
            &conn,
            &id,
            &task_id,
            &file_name,
            &ext,
            meta.len() as i64,
            &rel,
            &ts,
        )?;
        let mut list = attachment_repo::list_by_task(&conn, &task_id)?;
        list.retain(|a| a.id == id);
        Ok(list.into_iter().next().unwrap_or_else(|| Attachment {
            id: id.clone(),
            task_id: task_id.clone(),
            file_name: file_name.clone(),
            file_type: ext.clone(),
            file_size: meta.len() as i64,
            created_at: ts_att.clone(),
        }))
    })();
    if let Err(e) = result {
        // 入库失败则回滚已复制文件
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }
    activity_log_service::try_task_log(
        db,
        task_id,
        "attachment.added",
        &format!("添加附件 {file_name}"),
    );
    result
}

/// 打开附件（系统默认应用）
#[allow(deprecated)] // tauri-plugin-shell 的 open 已能完成系统打开；后续可平滑迁移到 tauri-plugin-opener
pub fn open_attachment(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let (_att, stored) = attachment_repo::find_active(&conn, id)
        .map_err(|_| AppError::NotFound("附件不存在或已删除".into()))?;
    let path = resolve_local(app, &stored)?;
    app.shell()
        .open(path.to_string_lossy(), None)
        .map_err(|e| AppError::Business(format!("打开附件失败: {e}")))?;
    Ok(())
}

/// 删除附件：移除记录并删除文件
pub fn delete_attachment(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let (att, stored) = attachment_repo::find_active(&conn, id)
        .map_err(|_| AppError::NotFound("附件不存在或已删除".into()))?;
    let task_id = att.task_id.clone();
    emit_sql_log(
        app,
        "DELETE",
        "attachments",
        &format!("id={id}"),
        file!(),
        line!(),
    );
    attachment_repo::soft_delete(&conn, id, &now())?;
    if let Ok(p) = resolve_local(app, &stored) {
        let _ = std::fs::remove_file(&p); // 记录已删，文件尽力清理
    }
    activity_log_service::try_task_log(
        db,
        &task_id,
        "attachment.removed",
        &format!("删除附件 {}", att.file_name),
    );
    Ok(())
}

/// 孤儿文件清理：删除附件目录中不在任何（含软删）记录里的文件。
/// 由回收站每日自动清理尾部调用，兜底 purge 后遗留文件。
pub fn cleanup_orphan_files(app: &AppHandle, db: &AppDb) -> Result<usize, AppError> {
    let dir = attachment_dir(app)?;
    let conn = db.pool.get()?;
    // 参照 = 数据库（含软删）全部记录对应的磁盘文件名；磁盘名 = uuid+扩展名，全局唯一，
    // 故只按文件名对照（不依赖 local_path 的绝对/相对形态，目录搬迁后同样正确）
    let referenced: HashSet<String> = attachment_repo::all_paths(&conn)?
        .into_iter()
        .filter_map(|s| {
            Path::new(&s)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.to_string())
        })
        .collect();
    let mut removed = 0usize;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !referenced.contains(&name) {
            if std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

type ActiveTask = (String, Option<String>);
fn task_active_or_err(conn: &rusqlite::Connection, task_id: &str) -> Result<ActiveTask, AppError> {
    conn.query_row(
        "SELECT id, project_id FROM tasks WHERE id=?1 AND deleted_at IS NULL",
        rusqlite::params![task_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .map_err(|_| AppError::NotFound("任务不存在或已删除".into()))
}
