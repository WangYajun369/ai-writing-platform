//! TXT 导入服务
//!
//! commands 层负责文件 IO 与流式解析（产出 `RawChapter` 列表），
//! 本服务负责去重比对 + 单事务写入 + 字数重算，通过 UnitOfWork 收口审计。

use crate::db::AppDb;
use crate::error::{AppError, ErrCode};
use crate::repository::{book_repo, chapter_repo};
use crate::service::uow::UnitOfWork;
use crate::utils::{escape_html, now};
use serde::Serialize;
use std::collections::HashMap;
use tauri::AppHandle;

/// 解析出的原始章节（body 为已折叠空行的原始文本行）
#[derive(Debug, Clone)]
pub struct RawChapter {
    pub title: String,
    pub body: Vec<String>,
}

/// 待写入章节（已定稿标题 + 渲染 HTML + 字数）
#[derive(Debug)]
struct ChapterToWrite {
    title: String,
    html: String,
    word_count: i64,
}

/// TXT 导入结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub chapters_created: usize,
    pub chapters_skipped: usize,
    pub chapters_renamed: usize,
}

/// 将原始文本行渲染为 HTML：逐行转义后包 `<p>`，空行已在解析期折叠
fn render_html(body: &[String]) -> String {
    body.iter()
        .map(|line| format!("<p>{}</p>", escape_html(line)))
        .collect()
}

/// 归一化指纹：去掉全部空白字符
fn fingerprint(html: &str) -> String {
    html.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 去重规划：对解析出的每章对照库内已有章节决定 跳过 / 重命名 / 原样写入。
///
/// 返回 (待写章节（跳过的不含在内）, skipped, renamed)。
fn plan_import(
    parsed: &[RawChapter],
    existing_titles: &[String],
    existing_fps: &HashMap<String, Vec<String>>,
) -> (Vec<ChapterToWrite>, usize, usize) {
    let mut used: Vec<String> = existing_titles.to_vec();
    let mut to_write: Vec<ChapterToWrite> = Vec::new();
    let mut skipped = 0usize;
    let mut renamed = 0usize;

    for ch in parsed {
        let html = render_html(&ch.body);
        let fp = fingerprint(&html);
        let wc = ch
            .body
            .iter()
            .flat_map(|l| l.chars())
            .filter(|c| !c.is_whitespace())
            .count() as i64;

        // 全文一致 ⇒ 跳过
        if existing_fps
            .get(&ch.title)
            .map(|fps| fps.iter().any(|f| f == &fp))
            .unwrap_or(false)
        {
            skipped += 1;
            continue;
        }

        // 同名冲突 ⇒ 重命名追加
        let mut final_title = ch.title.clone();
        if used.iter().any(|t| t == &final_title) {
            let mut n = 2;
            loop {
                let candidate = format!("{}（导入 {}）", ch.title, n);
                if !used.iter().any(|t| t == &candidate) {
                    final_title = candidate;
                    break;
                }
                n += 1;
            }
            renamed += 1;
        }
        used.push(final_title.clone());
        to_write.push(ChapterToWrite {
            title: final_title,
            html,
            word_count: wc,
        });
    }
    (to_write, skipped, renamed)
}

/// 将解析后的章节写入数据库（去重 + 单事务 + 字数重算）。
///
/// 事务边界：dedupe 预查（autocommit）→ begin_transaction → 批量 INSERT +
/// recalc_word_count → commit。审计日志通过 UnitOfWork 统一收口，失败自动丢弃。
pub fn import_parsed_chapters(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
    chapters: &[RawChapter],
) -> Result<ImportResult, AppError> {
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));

    // dedupe 预查（autocommit，读已提交数据）
    uow.audit(
        "SELECT",
        "chapters",
        format!("import_txt dedupe precheck book_id={}", book_id),
        file!(),
        line!(),
    );
    let existing = chapter_repo::list_titles_and_content(uow.conn(), book_id)?;
    let existing_titles: Vec<String> = existing.iter().map(|(t, _)| t.clone()).collect();
    let mut existing_fps: HashMap<String, Vec<String>> = HashMap::new();
    for (t, html) in &existing {
        existing_fps
            .entry(t.clone())
            .or_default()
            .push(fingerprint(html));
    }

    let (to_write, skipped, renamed) = plan_import(chapters, &existing_titles, &existing_fps);

    // 单事务写入：全部分章 + recalc_word_count 原子提交
    uow.begin_transaction().map_err(|e| {
        AppError::business(ErrCode::TxtTxn, format!("开始 TXT 导入事务失败: {}", e))
    })?;

    uow.audit(
        "INSERT",
        "chapters",
        format!(
            "import_txt, {} new (skip {}, rename {}) for book_id={}",
            to_write.len(),
            skipped,
            renamed,
            book_id
        ),
        file!(),
        line!(),
    );
    let start_order = chapter_repo::next_sort_order_in_book(uow.conn(), book_id)
        .map_err(|e| AppError::business(ErrCode::TxtQuery, format!("查询章节排序失败: {}", e)))?;
    for (i, ch) in to_write.iter().enumerate() {
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now();
        chapter_repo::insert_with_content(
            uow.conn(),
            &id,
            book_id,
            &ch.title,
            &ch.html,
            ch.word_count,
            start_order + i as i64,
            &ts,
        )?;
    }

    uow.audit(
        "UPDATE",
        "books",
        format!("recalc word_count for book_id={}", book_id),
        file!(),
        line!(),
    );
    book_repo::recalc_word_count(uow.conn(), book_id, &now())?;

    uow.commit()
        .map_err(|e| AppError::business(ErrCode::TxtCommit, format!("TXT 导入提交失败: {}", e)))?;

    Ok(ImportResult {
        chapters_created: to_write.len(),
        chapters_skipped: skipped,
        chapters_renamed: renamed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_import_dedupes_rename_and_counts() {
        // 库内已有：与"第一章 A"同名同内容
        let existing = vec![
            (
                "第一章 A".to_string(),
                render_html(&["已经导入".to_string()]),
            ),
            (
                "第二章 已有".to_string(),
                render_html(&["老版本".to_string()]),
            ),
        ];
        let titles: Vec<String> = existing.iter().map(|(t, _)| t.clone()).collect();
        let mut fps: HashMap<String, Vec<String>> = HashMap::new();
        for (t, h) in &existing {
            fps.entry(t.clone()).or_default().push(fingerprint(h));
        }

        let parsed = vec![
            RawChapter {
                title: "第一章 A".into(),
                body: vec!["已经导入".into()],
            }, // 全文一致 → skip
            RawChapter {
                title: "第一章 A".into(),
                body: vec!["新内容".into()],
            }, // 同名不同文 → rename（导入 2）
            RawChapter {
                title: "第二章 已有".into(),
                body: vec!["老版本".into()],
            }, // skip
            RawChapter {
                title: "第三章 新".into(),
                body: vec!["全新".into()],
            }, // insert
            RawChapter {
                title: "第一章 A".into(),
                body: vec!["再一个版本".into()],
            }, // 同名 → rename（导入 3）
        ];

        let (writes, skipped, renamed) = plan_import(&parsed, &titles, &fps);
        assert_eq!(skipped, 2);
        assert_eq!(renamed, 2);
        assert_eq!(writes.len(), 3);
        let got: Vec<&str> = writes.iter().map(|w| w.title.as_str()).collect();
        assert_eq!(
            got,
            vec!["第一章 A（导入 2）", "第三章 新", "第一章 A（导入 3）"]
        );
        // 字数 = 非空白字符数
        assert_eq!(writes[1].word_count, 2); // "全新"
        assert_eq!(writes[0].word_count, 3); // "新内容"
    }

    #[test]
    fn render_escapes_and_folds() {
        let html = render_html(&["<b>加粗</b> & 文本".to_string(), "A&B".to_string()]);
        assert_eq!(
            html,
            "<p>&lt;b&gt;加粗&lt;/b&gt; &amp; 文本</p><p>A&amp;B</p>"
        );
        assert_eq!(
            fingerprint(&html),
            "<p>&lt;b&gt;加粗&lt;/b&gt;&amp;文本</p><p>A&amp;B</p>"
        );
    }
}
