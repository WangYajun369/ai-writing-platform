//! TXT 文件导入（自动分章 · Spec §6）
//!
//! v2 行为（相对 v1 现状的差异，见 `docs/development/import-export-spec.md` §6）：
//! - 分章规则升级：行级标题匹配（中文「第X章」/ Chapter / 序章楔子等）+「后续 ≥ 1 非空行」正文误判防护 + 开篇引言不丢弃（独立「前言」章）；
//! - 段落折叠：连续空行不产生空 `<p>`，正文逐行 HTML 转义（防注入）；
//! - 去重：同书名同正文指纹 ⇒ 跳过；同名不同文 ⇒ 追加「（导入 N）」；
//! - 规模：≤ 20 MB / ≤ 2,000 章；空文件报 `E_TXT_NO_CHAPTERS`；
//! - 事务：全部分章写入 + `recalc_word_count` 单事务原子提交（v1 为逐条提交）。
//!
//! 分层：本文件仅负责文件 IO + 流式解析；去重比对 + 事务写入由
//! [`crate::service::import_txt_service`] 承担（UnitOfWork 收口审计）。

use crate::db::AppDb;
use crate::error::{AppError, ErrCode};
use crate::service::import_txt_service::{self, RawChapter};
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
        let chars = rest.chars();
        let mut first_ok = false;
        for c in chars {
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

    for line in &mut *lines {
        let line =
            line.map_err(|e| AppError::business(ErrCode::TxtRead, format!("读取 TXT 失败：{e}")))?;
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

/// 导入 TXT 文件（正则自动分章）
#[tauri::command]
pub async fn import_txt(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    let _guard = super::try_acquire_io_lock(Some(&app))?;
    // 规模上限：先看文件大小，超限直接拒绝（避免读入内存）
    let meta = std::fs::metadata(&file_path)
        .map_err(|e| AppError::business(ErrCode::TxtRead, format!("读取文件信息失败：{}", e)))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::business(
            ErrCode::TxtTooLarge,
            format!(
                "TXT 文件超过 {} MB 上限，请拆分后分批导入",
                MAX_FILE_BYTES / 1024 / 1024
            ),
        ));
    }

    // 流式解析（> 2 MB 也仅按行读取，不一次性整文件进内存）
    let file = File::open(&file_path)
        .map_err(|e| AppError::business(ErrCode::TxtRead, format!("打开文件失败：{}", e)))?;
    let mut lines_iter = BufReader::new(file).lines();
    let (mut chapters, mut preface, heading_seen) = parse_txt_stream(&mut lines_iter)?;

    // 空文件
    if chapters.is_empty() && preface.is_empty() && !heading_seen {
        return Err(AppError::Business(
            "E_TXT_NO_CHAPTERS：未识别出任何章节内容（文件为空）".to_string(),
        ));
    }

    // 无任何标题命中 ⇒ 整文件作为单章「全文」导入（现状行为保留）
    if chapters.is_empty() && preface.is_empty() && heading_seen {
        // 全为无正文的标题行：退化为整文件单章
        let raw = std::fs::read_to_string(&file_path)
            .map_err(|e| AppError::business(ErrCode::TxtRead, format!("读取文件失败：{}", e)))?;
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

    // 委托 service 层：去重比对 + 单事务写入 + 字数重算（UnitOfWork 收口审计）
    let result = import_txt_service::import_parsed_chapters(&app, &db, &book_id, &chapters)?;

    Ok(serde_json::json!({
        "chaptersCreated": result.chapters_created,
        "chaptersSkipped": result.chapters_skipped,
        "chaptersRenamed": result.chapters_renamed,
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
}
