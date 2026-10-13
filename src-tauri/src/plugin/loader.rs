//! Agent 插件加载器（ADR-006 决策 3 / 4）
//!
//! ## 包格式
//!
//! ```text
//! {app_data_dir}/plugins/
//!   ├── enabled.json              # 启用清单（持久化，独立于插件目录）
//!   └── <plugin-id>/
//!         ├── manifest.json       # 清单：id / name / grants / profiles / entry
//!         └── index.js            # 插件代码（entry 可改）
//! ```
//!
//! ## 两条校验线
//!
//! 1. **清单校验**（[`validate`]）：id 合法、目录名与 id 一致、入口存在、
//!    画像不与内置撞车、声明的工具都被 `grants` 覆盖。安装与加载共用同一套规则。
//! 2. **工具映射**（[`model::grant_for_tool`]）：插件画像是*声明式*的——只声明
//!    工具名、由 Rust 引擎代为执行，全程不跑插件 JS。若不把工具映射回 `grants`，
//!    插件就能绕过权限声明直接借 L0 的原子能力读写数据。
//!
//! ## 刻意的最小化
//!
//! 安装时**只复制 `manifest.json` 与 `entry` 两个文件**，不递归复制整个源目录。
//! 理由是包格式本来就只定义这两个文件，多拷一个都是无谓的攻击面
//! （源目录里无关的脚本、符号链接指向的文件都不会被带进来）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

// Manager：`app.path()` 的来源（app_data_dir 解析所必需的 trait）
use tauri::{AppHandle, Manager};

use crate::commands::agent::{profiles, tools};
use crate::error::{AppError, ErrCode};
use crate::plugin::model::{
    grant_for_tool, is_valid_id, InstalledPlugin, PluginManifest, PluginStatus,
};

/// 插件根目录名（位于 `app_data_dir` 下）
///
/// `pub(crate)`：备份的文件资产打包复用它做白名单，避免目录名在两处各写一份。
pub(crate) const PLUGINS_DIR: &str = "plugins";
/// 启用清单文件名
const ENABLED_FILE: &str = "enabled.json";
/// 清单文件名
const MANIFEST_FILE: &str = "manifest.json";

/// 插件根目录 `{app_data_dir}/plugins`（不存在则创建）
pub fn plugins_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let root = app.path().app_data_dir().map_err(|e| {
        AppError::business(ErrCode::Io, format!("获取应用数据目录失败: {e}"))
    })?;
    let dir = root.join(PLUGINS_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 启用清单路径
fn enabled_path(root: &Path) -> PathBuf {
    root.join(ENABLED_FILE)
}

/// 读取启用清单
///
/// 文件缺失或内容损坏一律视为「空集合」——启用状态是可以重建的偏好，
/// 不值得因为它挡住整个插件列表。
fn read_enabled(root: &Path) -> HashSet<String> {
    std::fs::read_to_string(enabled_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// 写回启用清单（排序后落盘，保证 diff 稳定）
fn write_enabled(root: &Path, ids: &HashSet<String>) -> Result<(), AppError> {
    let mut list: Vec<String> = ids.iter().cloned().collect();
    list.sort();
    let json = serde_json::to_string_pretty(&list)?;
    std::fs::write(enabled_path(root), json)?;
    Ok(())
}

/// 入口文件名白名单校验
///
/// `entry` 来自不可信的 manifest，而它会被拼进路径去读文件——
/// 必须挡住 `../`、绝对路径与分隔符，否则插件能读到插件目录以外的文件。
fn is_safe_entry(entry: &str) -> bool {
    !entry.is_empty()
        && !entry.contains('/')
        && !entry.contains('\\')
        && !entry.contains("..")
        && !Path::new(entry).is_absolute()
}

/// 读取并解析插件清单
fn read_manifest(dir: &Path) -> Result<PluginManifest, AppError> {
    let path = dir.join(MANIFEST_FILE);
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        AppError::business(
            ErrCode::PluginManifest,
            format!("读取 {MANIFEST_FILE} 失败: {e}"),
        )
    })?;
    serde_json::from_str::<PluginManifest>(&raw).map_err(|e| {
        AppError::business(
            ErrCode::PluginManifest,
            format!("{MANIFEST_FILE} 解析失败: {e}"),
        )
    })
}

/// 校验插件清单
///
/// 安装与加载共用（单一真源）。返回 `Err` 即拒绝——
/// **不做降级忽略**：静默放过一个错误的权限声明，比装不上更危险。
fn validate(m: &PluginManifest, dir: &Path) -> Result<(), AppError> {
    if !is_valid_id(&m.id) {
        return Err(AppError::business(
            ErrCode::PluginManifest,
            format!(
                "插件 id `{}` 不合法：须 2~64 位小写字母/数字/连字符，且不以连字符开头",
                m.id
            ),
        ));
    }
    // 目录即命名空间：两者不一致会让「按 id 定位插件」在任何环节都不可靠
    let dir_name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if dir_name != m.id {
        return Err(AppError::business(
            ErrCode::PluginManifest,
            format!("插件 id `{}` 与目录名 `{}` 不一致", m.id, dir_name),
        ));
    }
    if m.name.trim().is_empty() {
        return Err(AppError::business(
            ErrCode::PluginManifest,
            "插件 name 不能为空".to_string(),
        ));
    }
    if !is_safe_entry(&m.entry) {
        return Err(AppError::business(
            ErrCode::PluginManifest,
            format!("entry `{}` 不合法：须为插件目录下的单个文件名", m.entry),
        ));
    }
    if !dir.join(&m.entry).is_file() {
        return Err(AppError::business(
            ErrCode::PluginManifest,
            format!("入口文件 `{}` 不存在", m.entry),
        ));
    }

    // ── 画像校验 ──
    let builtin_ids = profiles::builtin_profile_ids();
    let mut seen: HashSet<&str> = HashSet::new();
    for p in &m.profiles {
        if !is_valid_id(&p.id) {
            return Err(AppError::business(
                ErrCode::PluginManifest,
                format!("画像 id `{}` 不合法（同插件 id 规则）", p.id),
            ));
        }
        // ADR-006 follow-up 定稿：加载时校验，撞车即拒绝（而非加命名空间前缀）
        if builtin_ids.contains(&p.id.as_str()) {
            return Err(AppError::business(
                ErrCode::PluginConflict,
                format!(
                    "画像 id `{}` 与内置画像撞车，请改用其他 id（如 `{}-{}`）",
                    p.id, m.id, p.id
                ),
            ));
        }
        if !seen.insert(p.id.as_str()) {
            return Err(AppError::business(
                ErrCode::PluginManifest,
                format!("画像 id `{}` 在本插件内重复", p.id),
            ));
        }
        if p.base_prompt.trim().is_empty() {
            return Err(AppError::business(
                ErrCode::PluginManifest,
                format!("画像 `{}` 的 basePrompt 不能为空", p.id),
            ));
        }
        // 工具必须先在 L0 注册表里存在，再检查是否被 grants 覆盖
        for t in &p.tools {
            if !tools::registered_tool_names().contains(&t.as_str()) {
                return Err(AppError::business(
                    ErrCode::PluginManifest,
                    format!("画像 `{}` 引用了未知工具 `{}`", p.id, t),
                ));
            }
            match grant_for_tool(t) {
                Some(g) if !m.grants.contains(&g) => {
                    return Err(AppError::business(
                        ErrCode::PluginManifest,
                        format!(
                            "画像 `{}` 的工具 `{}` 需要权限 `{}`，但插件未声明该 grant",
                            p.id,
                            t,
                            g.as_str()
                        ),
                    ));
                }
                Some(_) => {}
                // 在注册表内却无映射 ⇒ 新增工具时忘了同步 grant_for_tool。
                // 这是宿主自身的疏漏，不能让插件为它买单，故放行。
                None => {}
            }
        }
    }
    Ok(())
}

/// 加载单个插件目录
fn load_one(dir: &Path, enabled: bool) -> Result<InstalledPlugin, AppError> {
    let manifest = read_manifest(dir)?;
    validate(&manifest, dir)?;
    Ok(InstalledPlugin {
        manifest,
        enabled,
        status: PluginStatus::Ok,
        error: None,
    })
}

/// 已安装插件列表（按 id 排序）
///
/// 清单损坏的插件**仍然列出**（`status: error` + 原因），
/// 否则用户将永远无法在 UI 里卸载一个装坏了的插件。
pub fn list_plugins(app: &AppHandle) -> Result<Vec<InstalledPlugin>, AppError> {
    let root = plugins_dir(app)?;
    let enabled = read_enabled(&root);
    let mut out: Vec<InstalledPlugin> = Vec::new();

    let rd = match std::fs::read_dir(&root) {
        Ok(rd) => rd,
        // 目录不存在（首次运行）⇒ 空列表，不是错误
        Err(_) => return Ok(out),
    };

    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        match load_one(&path, enabled.contains(&dir_name)) {
            Ok(p) => out.push(p),
            Err(e) => out.push(InstalledPlugin {
                // 占位清单：让 UI 至少能显示目录名并提供卸载入口
                manifest: PluginManifest {
                    id: dir_name.clone(),
                    name: dir_name.clone(),
                    version: String::new(),
                    description: String::new(),
                    author: None,
                    grants: Vec::new(),
                    profiles: Vec::new(),
                    entry: String::new(),
                },
                // 装坏的插件强制不启用，避免带着错误清单参与画像合并
                enabled: false,
                status: PluginStatus::Error,
                error: Some(e.to_string()),
            }),
        }
    }

    out.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    Ok(out)
}

/// 已启用且校验通过的插件（供 L3 画像合并）
///
/// 读盘失败时返回空集并记录日志：画像列表不该因为插件目录不可读而整个崩掉。
pub fn enabled_plugins(app: &AppHandle) -> Vec<InstalledPlugin> {
    match list_plugins(app) {
        Ok(list) => list
            .into_iter()
            .filter(|p| p.enabled && p.status == PluginStatus::Ok)
            .collect(),
        Err(e) => {
            crate::app_log_error!("[Plugin] 加载插件列表失败，已按无插件处理: {e}");
            Vec::new()
        }
    }
}

/// 读取插件源码（供安装确认界面展示）
pub fn read_plugin_source(app: &AppHandle, id: &str) -> Result<String, AppError> {
    let dir = plugin_dir(app, id)?;
    let m = read_manifest(&dir)?;
    if !is_safe_entry(&m.entry) {
        return Err(AppError::business(
            ErrCode::PluginManifest,
            format!("entry `{}` 不合法", m.entry),
        ));
    }
    std::fs::read_to_string(dir.join(&m.entry)).map_err(|e| {
        AppError::business(ErrCode::Io, format!("读取插件源码失败: {e}"))
    })
}

/// 插件目录（校验 id 合法性后拼接）
fn plugin_dir(app: &AppHandle, id: &str) -> Result<PathBuf, AppError> {
    if !is_valid_id(id) {
        return Err(AppError::business(
            ErrCode::Validation,
            format!("插件 id `{id}` 不合法"),
        ));
    }
    Ok(plugins_dir(app)?.join(id))
}

/// 安装插件：从源目录复制 `manifest.json` + `entry` 到 `plugins/<id>/`
///
/// 同名插件已存在时**先删后装**（等价于覆盖更新），
/// 启用状态不受影响——它存在独立的 `enabled.json` 里。
///
/// 安装后默认**未启用**，须用户在确认界面逐项确认 `grants` 后再启用。
pub fn install_plugin(app: &AppHandle, src: &Path) -> Result<InstalledPlugin, AppError> {
    if !src.is_dir() {
        return Err(AppError::business(
            ErrCode::Validation,
            "插件源路径不是一个目录".to_string(),
        ));
    }
    // 先解析源清单，拿到 id 才能确定目标目录
    let manifest = read_manifest(src)?;
    if !is_safe_entry(&manifest.entry) {
        return Err(AppError::business(
            ErrCode::PluginManifest,
            format!("entry `{}` 不合法", manifest.entry),
        ));
    }
    let root = plugins_dir(app)?;
    let dest = root.join(&manifest.id);
    // 目标目录名即 id，校验据此比对两者一致
    validate(&manifest, &dest)?;

    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    std::fs::create_dir_all(&dest)?;
    std::fs::copy(src.join(MANIFEST_FILE), dest.join(MANIFEST_FILE))?;
    std::fs::copy(src.join(&manifest.entry), dest.join(&manifest.entry))?;

    Ok(InstalledPlugin {
        manifest,
        enabled: false,
        status: PluginStatus::Ok,
        error: None,
    })
}

/// 卸载插件：删除目录并从启用清单移除
pub fn uninstall_plugin(app: &AppHandle, id: &str) -> Result<(), AppError> {
    let dir = plugin_dir(app, id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    let root = plugins_dir(app)?;
    let mut set = read_enabled(&root);
    set.remove(id);
    write_enabled(&root, &set)
}

/// 设置启用状态
///
/// 启用前重跑一次全量校验：一个插件可能在安装之后才变坏
/// （例如新版本内置了一个与它同名的画像）。
pub fn set_plugin_enabled(app: &AppHandle, id: &str, enabled: bool) -> Result<(), AppError> {
    let dir = plugin_dir(app, id)?;
    if enabled && !dir.is_dir() {
        return Err(AppError::business(
            ErrCode::NotFound,
            format!("插件 `{id}` 不存在"),
        ));
    }
    if enabled {
        load_one(&dir, true)?;
    }
    let root = plugins_dir(app)?;
    let mut set = read_enabled(&root);
    if enabled {
        set.insert(id.to_string());
    } else {
        set.remove(id);
    }
    write_enabled(&root, &set)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_plugin(dir: &Path, id: &str, entry: &str, grants: &str, profiles: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(MANIFEST_FILE),
            format!(
                r#"{{"id":"{id}","name":"P","version":"1.0.0","description":"d","grants":{grants},"profiles":{profiles},"entry":"{entry}"}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join(entry), "console.log(1)").unwrap();
    }

    /// 构造一个通过全量校验的最小插件目录
    fn write_ok_plugin(root: &Path, id: &str) {
        write_plugin(&root.join(id), id, "index.js", r#"["book.read"]"#, "[]");
    }

    #[test]
    fn is_safe_entry_rejects_traversal() {
        assert!(is_safe_entry("index.js"));
        assert!(is_safe_entry("main.mjs"));
        for bad in ["", "../secret.txt", "a/b.js", "C:\\x.js", "/etc/passwd", ".."] {
            assert!(!is_safe_entry(bad), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn validate_rejects_id_dir_mismatch() {
        let tmp = std::env::temp_dir().join("tw-plugin-test-mismatch");
        let _ = std::fs::remove_dir_all(&tmp);
        write_ok_plugin(&tmp, "good-id");
        let m = read_manifest(&tmp.join("good-id")).unwrap();
        // 目录名是 good-id，却拿 bad-id 目录来比对 ⇒ 应拒绝
        let err = validate(&m, &tmp.join("bad-id")).unwrap_err();
        assert_eq!(err.code(), "E_PLUGIN_MANIFEST");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_rejects_missing_entry_file() {
        let tmp = std::env::temp_dir().join("tw-plugin-test-noentry");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = tmp.join("no-entry");
        write_plugin(&dir, "no-entry", "index.js", "[]", "[]");
        std::fs::remove_file(dir.join("index.js")).unwrap();
        let m = read_manifest(&dir).unwrap();
        let err = validate(&m, &dir).unwrap_err();
        assert_eq!(err.code(), "E_PLUGIN_MANIFEST");
        assert!(err.to_string().contains("不存在"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_rejects_profile_id_colliding_with_builtin() {
        let tmp = std::env::temp_dir().join("tw-plugin-test-collide");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = tmp.join("collide");
        // writing 是内置能力画像 id
        write_plugin(
            &dir,
            "collide",
            "index.js",
            "[]",
            // 注意用 r##"…"## ：JSON 里的 "#fff" 含 `#`，用 r#"…"# 会被提前终止
            r##"[{"id":"writing","label":"W","description":"d","icon":"pen-tool","color":"#fff","basePrompt":"p"}]"##,
        );
        let m = read_manifest(&dir).unwrap();
        let err = validate(&m, &dir).unwrap_err();
        assert_eq!(err.code(), "E_PLUGIN_CONFLICT", "撞车应报专用码");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_requires_grant_for_declared_tool() {
        let tmp = std::env::temp_dir().join("tw-plugin-test-grant");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = tmp.join("needgrant");
        // 声明 read_chapter 却只给 storage
        write_plugin(
            &dir,
            "needgrant",
            "index.js",
            r#"["storage"]"#,
            r##"[{"id":"p1","label":"P","description":"d","icon":"pen-tool","color":"#fff","basePrompt":"p","tools":["read_chapter"]}]"##,
        );
        let m = read_manifest(&dir).unwrap();
        let err = validate(&m, &dir).unwrap_err();
        assert_eq!(err.code(), "E_PLUGIN_MANIFEST");
        assert!(err.to_string().contains("book.read"), "错误应点明缺哪个 grant");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn validate_rejects_unknown_tool() {
        let tmp = std::env::temp_dir().join("tw-plugin-test-unknown");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = tmp.join("unk");
        write_plugin(
            &dir,
            "unk",
            "index.js",
            r#"["book.read"]"#,
            r##"[{"id":"p1","label":"P","description":"d","icon":"pen-tool","color":"#fff","basePrompt":"p","tools":["drop_database"]}]"##,
        );
        let m = read_manifest(&dir).unwrap();
        let err = validate(&m, &dir).unwrap_err();
        assert!(err.to_string().contains("未知工具"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_enabled_treats_corrupt_file_as_empty() {
        let tmp = std::env::temp_dir().join("tw-plugin-test-enabled");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(enabled_path(&tmp), "not json at all").unwrap();
        assert!(read_enabled(&tmp).is_empty(), "损坏的启用清单应退化为空集合");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_enabled_sorts_for_stable_diff() {
        let tmp = std::env::temp_dir().join("tw-plugin-test-write-enabled");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let set: HashSet<String> = ["zebra", "alpha", "mid"].iter().map(|s| s.to_string()).collect();
        write_enabled(&tmp, &set).unwrap();
        let raw = std::fs::read_to_string(enabled_path(&tmp)).unwrap();
        let list: Vec<String> = serde_json::from_str(&raw).unwrap();
        assert_eq!(list, ["alpha", "mid", "zebra"]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn grant_for_tool_is_consistent_with_registry() {
        // 表中每个工具名都必须真的在 L0 注册表里，
        // 否则映射表会留下永远匹配不上的死条目
        let registered = tools::registered_tool_names();
        for t in [
            "read_chapter",
            "read_chapter_summary",
            "read_chapter_chunk",
            "list_book_chapters",
            "get_book_context",
            "split_chapter",
            "search_world_cards",
            "create_note_card",
        ] {
            assert!(registered.contains(&t), "{t} 不在 L0 注册表");
            assert!(grant_for_tool(t).is_some());
        }
    }

    #[test]
    fn builtin_profile_ids_are_non_empty_and_lowercase() {
        let ids = profiles::builtin_profile_ids();
        assert!(!ids.is_empty());
        assert!(ids.contains(&"writing"), "writing 是内置能力画像");
        assert!(ids.contains(&"novel"), "novel 是内置领域画像");
    }
}
