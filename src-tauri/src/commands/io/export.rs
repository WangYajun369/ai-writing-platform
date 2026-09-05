//! 基本格式导出（TXT / MD / HTML）
//!
//! 将书籍所有章节以指定格式导出为单一文件。
//! Spec §7 增强：卷结构表达（TXT/MD 卷标题行）、导出进度事件（`export-progress`）、
//! 可取消（`cancel_book_export`）、临时文件 + rename 原子写出（不产生半成品文件）。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{book_repo, chapter_repo};
use crate::utils::{escape_html, strip_html};
use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

/// 进度事件发射节流（每 N 章上报一次）
const PROGRESS_EVERY: usize = 25;

// ─── 导出取消令牌（进程级单飞：前端已有 isExporting 防重，命令级互斥在 Phase F 收口） ───

static EXPORT_CANCEL: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

fn export_cancel_flag() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    EXPORT_CANCEL.get_or_init(|| Mutex::new(None))
}

/// 导出开始：重置取消标记
fn reset_export_cancel() {
    *export_cancel_flag().lock().unwrap() = Some(Arc::new(AtomicBool::new(false)));
}

/// 是否收到取消请求
fn export_cancel_requested() -> bool {
    export_cancel_flag()
        .lock()
        .unwrap()
        .as_ref()
        .map(|f| f.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// 取消当前格式导出（幂等：无导出在跑时无副作用）
#[tauri::command]
pub async fn cancel_book_export() -> Result<(), AppError> {
    if let Some(flag) = export_cancel_flag().lock().unwrap().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 进度事件载荷（前端经 `export-progress` 监听）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgressEvent {
    book_id: String,
    format: String,
    phase: &'static str,
    done: usize,
    total: usize,
}

/// 导出书籍（TXT / MD / HTML）
#[tauri::command]
pub async fn export_book(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    format: String,
    output_path: String,
) -> Result<(), AppError> {
    let _guard = super::try_acquire_io_lock()?;
    let conn = db.pool.get()?;

    emit_sql_log(
        &app,
        "SELECT",
        "books",
        &format!("id={}, export info", book_id),
        file!(),
        line!(),
    );
    let (title, author) = book_repo::find_title_author(&conn, &book_id)?;

    emit_sql_log(
        &app,
        "SELECT",
        "chapters",
        &format!("book_id={}, export chapters (with volume)", book_id),
        file!(),
        line!(),
    );
    let rows = chapter_repo::list_export_with_volume(&conn, &book_id)?;

    if format != "txt" && format != "md" && format != "html" {
        return Err(AppError::Business(format!(
            "E_EXPORT_FORMAT：不支持的导出格式：{}",
            format
        )));
    }

    reset_export_cancel();
    let tmp_path = format!("{}.tmp", output_path);
    let total = rows.len();

    // 写出到临时文件；成功后 rename 原子替换（Spec §8.2 精神，避免半成品）
    let file = File::create(&tmp_path)
        .map_err(|e| AppError::Business(format!("E_EXPORT_WRITE：创建临时文件失败: {}", e)))?;
    let mut w = std::io::BufWriter::new(file);

    let (header, tail) = document_frame(&format, &title, &author);
    let write_res: Result<(), AppError> = (|| {
        w.write_all(header.as_bytes())
            .map_err(|e| AppError::Business(format!("E_EXPORT_WRITE：写入导出文件失败: {}", e)))?;

        let mut last_volume: Option<String> = None;
        let mut done = 0usize;
        for row in &rows {
            if export_cancel_requested() {
                return Err(AppError::Business(
                    "E_EXPORT_CANCELED：导出已取消，未生成文件".into(),
                ));
            }
            // 卷标题行（Spec §7：TXT/MD/HTML 卷结构表达）
            if row.volume_title != last_volume {
                let vh = volume_heading(&format, row.volume_title.as_deref());
                w.write_all(vh.as_bytes()).map_err(|e| {
                    AppError::Business(format!("E_EXPORT_WRITE：写入导出文件失败: {}", e))
                })?;
                last_volume = row.volume_title.clone();
            }
            let block = chapter_block(&format, &row.title, &row.html);
            w.write_all(block.as_bytes()).map_err(|e| {
                AppError::Business(format!("E_EXPORT_WRITE：写入导出文件失败: {}", e))
            })?;

            done += 1;
            if done % PROGRESS_EVERY == 0 || done == total {
                let _ = app.emit(
                    "export-progress",
                    ExportProgressEvent {
                        book_id: book_id.clone(),
                        format: format.clone(),
                        phase: "building",
                        done,
                        total,
                    },
                );
            }
        }

        w.write_all(tail.as_bytes())
            .map_err(|e| AppError::Business(format!("E_EXPORT_WRITE：写入导出文件失败: {}", e)))?;
        w.flush()
            .map_err(|e| AppError::Business(format!("E_EXPORT_WRITE：写入导出文件失败: {}", e)))?;
        Ok(())
    })();

    if let Err(e) = write_res {
        // 取消/出错：清理临时文件，不产生半成品
        drop(w);
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    drop(w);

    std::fs::rename(&tmp_path, &output_path).map_err(|e| {
        AppError::Business(format!("E_EXPORT_WRITE：移动临时文件到目标路径失败: {}", e))
    })?;

    Ok(())
}

/// 文档头尾框架（按格式返回 (header, tail)）
fn document_frame(format: &str, title: &str, author: &str) -> (String, String) {
    match format {
        "txt" => (format!("{}\n作者：{}\n", title, author), String::new()),
        "md" => (format!("# {}\n> 作者：{}\n", title, author), String::new()),
        "html" => (
            format!(
                r#"<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>{}</title>
<style>body{{max-width:800px;margin:40px auto;font-family:serif;line-height:2;}}h1,h2,h3{{font-weight:bold;}}</style>
</head>
<body>
<h1>{}</h1><p>作者：{}</p>
"#,
                title, title, author
            ),
            "\n</body>\n</html>\n".to_string(),
        ),
        _ => (String::new(), String::new()),
    }
}

/// 卷标题行（每卷仅在章节进入该卷时输出一次）
fn volume_heading(format: &str, volume_title: Option<&str>) -> String {
    let Some(vt) = volume_title.filter(|v| !v.is_empty()) else {
        return String::new();
    };
    match format {
        "txt" => format!("\n\n==== {} ====\n", vt),
        "md" => format!("\n# {}\n", vt),
        "html" => format!("<h3>{}</h3>\n", escape_html(vt)),
        _ => String::new(),
    }
}

/// 单章内容块
fn chapter_block(format: &str, title: &str, html: &str) -> String {
    match format {
        "txt" => format!("\n\n{}\n\n{}", title, strip_html(html)),
        "md" => format!("\n## {}\n\n{}", title, strip_html(html)),
        "html" => format!("<h2>{}</h2>\n{}", title, html),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(items: &[(&str, &str, &str)]) -> Vec<chapter_repo::ChapterExportRow> {
        items
            .iter()
            .map(|(v, t, h)| chapter_repo::ChapterExportRow {
                volume_title: if v.is_empty() {
                    None
                } else {
                    Some(v.to_string())
                },
                title: t.to_string(),
                html: h.to_string(),
            })
            .collect()
    }

    /// 组装 txt 正文（框架 + 卷 + 章），供断言卷结构出现
    fn compose_txt(rows: &[chapter_repo::ChapterExportRow]) -> String {
        let (header, _tail) = document_frame("txt", "书", "作者");
        let mut out = header;
        let mut last: Option<String> = None;
        for r in rows {
            if r.volume_title != last {
                out.push_str(&volume_heading("txt", r.volume_title.as_deref()));
                last = r.volume_title.clone();
            }
            out.push_str(&chapter_block("txt", &r.title, &r.html));
        }
        out
    }

    #[test]
    fn volume_headings_txt_md_html() {
        assert_eq!(
            volume_heading("txt", Some("第一卷 春")),
            "\n\n==== 第一卷 春 ====\n"
        );
        assert_eq!(volume_heading("md", Some("第一卷 春")), "\n# 第一卷 春\n");
        assert_eq!(
            volume_heading("html", Some("卷 <A>")),
            "<h3>卷 &lt;A&gt;</h3>\n",
            "HTML 卷标题需转义"
        );
        assert_eq!(volume_heading("txt", None), "");
        assert_eq!(volume_heading("txt", Some("")), "");
    }

    #[test]
    fn txt_export_interleaves_volume_titles_once() {
        let items = rows(&[
            ("", "开篇", "<p>楔子内容</p>"),
            ("第一卷", "第一章", "<p>正文一</p>"),
            ("第一卷", "第二章", "<p>正文二</p>"),
            ("第二卷", "第三章", "<p>正文三</p>"),
        ]);
        let txt = compose_txt(&items);
        assert!(txt.starts_with("书\n作者：作者\n"));
        // 卷标题只在切换时出现一次
        assert_eq!(txt.matches("==== 第一卷 ====").count(), 1);
        assert_eq!(txt.matches("==== 第二卷 ====").count(), 1);
        // 正文去 HTML 标签
        assert!(txt.contains("\n\n第一章\n\n正文一"), "{txt}");
        assert!(txt.contains("正文二") && txt.contains("正文三"));
        // 无卷章节在前（无卷标题行）
        assert!(!txt.contains("==== 开篇 ===="));
        // 顺序：无卷开篇 → 第一卷 → 第二卷
        let i_vol1 = txt.find("==== 第一卷").unwrap();
        let i_vol2 = txt.find("==== 第二卷").unwrap();
        let i_ch1 = txt.find("第一章").unwrap();
        let i_ch3 = txt.find("第三章").unwrap();
        assert!(i_ch1 > i_vol1 && i_ch1 < i_vol2 && i_ch3 > i_vol2);
    }

    #[test]
    fn document_frames_are_utf8_without_bom() {
        let (txt_h, _) = document_frame("txt", "书名", "作者A");
        assert_eq!(txt_h, "书名\n作者：作者A\n");
        assert!(!txt_h.starts_with('\u{feff}'));
        let (md_h, _) = document_frame("md", "书名", "作者A");
        assert_eq!(md_h, "# 书名\n> 作者：作者A\n");
        let (html_h, html_t) = document_frame("html", "书名", "作者A");
        assert!(html_h.starts_with("<!DOCTYPE html>"));
        assert!(html_h.contains("<h1>书名</h1>"));
        assert!(html_t.trim().ends_with("</html>"));
    }

    #[test]
    fn cancel_flag_lifecycle() {
        reset_export_cancel();
        assert!(!export_cancel_requested());
        if let Some(flag) = export_cancel_flag().lock().unwrap().as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
        assert!(export_cancel_requested());
        reset_export_cancel();
        assert!(!export_cancel_requested());
    }
}
