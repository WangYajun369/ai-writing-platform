//! 英语生词本 IPC 命令
//!
//! 覆盖生词 CRUD、SM-2 复习提交、到期队列与统计。
//! 业务逻辑集中在 `service::vocab_service`。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{VocabKnowledge, VocabMeaning, VocabStats, VocabWord};
use crate::service::vocab_service;
use serde::Deserialize;
use tauri::{AppHandle, State};

/// 收录生词参数
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWordArgs {
    pub word: String,
    #[serde(default)]
    pub phonetic: String,
    #[serde(default)]
    pub meanings: Vec<VocabMeaning>,
    #[serde(default)]
    pub example: String,
    /// 例句中文翻译
    #[serde(default)]
    pub example_zh: String,
    /// DeepSeek 翻译附带的学习知识（词根词缀/近反义词/词组/动词变形/词性例句）
    #[serde(default)]
    pub knowledge: Option<VocabKnowledge>,
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "manual".to_string()
}

/// 编辑释义类字段参数
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWordArgs {
    pub id: String,
    #[serde(default)]
    pub phonetic: String,
    #[serde(default)]
    pub meanings: Vec<VocabMeaning>,
    #[serde(default)]
    pub example: String,
    /// 例句中文翻译
    #[serde(default)]
    pub example_zh: String,
    /// DeepSeek 翻译附带的学习知识；不传则清空
    #[serde(default)]
    pub knowledge: Option<VocabKnowledge>,
}

/// 收录生词（单词已存在时更新释义并返回）
#[tauri::command]
pub fn vocab_add(
    app: AppHandle,
    state: State<AppDb>,
    args: AddWordArgs,
) -> Result<VocabWord, AppError> {
    vocab_service::add_word(
        &app,
        &state,
        &args.word,
        &args.phonetic,
        &args.meanings,
        &args.example,
        &args.example_zh,
        args.knowledge.as_ref(),
        &args.source,
    )
}

/// 编辑生词释义 / 音标 / 例句
#[tauri::command]
pub fn vocab_update(
    app: AppHandle,
    state: State<AppDb>,
    args: UpdateWordArgs,
) -> Result<VocabWord, AppError> {
    vocab_service::update_word(
        &app,
        &state,
        &args.id,
        &args.phonetic,
        &args.meanings,
        &args.example,
        &args.example_zh,
        args.knowledge.as_ref(),
    )
}

/// 切换生词状态（learning / mastered / suspended）
#[tauri::command]
pub fn vocab_set_status(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
    status: String,
) -> Result<VocabWord, AppError> {
    vocab_service::set_status(&app, &state, &id, &status)
}

/// 删除生词（复习记录级联删除）
#[tauri::command]
pub fn vocab_delete(app: AppHandle, state: State<AppDb>, id: String) -> Result<(), AppError> {
    vocab_service::delete_word(&app, &state, &id)
}

/// 列出生词（status: all/learning/mastered/suspended，query 单词模糊搜索）
#[tauri::command]
pub fn vocab_list(
    app: AppHandle,
    state: State<AppDb>,
    status: Option<String>,
    query: Option<String>,
) -> Result<Vec<VocabWord>, AppError> {
    vocab_service::list_words(&app, &state, status.as_deref(), query.as_deref())
}

/// 今日到期复习队列
#[tauri::command]
pub fn vocab_due(app: AppHandle, state: State<AppDb>) -> Result<Vec<VocabWord>, AppError> {
    vocab_service::list_due(&app, &state)
}

/// 单条生词详情
#[tauri::command]
pub fn vocab_get(state: State<AppDb>, id: String) -> Result<VocabWord, AppError> {
    vocab_service::get_word(&state, &id)
}

/// 提交复习反馈（rating: 0 忘记 / 1 模糊 / 2 记得 / 3 轻松），推进 SM-2 调度
#[tauri::command]
pub fn vocab_review(
    app: AppHandle,
    state: State<AppDb>,
    word_id: String,
    rating: i64,
) -> Result<VocabWord, AppError> {
    vocab_service::submit_review(&app, &state, &word_id, rating)
}

/// 生词的复习历史记录
#[tauri::command]
pub fn vocab_logs(
    state: State<AppDb>,
    word_id: String,
) -> Result<Vec<crate::models::VocabReviewLog>, AppError> {
    vocab_service::get_review_logs(&state, &word_id)
}

/// 生词本统计（头部徽标/统计页共用）
#[tauri::command]
pub fn vocab_stats(app: AppHandle, state: State<AppDb>) -> Result<VocabStats, AppError> {
    vocab_service::get_stats(&app, &state)
}
