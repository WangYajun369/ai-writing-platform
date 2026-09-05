//! 写作统计服务
//!
//! 聚合日更目标、今日字数、连续写作天数与近 30 日字数曲线。
//! 数据来自 `writing_stats` 表（保存章节时随路写入净增字数）。

use crate::commands::window::emit_sql_log;
use crate::commands::writing_stats::{DailyWords, WritingStats};
use crate::db::AppDb;
use crate::error::AppError;
use crate::repository::{book_repo, writing_stats_repo};
use chrono::{Duration, Local};
use std::collections::HashMap;
use tauri::AppHandle;

/// 曲线覆盖天数（含今日；补 0 到满格）
const CURVE_DAYS: i64 = 30;

/// 获取某本书的写作统计
pub fn get_writing_stats(
    app: &AppHandle,
    db: &AppDb,
    book_id: &str,
) -> Result<WritingStats, AppError> {
    let conn = db.pool.get()?;
    emit_sql_log(
        app,
        "SELECT",
        "writing_stats",
        &format!("book_id={book_id}, range={CURVE_DAYS}d"),
        file!(),
        line!(),
    );

    let daily_target = book_repo::find_daily_target(&conn, book_id)?;
    let today = Local::now().date_naive();
    let since = today - Duration::days(CURVE_DAYS - 1);

    let rows = writing_stats_repo::list_since(&conn, book_id, &since.to_string())?;
    let words_by_date: HashMap<String, i64> = rows.into_iter().collect();

    // 近 CURVE_DAYS 天曲线（升序，含补 0）
    let mut last_days: Vec<DailyWords> = Vec::with_capacity(CURVE_DAYS as usize);
    for back in (0..CURVE_DAYS).rev() {
        let day = today - Duration::days(back);
        let words = words_by_date.get(&day.to_string()).copied().unwrap_or(0);
        last_days.push(DailyWords {
            date: day.to_string(),
            words,
        });
    }

    // 连续天数：今日有写作从今日起算；否则从昨日起算（保持“连续 N 天”语义）
    let today_words = words_by_date.get(&today.to_string()).copied().unwrap_or(0);
    let mut cursor = if today_words > 0 {
        today
    } else {
        today - Duration::days(1)
    };
    let mut streak_days: i64 = 0;
    while streak_days < CURVE_DAYS {
        if words_by_date.get(&cursor.to_string()).copied().unwrap_or(0) <= 0 {
            break;
        }
        streak_days += 1;
        cursor -= Duration::days(1);
    }

    Ok(WritingStats {
        daily_target,
        today_words,
        streak_days,
        last_days,
    })
}
