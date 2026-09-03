//! 英语生词本业务服务
//!
//! 核心职责：
//! - 生词 CRUD（收录 / 编辑 / 删除）
//! - **SM-2 复习调度**：根据自评反馈动态计算下次复习间隔与难度系数
//! - 到期队列、统计汇总
//!
//! 每次影响"今日待复习数"的写操作都会向主窗口广播 `vocab-due-updated`，
//! 驱动首页头部徽标实时刷新。

use chrono::{Duration, Local, NaiveDate};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{StatsDay, VocabKnowledge, VocabMeaning, VocabStats, VocabWord};
use crate::commands::window::emit_sql_log;
use crate::utils::{now, validate_len};
use crate::repository::vocab_repo;

/// 生词长度上限
const MAX_WORD_LEN: usize = 100;
/// 音标长度上限
const MAX_PHONETIC_LEN: usize = 60;
/// 例句长度上限
const MAX_EXAMPLE_LEN: usize = 2_000;
/// 释义条数上限
const MAX_MEANINGS_COUNT: usize = 20;
/// 单条释义长度上限
const MAX_MEANING_LEN: usize = 500;
/// SM-2 最低难度系数
const MIN_EASE_FACTOR: f64 = 1.3;
/// 自动判定"已掌握"：连续答对次数 ≥ 该值 且 间隔 ≥ 该天数
const MASTER_REPETITION: i64 = 7;
const MASTER_INTERVAL_DAYS: i64 = 30;

/// 今日日期 YYYY-MM-DD（本地时区）
pub fn today_str() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

/// 日期 +N 天（N 可为 0/负数），返回 YYYY-MM-DD
fn date_plus_days(date: &str, days: i64) -> Option<String> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    Some((d + Duration::days(days)).format("%Y-%m-%d").to_string())
}

/// 将自评档位映射为 SM-2 质量分 q（0-5）
fn rating_to_quality(rating: i64) -> i64 {
    match rating {
        0 => 0, // 忘记
        1 => 3, // 模糊
        2 => 4, // 记得
        _ => 5, // 轻松
    }
}

/// SM-2 调度结果
struct Sm2Result {
    repetition: i64,
    interval_days: i64,
    ease_factor: f64,
    next_review_at: String,
}

/// 核心 SM-2 计算
///
/// - q < 3（忘记/答不上）：重置 repetition=0，间隔回到 1 天，EF 不变
/// - q >= 3（答对）：按 SM-2 公式推进间隔；EF 按公式微调（下限 1.3）
fn sm2_apply(
    cur_repetition: i64,
    cur_interval: i64,
    cur_ef: f64,
    quality: i64,
    today: &str,
) -> Sm2Result {
    let today = today.to_string();
    if quality < 3 {
        return Sm2Result {
            repetition: 0,
            interval_days: 1,
            ease_factor: cur_ef.max(MIN_EASE_FACTOR),
            next_review_at: date_plus_days(&today, 1).unwrap_or(today),
        };
    }

    let (repetition, interval) = if cur_repetition == 0 {
        (1, 1)
    } else if cur_repetition == 1 {
        (2, 6)
    } else {
        let next_interval = (cur_interval as f64 * cur_ef).round().max(1.0) as i64;
        (cur_repetition + 1, next_interval)
    };

    let mut ef = cur_ef + (0.1 - (5 - quality) as f64 * (0.08 + (5 - quality) as f64 * 0.02));
    if ef < MIN_EASE_FACTOR {
        ef = MIN_EASE_FACTOR;
    }

    Sm2Result {
        repetition,
        interval_days: interval,
        ease_factor: ef,
        next_review_at: date_plus_days(&today, interval).unwrap_or(today),
    }
}

/// 广播到期数变化（首页头部徽标监听）
fn emit_due_updated(app: &AppHandle) {
    let _ = app.emit("vocab-due-updated", ());
}

/// 校验单词文本并规范化（小写、去空格）
fn normalize_word(word: &str) -> Result<String, AppError> {
    let w = word.trim().to_lowercase();
    validate_len("单词", &w, MAX_WORD_LEN)?;
    if w.is_empty() {
        return Err(AppError::Validation("单词不能为空".to_string()));
    }
    Ok(w)
}

/// 校验释义 JSON 载荷（数量与单条长度）
fn validate_meanings(meanings: &[VocabMeaning]) -> Result<(), AppError> {
    if meanings.len() > MAX_MEANINGS_COUNT {
        return Err(AppError::Validation(format!(
            "释义条数超过上限（{} > {}）",
            meanings.len(),
            MAX_MEANINGS_COUNT
        )));
    }
    for m in meanings {
        validate_len("释义", &m.def, MAX_MEANING_LEN)?;
    }
    Ok(())
}

/// 校验状态字面量
fn validate_status(status: &str) -> Result<(), AppError> {
    if !matches!(status, "learning" | "mastered" | "suspended") {
        return Err(AppError::Validation(format!("不合法的生词状态: {status}")));
    }
    Ok(())
}

// ───────────────────────── 生词 CRUD ─────────────────────────

/// 收录生词（重名时更新释义并返回原词）
pub fn add_word(
    app: &AppHandle,
    db: &AppDb,
    word: &str,
    phonetic: &str,
    meanings: &[VocabMeaning],
    example: &str,
    example_zh: &str,
    knowledge: Option<&VocabKnowledge>,
    source: &str,
) -> Result<VocabWord, AppError> {
    let word = normalize_word(word)?;
    validate_len("音标", phonetic, MAX_PHONETIC_LEN)?;
    validate_len("例句", example, MAX_EXAMPLE_LEN)?;
    validate_len("例句翻译", example_zh, MAX_EXAMPLE_LEN)?;
    validate_meanings(meanings)?;

    let ts = now();
    let meanings_json = serde_json::to_string(meanings)?;
    let ai_details = serde_json::to_string(&knowledge).unwrap_or_default();
    let conn = db.pool.get()?;

    // 已存在：更新释义/音标/例句（不重置复习进度）
    if let Some(existing) = vocab_repo::find_by_word(&conn, &word)? {
        emit_sql_log(app, "UPDATE", "vocab_words", &format!("word={word}（已存在，更新释义）"), file!(), line!());
        vocab_repo::update_content_fields(&conn, &existing.id, phonetic, &meanings_json, example, example_zh, &ai_details, &ts)?;
        emit_due_updated(app);
        return vocab_repo::find_by_id(&conn, &existing.id)?
            .ok_or_else(|| AppError::Business("更新后回读失败".to_string()));
    }

    let id = Uuid::new_v4().to_string();
    emit_sql_log(app, "INSERT", "vocab_words", &format!("word={word}, source={source}"), file!(), line!());
    // 新词次日安排首次复习（艾宾浩斯记忆点起点）
    let today = today_str();
    let first_review = date_plus_days(&today, 1).unwrap_or_else(|| today.clone());
    vocab_repo::create_word(
        &conn,
        &id,
        &word,
        phonetic,
        &meanings_json,
        example,
        example_zh,
        &ai_details,
        source,
        Some(&first_review),
        &ts,
    )?;
    emit_due_updated(app);
    vocab_repo::find_by_id(&conn, &id)?
        .ok_or_else(|| AppError::Business("收录后回读失败".to_string()))
}

/// 编辑释义类字段
pub fn update_word(
    app: &AppHandle,
    db: &AppDb,
    id: &str,
    phonetic: &str,
    meanings: &[VocabMeaning],
    example: &str,
    example_zh: &str,
    knowledge: Option<&VocabKnowledge>,
) -> Result<VocabWord, AppError> {
    validate_len("音标", phonetic, MAX_PHONETIC_LEN)?;
    validate_len("例句", example, MAX_EXAMPLE_LEN)?;
    validate_len("例句翻译", example_zh, MAX_EXAMPLE_LEN)?;
    validate_meanings(meanings)?;

    let ts = now();
    let meanings_json = serde_json::to_string(meanings)?;
    let ai_details = serde_json::to_string(&knowledge).unwrap_or_default();
    let conn = db.pool.get()?;
    if vocab_repo::find_by_id(&conn, id)?.is_none() {
        return Err(AppError::NotFound(format!("生词不存在: {id}")));
    }
    emit_sql_log(app, "UPDATE", "vocab_words", &format!("id={id} 释义编辑"), file!(), line!());
    vocab_repo::update_content_fields(&conn, id, phonetic, &meanings_json, example, example_zh, &ai_details, &ts)?;
    vocab_repo::find_by_id(&conn, id)?
        .ok_or_else(|| AppError::Business("更新后回读失败".to_string()))
}

/// 切换状态（learning / mastered / suspended）
pub fn set_status(app: &AppHandle, db: &AppDb, id: &str, status: &str) -> Result<VocabWord, AppError> {
    validate_status(status)?;
    let ts = now();
    let conn = db.pool.get()?;
    if vocab_repo::find_by_id(&conn, id)?.is_none() {
        return Err(AppError::NotFound(format!("生词不存在: {id}")));
    }
    emit_sql_log(app, "UPDATE", "vocab_words", &format!("id={id} → status={status}"), file!(), line!());
    vocab_repo::set_status(&conn, id, status, &ts)?;
    emit_due_updated(app);
    vocab_repo::find_by_id(&conn, id)?
        .ok_or_else(|| AppError::Business("更新后回读失败".to_string()))
}

/// 删除生词
pub fn delete_word(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    if vocab_repo::find_by_id(&conn, id)?.is_none() {
        return Err(AppError::NotFound(format!("生词不存在: {id}")));
    }
    emit_sql_log(app, "DELETE", "vocab_words", &format!("id={id}"), file!(), line!());
    vocab_repo::delete_word(&conn, id)?;
    emit_due_updated(app);
    Ok(())
}

// ───────────────────────── 查询 ─────────────────────────

/// 列出生词（状态过滤 + 关键词模糊搜索）
pub fn list_words(
    app: &AppHandle,
    db: &AppDb,
    status: Option<&str>,
    query: Option<&str>,
) -> Result<Vec<VocabWord>, AppError> {
    if let Some(st) = status {
        if !st.is_empty() && st != "all" {
            validate_status(st)?;
        }
    }
    emit_sql_log(app, "SELECT", "vocab_words", &format!("status={status:?}, query={query:?}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(vocab_repo::list_words(&conn, status, query)?)
}

/// 今日到期队列（含逾期未复习）
pub fn list_due(app: &AppHandle, db: &AppDb) -> Result<Vec<VocabWord>, AppError> {
    let today = today_str();
    emit_sql_log(app, "SELECT", "vocab_words", &format!("due <= {today}"), file!(), line!());
    let conn = db.pool.get()?;
    Ok(vocab_repo::list_due(&conn, &today)?)
}

/// 某生词的复习历史（详情弹层展示）
pub fn get_review_logs(
    db: &AppDb,
    word_id: &str,
) -> Result<Vec<crate::models::VocabReviewLog>, AppError> {
    let conn = db.pool.get()?;
    Ok(vocab_repo::list_review_logs(&conn, word_id)?)
}

/// 单条查询
pub fn get_word(db: &AppDb, id: &str) -> Result<VocabWord, AppError> {
    let conn = db.pool.get()?;
    vocab_repo::find_by_id(&conn, id)?
        .ok_or_else(|| AppError::NotFound(format!("生词不存在: {id}")))
}

// ───────────────────────── 复习（SM-2）─────────────────────────

/// 提交一次复习反馈，推进 SM-2 状态并写入复习日志
pub fn submit_review(
    app: &AppHandle,
    db: &AppDb,
    word_id: &str,
    rating: i64,
) -> Result<VocabWord, AppError> {
    if !(0..=3).contains(&rating) {
        return Err(AppError::Validation(format!("不合法的复习评分: {rating}（应为 0-3）")));
    }

    let mut conn = db.pool.get()?;
    let word = vocab_repo::find_by_id(&conn, word_id)?
        .ok_or_else(|| AppError::NotFound(format!("生词不存在: {word_id}")))?;

    if word.status != "learning" {
        return Err(AppError::Business(format!(
            "「{}」不在复习队列中（状态: {}）",
            word.word, word.status
        )));
    }

    let today = today_str();
    let quality = rating_to_quality(rating);
    let sm = sm2_apply(word.repetition, word.interval_days, word.ease_factor, quality, &today);
    let correct = quality >= 3;

    // 自动判定已掌握：连续答对足够多次且复习间隔足够长
    let status = if correct && sm.repetition >= MASTER_REPETITION && sm.interval_days >= MASTER_INTERVAL_DAYS {
        "mastered"
    } else {
        "learning"
    };

    emit_sql_log(
        app,
        "REVIEW",
        "vocab_words",
        &format!(
            "word={}, rating={rating}, q={quality}, rep={}->{}, interval={}d, ef={:.2}",
            word.word, word.repetition, sm.repetition, sm.interval_days, sm.ease_factor
        ),
        file!(),
        line!(),
    );

    let reviewed_at = now();
    let tx = conn.transaction()?;
    vocab_repo::update_review_state(
        &tx,
        &word.id,
        sm.repetition,
        sm.interval_days,
        sm.ease_factor,
        status,
        Some(&sm.next_review_at),
        &reviewed_at,
        correct,
    )?;
    vocab_repo::insert_review_log(
        &tx,
        &Uuid::new_v4().to_string(),
        &word.id,
        &today,
        rating,
        sm.repetition,
        sm.interval_days,
        sm.ease_factor,
        &reviewed_at,
    )?;
    tx.commit()?;

    emit_due_updated(app);
    vocab_repo::find_by_id(&conn, &word.id)?
        .ok_or_else(|| AppError::Business("复习后回读失败".to_string()))
}

// ───────────────────────── 统计 ─────────────────────────

/// 汇总统计
pub fn get_stats(app: &AppHandle, db: &AppDb) -> Result<VocabStats, AppError> {
    let today = today_str();
    let week_ago = date_plus_days(&today, -6).unwrap_or_else(|| today.clone());
    let month_ago = date_plus_days(&today, -29).unwrap_or_else(|| today.clone());

    let conn = db.pool.get()?;
    emit_sql_log(app, "SELECT", "vocab_words", "stats: 汇总计数", file!(), line!());

    let mut review_history: Vec<StatsDay> = vocab_repo::review_history(&conn, &month_ago)?;
    // 补全无记录日期为 0，保证前端可直接画连续 30 天曲线
    let mut expected = NaiveDate::parse_from_str(&month_ago, "%Y-%m-%d").unwrap_or_else(|_| Local::now().date_naive() - Duration::days(29));
    let end = NaiveDate::parse_from_str(&today, "%Y-%m-%d").unwrap_or_else(|_| Local::now().date_naive());
    let map: std::collections::HashMap<String, i64> = review_history
        .drain(..)
        .map(|d| (d.date, d.count))
        .collect();
    let mut filled: Vec<StatsDay> = Vec::new();
    while expected <= end {
        let key = expected.format("%Y-%m-%d").to_string();
        filled.push(StatsDay { date: key.clone(), count: *map.get(&key).unwrap_or(&0) });
        expected += Duration::days(1);
    }
    review_history = filled;

    Ok(VocabStats {
        total: vocab_repo::count_total(&conn)?,
        learning: vocab_repo::count_by_status(&conn, "learning")?,
        mastered: vocab_repo::count_by_status(&conn, "mastered")?,
        suspended: vocab_repo::count_by_status(&conn, "suspended")?,
        due_today: vocab_repo::count_due(&conn, &today)?,
        reviewed_today: vocab_repo::count_reviewed_on(&conn, &today)?,
        new_this_week: vocab_repo::count_new_since(&conn, &week_ago)?,
        review_history,
    })
}
