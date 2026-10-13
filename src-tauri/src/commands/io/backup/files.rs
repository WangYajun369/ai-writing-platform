//! 备份文件资产打包（插件 / 附件）
//!
//! ## 为什么要有这一段
//!
//! 备份原本只覆盖数据库（纯 JSON），而插件（`plugins/`）与附件（`attachments/`）是
//! 数据库之外的文件实体 —— 不打包，一次「导出 → 导入」后插件直接消失、附件只剩库内引用。
//!
//! ## 载荷形态：内嵌 base64，不做 tar / zip
//!
//! 文件以 `files.items[].contentB64` 内嵌进同一份 JSON。相比打包成归档再塞进载荷，
//! 这样加解密链路、`payloadHash` 语义、「临时文件 + rename」原子写出全都不用改，
//! 也不引入新依赖（`base64` 已在依赖表中）。代价是体积膨胀约 1/3，由下面的上限兜住。
//!
//! ## 四条硬约束
//!
//! 1. **仅全量备份携带**：插件与附件都不是作品级数据，与 `app_config` 同一条规则，
//!    单作品备份的作用域保持纯净。
//! 2. **还原只写不删**：文件没有回退点（`rollback_import` 只恢复数据库）。若按 replace
//!    语义先清空本地目录，导入后即便回滚数据库，被删的文件也回不来。故只写入备份里
//!    有的文件，本地多出来的文件一律保留。
//! 3. **路径必须落在白名单内**：`path` 来自不可信的备份文件，必须挡住 `../`、
//!    绝对路径与白名单外的根目录，否则一份恶意备份就能往数据根之外写文件。
//! 4. **不追符号链接**：收集时按 `symlink_metadata` 判定，只收普通文件。
//!
//! ## 已知取舍
//!
//! - `payloadHash` 仍只覆盖 `database`，不覆盖文件段：改动它会使旧备份的幂等判定失效，
//!   而文件损坏的后果是「插件加载失败 / 附件打不开」，由各自的加载路径报错即可。
//! - 文件段超上限是**截断**而非报错：附件动辄几十 MB，因为附件超标就拒绝整份备份
//!   （连书都导不出来）代价太大。截断时置 `truncated` 并留日志。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::types::ImportStrategy;
use crate::error::{AppError, ErrCode};
use crate::plugin::loader::PLUGINS_DIR;
use crate::service::attachment_service::ATTACHMENT_DIR;

/// 纳入打包的目录白名单（相对数据根的顶层目录名）
///
/// 复用两处真实常量而非重写字符串：改目录名时这里会跟着变，不会出现
/// 「打包的是 plugins、还原的是别的目录」这类静默漂移。
const PACKED_DIRS: &[&str] = &[PLUGINS_DIR, ATTACHMENT_DIR];

/// 单个文件上限：32 MB（附件上限 30 MB，插件只有几 KB；超出的不是合法资产）
const MAX_ASSET_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// 文件段总量上限：64 MB（base64 后约 85 MB，仍在 200 MB 载荷上限内）
const MAX_ASSETS_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// 单个文件资产
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct FileAssetExport {
    /// 相对数据根的路径（统一 `/` 分隔，如 `plugins/foo/index.js`）
    pub(crate) path: String,
    #[serde(rename = "contentB64")]
    pub(crate) content_b64: String,
}

/// 文件资产段
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct FilesExport {
    pub(crate) items: Vec<FileAssetExport>,
    /// 是否因超出总量上限被截断（true = 备份里的文件不完整）
    pub(crate) truncated: bool,
}

// ---- 收集 ----

/// 收集数据根下的全部打包目录内容（最佳努力：读不到的文件跳过，不中断备份）
pub(crate) fn collect_files(root: &Path) -> FilesExport {
    let mut out = FilesExport::default();
    let mut total: u64 = 0;
    for dir in PACKED_DIRS {
        collect_dir(root, root.join(dir), &mut out, &mut total);
    }
    out.items.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// 深度优先收集一个目录（栈式，避免递归爆栈）
fn collect_dir(root: &Path, base: PathBuf, out: &mut FilesExport, total: &mut u64) {
    let Ok(entries) = std::fs::read_dir(&base) else {
        return; // 目录不存在 = 该类资产为空（插件目录是首次使用时才创建的）
    };
    // 显式栈而非递归：用户目录层级不受我们控制
    let mut stack: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    while let Some(path) = stack.pop() {
        if out.truncated {
            return;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            if let Ok(sub) = std::fs::read_dir(&path) {
                stack.extend(sub.flatten().map(|e| e.path()));
            }
            continue;
        }
        // 只收普通文件：符号链接 / 设备文件一律跳过，不追链接以免跳出数据根
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_ASSET_FILE_BYTES {
            crate::app_log!(
                "[Backup] 文件资产跳过（{} MB 超过单文件上限）：{}",
                meta.len() / 1024 / 1024,
                path.display()
            );
            continue;
        }
        if *total + meta.len() > MAX_ASSETS_TOTAL_BYTES {
            out.truncated = true;
            crate::app_log!(
                "[Backup] 文件资产已达上限 64 MB，剩余文件不再收集（备份中的文件段不完整）：{}",
                path.display()
            );
            return;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Some(rel) = relative_path(root, &path) else {
            continue;
        };
        *total += bytes.len() as u64;
        out.items.push(FileAssetExport {
            path: rel,
            content_b64: STANDARD.encode(&bytes),
        });
    }
}

/// 相对数据根的路径（`/` 分隔）；非 UTF-8 文件名无法安全还原，直接放弃
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for c in rel.components() {
        parts.push(c.as_os_str().to_str()?.to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

// ---- 还原 ----

/// 校验备份里的相对路径；不安全返回 None（调用方跳过并记录）
fn safe_rel_path(rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') {
        return None;
    }
    let mut parts = rel.split('/');
    let first = parts.next()?;
    if !PACKED_DIRS.contains(&first) {
        return None;
    }
    let mut joined = PathBuf::from(first);
    for c in parts {
        if c.is_empty() || c == "." || c == ".." {
            return None;
        }
        joined.push(c);
    }
    Some(joined)
}

/// 把文件资产写回数据根（最佳努力：逐个失败只记录，返回成功写入的个数）
///
/// `overwrite == false`（fill-gaps 策略）时跳过已存在的同名文件，与「绝不触碰已有数据」
/// 的策略语义保持一致。
pub(crate) fn restore_files(root: &Path, files: &FilesExport, overwrite: bool) -> usize {
    let mut restored = 0usize;
    for item in &files.items {
        let Some(rel) = safe_rel_path(&item.path) else {
            crate::app_log!("[Backup] 文件资产路径不合法，已跳过：{}", item.path);
            continue;
        };
        let target = root.join(rel);
        if target.exists() && !overwrite {
            continue;
        }
        let Ok(bytes) = STANDARD.decode(&item.content_b64) else {
            crate::app_log!("[Backup] 文件资产 base64 解码失败，已跳过：{}", item.path);
            continue;
        };
        if let Some(parent) = target.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                crate::app_log!("[Backup] 文件资产目录创建失败，已跳过：{} ({})", item.path, e);
                continue;
            }
        }
        if let Err(e) = std::fs::write(&target, &bytes) {
            crate::app_log!("[Backup] 文件资产写入失败，已跳过：{} ({})", item.path, e);
            continue;
        }
        restored += 1;
    }
    restored
}

// ---- AppHandle 薄封装（解析数据根） ----

fn data_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let root = app.path().app_data_dir().map_err(|e| {
        AppError::business(ErrCode::Io, format!("获取应用数据目录失败: {e}"))
    })?;
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

/// 收集本机的文件资产（导出侧调用）
pub(crate) fn collect_file_assets(app: &AppHandle) -> Result<FilesExport, AppError> {
    let root = data_root(app)?;
    Ok(collect_files(&root))
}

/// 还原备份里的文件资产（导入侧调用；备份无此段时返回 0）
pub(crate) fn restore_file_assets(
    app: &AppHandle,
    files: Option<&FilesExport>,
    strategy: ImportStrategy,
) -> Result<usize, AppError> {
    let Some(files) = files else {
        return Ok(0);
    };
    if files.truncated {
        crate::app_log!("[Backup] 该备份的文件段曾被上限截断，文件恢复不完整");
    }
    let root = data_root(app)?;
    Ok(restore_files(
        &root,
        files,
        strategy != ImportStrategy::FillGaps,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::io::backup::types::ExportPayload;
    use std::fs;

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tw-backup-files-{}-{}", tag, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    // -- 路径校验 --

    #[test]
    fn safe_rel_path_accepts_whitelisted_paths() {
        assert_eq!(
            safe_rel_path("plugins/foo/index.js").unwrap(),
            PathBuf::from("plugins/foo/index.js")
        );
        assert_eq!(
            safe_rel_path("attachments/a.png").unwrap(),
            PathBuf::from("attachments/a.png")
        );
        assert_eq!(
            safe_rel_path("plugins/enabled.json").unwrap(),
            PathBuf::from("plugins/enabled.json")
        );
    }

    #[test]
    fn safe_rel_path_rejects_escape_and_outside_roots() {
        for bad in [
            "",
            "/plugins/x.js",
            "../plugins/x.js",
            "plugins/../../etc/passwd",
            "plugins/./x.js",
            "plugins//x.js",
            "plugins\\x.js",
            "database/time_write.db",
            "pluginsX/x.js",
        ] {
            assert_eq!(safe_rel_path(bad), None, "应拒绝: {bad}");
        }
    }

    // -- 收集 / 还原 --

    #[test]
    fn collect_and_restore_roundtrip() {
        let root = tmp("roundtrip");
        fs::create_dir_all(root.join("plugins/demo")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("plugins/enabled.json"), r#"["demo"]"#).unwrap();
        fs::write(root.join("plugins/demo/manifest.json"), r#"{"id":"demo"}"#).unwrap();
        fs::write(root.join("plugins/demo/index.js"), "export default {}").unwrap();
        fs::write(root.join("attachments/a.png"), [1u8, 2, 3, 4]).unwrap();
        // 不该被收进去的东西（白名单外目录）
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("other/secret.txt"), "nope").unwrap();

        let collected = collect_files(&root);
        assert_eq!(collected.items.len(), 4, "只收白名单目录内的文件");
        assert!(!collected.truncated);
        assert_eq!(collected.items[0].path, "attachments/a.png");
        assert_eq!(collected.items[1].path, "plugins/demo/index.js");

        let target = tmp("roundtrip-out");
        let n = restore_files(&target, &collected, true);
        assert_eq!(n, 4);
        assert_eq!(
            fs::read_to_string(target.join("plugins/demo/manifest.json")).unwrap(),
            r#"{"id":"demo"}"#
        );
        assert_eq!(fs::read(target.join("attachments/a.png")).unwrap(), vec![1, 2, 3, 4]);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&target);
    }

    #[test]
    fn restore_skips_unsafe_paths_and_never_writes_outside_root() {
        let root = tmp("unsafe");
        let files = FilesExport {
            items: vec![
                FileAssetExport {
                    path: "../escaped.txt".to_string(),
                    content_b64: STANDARD.encode(b"x"),
                },
                FileAssetExport {
                    path: "plugins/ok.js".to_string(),
                    content_b64: STANDARD.encode(b"ok"),
                },
            ],
            truncated: false,
        };
        assert_eq!(restore_files(&root, &files, true), 1);
        assert!(!root.parent().unwrap().join("escaped.txt").exists());
        assert_eq!(fs::read(root.join("plugins/ok.js")).unwrap(), b"ok");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fill_gaps_does_not_overwrite_existing_file() {
        let root = tmp("fillgaps");
        fs::create_dir_all(root.join("plugins/demo")).unwrap();
        fs::write(root.join("plugins/demo/index.js"), b"local").unwrap();
        let files = FilesExport {
            items: vec![FileAssetExport {
                path: "plugins/demo/index.js".to_string(),
                content_b64: STANDARD.encode(b"from-backup"),
            }],
            truncated: false,
        };
        assert_eq!(restore_files(&root, &files, false), 0);
        assert_eq!(fs::read(root.join("plugins/demo/index.js")).unwrap(), b"local");
        assert_eq!(restore_files(&root, &files, true), 1);
        assert_eq!(
            fs::read(root.join("plugins/demo/index.js")).unwrap(),
            b"from-backup"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn oversize_file_is_skipped_and_total_cap_sets_truncated() {
        let root = tmp("caps");
        fs::create_dir_all(root.join("attachments")).unwrap();
        // 单文件超限（用一个稀疏大文件，避免真写 32MB）
        let big = root.join("attachments/big.bin");
        let f = fs::File::create(&big).unwrap();
        f.set_len(MAX_ASSET_FILE_BYTES + 1).unwrap();
        drop(f);
        let out = collect_files(&root);
        assert!(out.items.is_empty(), "超限单文件被跳过");
        assert!(!out.truncated, "跳过单文件不算截断");

        fs::remove_file(&big).unwrap();
        // 三个「刚好不超单文件上限」的文件：前两个进得去，第三个顶到总量上限
        let each = MAX_ASSET_FILE_BYTES - 1024 * 1024;
        for name in ["a.bin", "b.bin", "c.bin"] {
            let f = fs::File::create(root.join("attachments").join(name)).unwrap();
            f.set_len(each).unwrap();
            drop(f);
        }
        let out = collect_files(&root);
        assert_eq!(out.items.len(), 2, "总量上限触发后停止收集");
        assert!(out.truncated);

        let _ = fs::remove_dir_all(&root);
    }

    // -- 旧版载荷兼容 --

    #[test]
    fn legacy_payload_without_files_deserializes() {
        let json = r#"{
            "version": "2.0",
            "exportedAt": "2026-01-01T00:00:00Z",
            "backupType": "full",
            "database": {
                "books": [], "volumes": [], "chapters": [], "snapshots": [],
                "worldCards": [], "embeddings": []
            },
            "cache": {}
        }"#;
        let payload: ExportPayload = serde_json::from_str(json).unwrap();
        assert!(payload.files.is_none(), "无 files 段的旧备份解析为 None");
    }
}
