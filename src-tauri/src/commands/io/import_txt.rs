//! TXT 文件导入（自动分章 · Spec §6）
//!
//! v2 行为（相对 v1 现状的差异，见 `docs/development/import-export-spec.md` §6）：
//! - 分章规则升级：行级标题匹配（中文「第X章」/ Chapter / 序章楔子等）+「后续 ≥ 1 非空行」正文误判防护 + 开篇引言不丢弃（独立「前言」章）；
//! - 段落折叠：连续空行不产生空 `<p>`，正文逐行 HTML 转义（防注入）；
//! - 去重：同书名同正文指纹 ⇒ 跳过；同名不同文 ⇒ 追加「（导入 N）」；
//! - 规模：≤ 20 MB / ≤ 2,000 章；空文件报 `E_TXT_NO_CHAPTERS`；
//! - 事务：全部分章写入 + `recalc_word_count` 单事务原子提交（v1 为逐条提交）。

use crate::commands::window::emit_sql_log;
use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{book_repo, chapter_repo};
use crate::utils::{escape_html, now};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use tauri::{AppHandle, State};

/// 文件大小上限（Spec §6.4）
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// 单文件章节数上限（Spec §6.4）
const MAX_CHAPTERS: usize = 2_000;

/// 第一章默认标题（全文无命中时的兜底章节名，现状行为保留）
const FALLBACK_TITLE: &str = "全文";
/// 开篇引言章的标题（v1 会丢/并入首章，v2 独立成章）
const PREFACE_TITLE: &str = "前言";

/// 解析出的原始章节（body 为已折叠空行的原始文本行）
#[derive(Debug, Clone)]
struct RawChapter {
    title: String,
    body: Vec<String>,
}

/// 是否章节标题候选行（Spec §6.1，行级匹配：中文数字章 / Chapter / 序章楔子尾声后记番外）
///
/// 只判「这一行本身像不像标题」；「后续必须有 ≥1 非空正文」的正文误判防护在流式解析器里完成。
fn is_heading_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    // 中文：第[零一二三四五六七八九十百千两\d]+[章节卷回篇]
    if let Some(rest) = t.strip_prefix('第') {
        let mut chars = rest.chars();
        let mut first_ok = false;
        while let Some(c) = chars.next() {
            if "零一二三四五六七八九十百千两".contains(c) || c.is_ascii_digit() {
                first_ok = true;
                continue;
            }
            return first_ok && "章节卷回篇".contains(c);
        }
        return false;
    }
    // Chapter（大小写不敏感，须后接空白 + 数字）
    if t.get(.."chapter".len())
        .map(|head| head.eq_ignore_ascii_case("chapter"))
        .unwrap_or(false)
    {
        let tail = t["chapter".len()..].trim_start();
        let mut digit = tail.chars();
        return matches!(digit.next(), Some(c) if c.is_ascii_digit());
    }
    // 序章 / 楔子 / 尾声 / 后记 / 番外（允许带副标题尾巴）
    ["序章", "楔子", "尾声", "后记", "番外"]
        .iter()
        .any(|kw| t.starts_with(kw))
}

/// 流式解析 TXT（按行，`BufReader::lines` 天然处理跨块 UTF-8），返回
/// `(chapters, 前言行, 是否出现过标题)`。
///
/// 规则（Spec §6.1 / §6.2）：
/// - 空行直接折叠丢弃（不产生空 `<p>`）；其余原样保留（含首行缩进，仅去掉行尾 \r）；
/// - 标题候选行需「后续存在 ≥ 1 个非空行」才确认为标题，否则按正文处理（防文中引用误判）；
/// - 连续标题之间无正文 ⇒ 不产生空章节；
/// - 第一个标题之前的引言单独累积为前言。
fn parse_txt_stream(
    lines: &mut dyn Iterator<Item = Result<String, std::io::Error>>,
) -> Result<(Vec<RawChapter>, Vec<String>, bool), AppError> {
    let mut chapters: Vec<RawChapter> = Vec::new();
    let mut preface: Vec<String> = Vec::new();
    let mut heading_seen = false;
    // 待确认的标题（需看到其后的第一个非空行才能确认）
    let mut pending: Option<String> = None;
    // 当前正在累积正文的章节
    let mut open: Option<RawChapter> = None;

    while let Some(line) = lines.next() {
        let line =
            line.map_err(|e| AppError::Business(format!("E_TXT_READ：读取 TXT 失败：{e}")))?;
        let line = line.trim_end_matches('\r').to_string();
        if line.trim().is_empty() {
            continue; // 空行折叠
        }

        if let Some(cand) = pending.take() {
            if is_heading_line(&line) {
                // 连续标题：前面的标题无正文，丢弃不产生空章；链式保留当前
                pending = Some(line.trim().to_string());
                continue;
            }
            // 确认标题成立：开启新章，并把当前行作为其第一行正文
            if let Some(cur) = open.take() {
                if !cur.body.is_empty() {
                    chapters.push(cur);
                }
            }
            open = Some(RawChapter {
                title: cand,
                body: Vec::new(),
            });
            if let Some(cur) = open.as_mut() {
                cur.body.push(line);
            }
            continue;
        }

        if is_heading_line(&line) {
            pending = Some(line.trim().to_string());
            heading_seen = true;
            continue;
        }

        // 普通正文
        if let Some(cur) = open.as_mut() {
            cur.body.push(line);
        } else {
            preface.push(line); // 开篇引言（第一个标题之前）
        }
    }

    if let Some(cur) = open.take() {
        if !cur.body.is_empty() {
            chapters.push(cur);
        }
    }
    // 文件结尾的孤立标题无正文 ⇒ 丢弃（不产生空章节）
    Ok((chapters, preface, heading_seen))
}

/// 将原始文本行渲染为 HTML（Spec §6.2）：逐行转义后包 `<p>`，空行已在解析期折叠
fn render_html(body: &[String]) -> String {
    body.iter()
        .map(|line| format!("<p>{}</p>", escape_html(line)))
        .collect()
}

/// 归一化指纹（Spec §6.3）：去掉全部空白字符（HTML 两侧均经同一转义渲染，格式一致可比较）
fn fingerprint(html: &str) -> String {
    html.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 待写入章节（已定稿标题 + 渲染 HTML + 字数）
#[derive(Debug)]
struct ChapterToWrite {
    title: String,
    html: String,
    word_count: i64,
}

/// 去重规划（Spec §6.3）：对解析出的每章对照库内已有章节决定 跳过 / 重命名 / 原样写入。
///
/// 返回 (待写章节（跳过的不含在内）, skipped, renamed)。
/// - 同书名 + 同正文指纹 ⇒ skipped；
/// - 书名已存在但正文不同 ⇒ 追加「标题（导入 N）」并 renamed++；
/// - 书名不存在 ⇒ 原样写入。
fn plan_import(
    parsed: &[RawChapter],
    existing_titles: &[String],
    existing_fps: &HashMap<String, Vec<String>>,
) -> (Vec<ChapterToWrite>, usize, usize) {
    // 已占用书名（库内已有 + 本次已排期）
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

        // 同名冲突（库内已有同名 或 本次已排期同名）⇒ 重命名追加
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

/// 导入 TXT 文件（正则自动分章）
#[tauri::command]
pub async fn import_txt(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    let _guard = super::try_acquire_io_lock()?;
    // 规模上限：先看文件大小，超限直接拒绝（避免读入内存）
    let meta = std::fs::metadata(&file_path)
        .map_err(|e| AppError::Business(format!("E_TXT_READ：读取文件信息失败：{}", e)))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::Business(format!(
            "E_TXT_TOO_LARGE：TXT 文件超过 {} MB 上限，请拆分后分批导入",
            MAX_FILE_BYTES / 1024 / 1024
        )));
    }

    // 流式解析（> 2 MB 也仅按行读取，不一次性整文件进内存）
    let file = File::open(&file_path)
        .map_err(|e| AppError::Business(format!("E_TXT_READ：打开文件失败：{}", e)))?;
    let mut lines_iter = BufReader::new(file).lines();
    let (mut chapters, mut preface, heading_seen) = parse_txt_stream(&mut lines_iter)?;

    // 空文件
    if chapters.is_empty() && preface.is_empty() && !heading_seen {
        return Err(AppError::Business(format!(
            "E_TXT_NO_CHAPTERS：未识别出任何章节内容（文件为空）"
        )));
    }

    // 无任何标题命中 ⇒ 整文件作为单章「全文」导入（现状行为保留）
    if chapters.is_empty() && preface.is_empty() && heading_seen {
        // 全为无正文的标题行：退化为整文件单章
        let raw = std::fs::read_to_string(&file_path)
            .map_err(|e| AppError::Business(format!("E_TXT_READ：读取文件失败：{}", e)))?;
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let body: Vec<String> = trimmed
                .lines()
                .map(|l| l.trim_end_matches('\r').to_string())
                .filter(|l| !l.trim().is_empty())
                .collect();
            chapters.push(RawChapter {
                title: FALLBACK_TITLE.to_string(),
                body,
            });
        }
    }
    if chapters.is_empty() && !preface.is_empty() {
        // 只有引言无标题 → 同样兜底为单章「全文」
        let body = std::mem::take(&mut preface);
        chapters.push(RawChapter {
            title: FALLBACK_TITLE.to_string(),
            body,
        });
    }
    // 前言（首个标题前的引言）前置为独立章（Spec §6.1）
    if !preface.is_empty() {
        let preface_body = std::mem::take(&mut preface);
        chapters.insert(
            0,
            RawChapter {
                title: PREFACE_TITLE.to_string(),
                body: preface_body,
            },
        );
    }

    // 章节数上限（解析后判定，Spec §6.4）
    if chapters.len() > MAX_CHAPTERS {
        return Err(AppError::Business(format!(
            "E_TXT_TOO_LARGE：TXT 文件超过 {} 章上限，请拆分后分批导入",
            MAX_CHAPTERS
        )));
    }

    let mut conn = db.pool.get()?;

    emit_sql_log(
        &app,
        "SELECT",
        "chapters",
        &format!("import_txt dedupe precheck book_id={}", book_id),
        file!(),
        line!(),
    );
    // 库内已有章节（标题 + HTML），用于去重比对
    let existing = chapter_repo::list_titles_and_content(&conn, &book_id)?;
    let existing_titles: Vec<String> = existing.iter().map(|(t, _)| t.clone()).collect();
    let mut existing_fps: HashMap<String, Vec<String>> = HashMap::new();
    for (t, html) in &existing {
        existing_fps
            .entry(t.clone())
            .or_default()
            .push(fingerprint(html));
    }

    let (to_write, skipped, renamed) = plan_import(&chapters, &existing_titles, &existing_fps);

    // 单事务写入：全部分章 + recalc_word_count 原子提交（Spec §6.4，G5）
    let tx = conn
        .transaction()
        .map_err(|e| AppError::Business(format!("E_TXT_TXN：开始 TXT 导入事务失败: {}", e)))?;
    {
        emit_sql_log(
            &app,
            "INSERT",
            "chapters",
            &format!(
                "import_txt, {} new (skip {}, rename {}) for book_id={}",
                to_write.len(),
                skipped,
                renamed,
                book_id
            ),
            file!(),
            line!(),
        );
        // 续接现有最大 sort_order，避免与已有章节排序冲突
        let mut next_order: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chapters WHERE book_id = ?1",
                [&book_id],
                |r| r.get(0),
            )
            .map_err(|e| AppError::Business(format!("E_TXT_QUERY：查询章节排序失败: {}", e)))?;
        for ch in &to_write {
            let id = uuid::Uuid::new_v4().to_string();
            let ts = now();
            chapter_repo::insert_with_content(
                &tx,
                &id,
                &book_id,
                &ch.title,
                &ch.html,
                ch.word_count,
                next_order,
                &ts,
            )?;
            next_order += 1;
        }
        emit_sql_log(
            &app,
            "UPDATE",
            "books",
            &format!("recalc word_count for book_id={}", book_id),
            file!(),
            line!(),
        );
        book_repo::recalc_word_count(&tx, &book_id, &now())?;
    }
    tx.commit()
        .map_err(|e| AppError::Business(format!("E_TXT_COMMIT：TXT 导入提交失败: {}", e)))?;

    Ok(serde_json::json!({
        "chaptersCreated": to_write.len(),
        "chaptersSkipped": skipped,
        "chaptersRenamed": renamed,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 将字符串（\n 分隔）喂给流式解析器
    fn parse_text(content: &str) -> (Vec<RawChapter>, Vec<String>, bool) {
        let mut lines = content
            .lines()
            .map(|s| Ok::<String, std::io::Error>(s.to_string()));
        parse_txt_stream(&mut lines).expect("parse ok")
    }

    #[test]
    fn heading_lines_detected() {
        assert!(is_heading_line("第一章"));
        assert!(is_heading_line("  第一章  命运的齿轮"));
        assert!(is_heading_line("　第2章"));
        assert!(is_heading_line("第一百二十三回 风云再起"));
        assert!(is_heading_line("第十章·尾声将至")); // 数字后可带任意尾巴
        assert!(is_heading_line("Chapter 3 The Return"));
        assert!(is_heading_line("chapter 10 尾声"));
        assert!(is_heading_line("序章"));
        assert!(is_heading_line("楔子"));
        assert!(is_heading_line("尾声（下）"));
        assert!(is_heading_line("番外·夏日祭"));
    }

    #[test]
    fn heading_lines_reject_false_positives() {
        assert!(!is_heading_line("他说：第一章来了。"));
        assert!(!is_heading_line("以上就是第一章的内容"));
        assert!(!is_heading_line("Chapter 里有字"));
        assert!(!is_heading_line("第章")); // 缺数字
    }

    #[test]
    fn parse_folds_blank_lines_and_drops_empty_chapters() {
        let (chapters, preface, _) =
            parse_text("第一章 正文\n内容A\n\n\n内容B\n\n第二章 尾\n没了\n");
        assert!(preface.is_empty());
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title, "第一章 正文");
        // 空行折叠：body 不含空行
        assert_eq!(chapters[0].body, vec!["内容A", "内容B"]);
        assert_eq!(chapters[1].body, vec!["没了"]);
    }

    #[test]
    fn preface_is_kept_and_ordered_first() {
        let (chapters, preface, _) =
            parse_text("开篇的一段引言。\n第二行引言。\n\n第一章 正文\n正文内容\n");
        assert_eq!(preface, vec!["开篇的一段引言。", "第二行引言。"]);
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, "第一章 正文");
    }

    #[test]
    fn trailing_heading_without_body_is_text() {
        // 结尾孤立标题行（后无正文）不应作为新章标题，也不产生空章
        let (chapters, _, _) = parse_text("第一章 有内容\n内容\n（后记 无正文）\n");
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, "第一章 有内容");
        assert_eq!(chapters[0].body, vec!["内容", "（后记 无正文）"]);
    }

    #[test]
    fn consecutive_headings_do_not_create_empty_chapters() {
        let (chapters, _, _) = parse_text("第一章\n第二章 真章\n内容\n");
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, "第二章 真章");
        assert_eq!(chapters[0].body, vec!["内容"]);
    }

    #[test]
    fn mid_text_chapter_mention_is_not_split() {
        // 正文引用「第一章」不单独成行 → 不是标题行，整段保留
        let (chapters, _, _) = parse_text("全文只有一段，提到第一章的事。\n第二章尚未开始。\n");
        assert_eq!(chapters.len(), 0); // 无标题 → 交由调用方兜底单章
    }

    #[test]
    fn plan_import_dedupes_rename_and_counts() {
        // 库内已有：与“第一章 A”同名同内容
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
        assert_eq!(writes[1].word_count, 2); // “全新”
        assert_eq!(writes[0].word_count, 3); // “新内容”
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
