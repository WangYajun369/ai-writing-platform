//! 日记业务服务
//!
//! 封装日记的完整业务逻辑：按月查询、按日获取、保存（新建/覆盖）、删除。
//!
//! ## 设计约定
//!
//! - 每篇日记以 `diary_date`（YYYY-MM-DD）为唯一键，同一天仅保留一篇
//! - 日期格式在前端统一生成，后端做轻量格式校验，避免脏数据入库
//! - 列表查询返回摘要（不含正文），编辑时再按日期加载全文

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{Diary, DiaryMeta, DiarySearchHit, DiaryStats, DiaryMonthStat};
use crate::repository::diary_repo;
use crate::service::uow::UnitOfWork;
use crate::utils::{escape_fts5_query, like_pattern, now, snippet, strip_html, validate_len, MAX_CHAPTER_CONTENT_LEN};
use chrono::Datelike;
use tauri::AppHandle;
use uuid::Uuid;

/// 关键字数量上限
const MAX_KEYWORDS_COUNT: usize = 10;
/// 单个关键字长度上限
const MAX_KEYWORD_LEN: usize = 20;

/// 轻量校验 YYYY-MM-DD 格式
fn is_valid_date(date: &str) -> bool {
    // 仅做字符结构校验，不校验真实日历（如 02-30）；非法日历日期由前端日期控件规避
    let bytes = date.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && (0..10).all(|i| i == 4 || i == 7 || bytes[i].is_ascii_digit())
}

/// 计算某月的查询边界：[月初, 下月初)
fn month_range(year: i64, month: i64) -> (String, String) {
    let start = format!("{year:04}-{month:02}-01");
    let end = if month >= 12 {
        format!("{:04}-01-01", year + 1)
    } else {
        format!("{:04}-{:02}-01", year, month + 1)
    };
    (start, end)
}

/// 列出某年某月的日记摘要（不含正文），按日期升序
pub fn list_month(
    app: &AppHandle,
    db: &AppDb,
    year: i64,
    month: i64,
) -> Result<Vec<DiaryMeta>, AppError> {
    if !(1..=12).contains(&month) {
        return Err(AppError::Validation(format!("月份不合法: {month}")));
    }
    let (start, end) = month_range(year, month);
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "diaries",
        format!("{start} <= diary_date < {end}"),
        file!(),
        line!(),
    );
    let diaries = diary_repo::list_in_range(uow.conn(), &start, &end)?;
    uow.commit()?;
    Ok(diaries)
}

/// 列出全部日记摘要（不含正文），按日期升序（书页式「看日记」浏览用）
pub fn list_all(app: &AppHandle, db: &AppDb) -> Result<Vec<DiaryMeta>, AppError> {
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit("SELECT", "diaries", "全部日记摘要", file!(), line!());
    let diaries = diary_repo::list_all(uow.conn())?;
    uow.commit()?;
    Ok(diaries)
}

/// 按日期获取日记全文，不存在时返回 None
pub fn get_by_date(app: &AppHandle, db: &AppDb, date: &str) -> Result<Option<Diary>, AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!(
            "日期格式不合法: {date}（应为 YYYY-MM-DD）"
        )));
    }
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "SELECT",
        "diaries",
        format!("diary_date={date}, content_html"),
        file!(),
        line!(),
    );
    let diary = diary_repo::find_by_date(uow.conn(), date)?;
    uow.commit()?;
    Ok(diary)
}

/// 保存日记内容：该日期已有日记则覆盖（保留创建时间），否则新建
pub fn save_diary(
    app: &AppHandle,
    db: &AppDb,
    date: &str,
    content_html: &str,
    word_count: i64,
    keywords: &[String],
) -> Result<Diary, AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!(
            "日期格式不合法: {date}（应为 YYYY-MM-DD）"
        )));
    }
    validate_len("日记内容", content_html, MAX_CHAPTER_CONTENT_LEN)?;
    if keywords.len() > MAX_KEYWORDS_COUNT {
        return Err(AppError::Validation(format!(
            "关键字数量超过上限（{} > {}）",
            keywords.len(),
            MAX_KEYWORDS_COUNT
        )));
    }
    for kw in keywords {
        validate_len("关键字", kw, MAX_KEYWORD_LEN)?;
    }

    let ts = now();
    let keywords_json = serde_json::to_string(keywords)?;
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;

    // 已存在时沿用原 id 与 created_at，保证同一天日记记录的稳定
    let existing = diary_repo::find_by_date(&pooled, date)?;
    let (id, _created_at) = match &existing {
        Some(d) => (d.id.clone(), d.created_at.clone()),
        None => (Uuid::new_v4().to_string(), ts.clone()),
    };
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "UPSERT",
        "diaries",
        format!(
            "diary_date={date}, wc={word_count}, keywords={}",
            keywords_json.len()
        ),
        file!(),
        line!(),
    );
    diary_repo::upsert(
        uow.conn(),
        &id,
        date,
        content_html,
        word_count,
        &keywords_json,
        &ts,
    )?;
    uow.commit()?;

    // 回读保存后的完整记录
    diary_repo::find_by_date(&pooled, date)?
        .ok_or_else(|| AppError::Business("日记保存后回读失败".to_string()))
}

/// 按日期删除日记（该日期无日记时静默成功）
pub fn delete_diary(app: &AppHandle, db: &AppDb, date: &str) -> Result<(), AppError> {
    if !is_valid_date(date) {
        return Err(AppError::Validation(format!(
            "日期格式不合法: {date}（应为 YYYY-MM-DD）"
        )));
    }
    // v1.9：迁移到 UnitOfWork（autocommit 模式，审计统一收口）。
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit(
        "DELETE",
        "diaries",
        format!("diary_date={date}"),
        file!(),
        line!(),
    );
    diary_repo::delete_by_date(uow.conn(), date)?;
    uow.commit()?;
    Ok(())
}

/// 全文检索日记（FTS5 优先，无命中降级 LIKE），返回带纯文本片段的命中列表
pub fn search_diaries(
    app: &AppHandle,
    db: &AppDb,
    query: &str,
    limit: usize,
) -> Result<Vec<DiarySearchHit>, AppError> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    let rows = {
        let fts_query = escape_fts5_query(query);
        if !fts_query.is_empty() {
            match diary_repo::search_fts5(uow.conn(), &fts_query, limit) {
                Ok(r) => {
                    uow.audit(
                        "SELECT",
                        "diaries_fts",
                        format!("FTS5 MATCH '{query}'"),
                        file!(),
                        line!(),
                    );
                    r
                }
                Err(_) => {
                    let pattern = like_pattern(query, 64);
                    uow.audit(
                        "SELECT",
                        "diaries",
                        format!("FTS5 无命中，降级 LIKE: {query}"),
                        file!(),
                        line!(),
                    );
                    diary_repo::search_like(uow.conn(), &pattern, limit)?
                }
            }
        } else {
            let pattern = like_pattern(query, 64);
            uow.audit(
                "SELECT",
                "diaries",
                format!("LIKE fallback: {query}"),
                file!(),
                line!(),
            );
            diary_repo::search_like(uow.conn(), &pattern, limit)?
        }
    };
    uow.commit()?;

    let hits = rows
        .into_iter()
        .map(|(id, date, wc, kw_json, html)| DiarySearchHit {
            id,
            diary_date: date,
            word_count: wc,
            keywords: diary_repo::parse_keywords(kw_json),
            excerpt: snippet(&strip_html(&html), 80),
        })
        .collect();
    Ok(hits)
}

/// 日记统计：当前/最长连续天数、累计篇数、累计字数、最近 12 个月趋势
pub fn diary_stats(app: &AppHandle, db: &AppDb) -> Result<DiaryStats, AppError> {
    let pooled = db.pool.get()?;
    let mut uow = UnitOfWork::new(&pooled, Some(app));
    uow.audit("SELECT", "diaries", "stats", file!(), line!());

    let (total_days, total_words) = diary_repo::aggregate_totals(uow.conn())?;
    let dates = diary_repo::all_dates(uow.conn())?;
    let (current_streak, longest_streak) = compute_streaks(&dates);

    let months = last_12_months();
    let since = format!("{}", months.first().map(|m| format!("{m}-01")).unwrap_or_else(|| "0000-01-01".to_string()));
    let monthly_map: std::collections::HashMap<String, (i64, i64)> = diary_repo::monthly_words(uow.conn(), &since)?
        .into_iter()
        .map(|(m, w, d)| (m, (w, d)))
        .collect();
    let monthly = months
        .into_iter()
        .map(|m| {
            let (words, days) = monthly_map.get(&m).copied().unwrap_or((0, 0));
            DiaryMonthStat { month: m, words, days }
        })
        .collect();

    uow.commit()?;
    Ok(DiaryStats {
        current_streak,
        longest_streak,
        total_days,
        total_words,
        monthly,
    })
}

/// 本地今日日期键 YYYY-MM-DD
fn local_today_key() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 日期键前一天（本地）
fn prev_day(key: &str) -> String {
    if let Ok(d) = chrono::NaiveDate::parse_from_str(key, "%Y-%m-%d") {
        (d - chrono::Days::new(1)).format("%Y-%m-%d").to_string()
    } else {
        key.to_string()
    }
}

/// a 是否为 b 的前一天（本地）
fn is_prev_day(a: &str, b: &str) -> bool {
    prev_day(b) == a
}

/// 计算当前连续天数（含今日未写顺延至昨日的口径）与历史最长连续天数
fn compute_streaks(dates: &[String]) -> (i64, i64) {
    if dates.is_empty() {
        return (0, 0);
    }
    let set: std::collections::HashSet<&str> = dates.iter().map(|s| s.as_str()).collect();

    // 最长连续
    let mut sorted = dates.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut longest = 1i64;
    let mut cur = 1i64;
    for w in sorted.windows(2) {
        if is_prev_day(&w[0], &w[1]) {
            cur += 1;
            longest = longest.max(cur);
        } else {
            cur = 1;
        }
    }

    // 当前连续（宽限：今日未写则顺延至昨日）
    let today = local_today_key();
    let mut start = today.clone();
    if !set.contains(start.as_str()) {
        let y = prev_day(&today);
        if !set.contains(y.as_str()) {
            return (0, longest);
        }
        start = y;
    }
    let mut streak = 0i64;
    let mut d = start.clone();
    while set.contains(d.as_str()) {
        streak += 1;
        d = prev_day(&d);
    }
    (streak, longest)
}

/// 最近 12 个月键（旧→新），含本月
fn last_12_months() -> Vec<String> {
    let now = chrono::Local::now().date_naive();
    let mut out = Vec::with_capacity(12);
    for i in 0..12 {
        let m = now - chrono::Months::new((11 - i) as u32);
        out.push(format!("{:04}-{:02}", m.year(), m.month()));
    }
    out
}
