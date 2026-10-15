//! 英语生词本 IPC 命令
//!
//! 覆盖生词 CRUD、SM-2 复习提交、到期队列与统计。
//! 业务逻辑集中在 `service::vocab_service`。
//! 对应 tauri-bridge.ts 的 `vocabApi`（阅读取词收藏 / 生词本窗口）。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{VocabKnowledge, VocabMeaning, VocabPage, VocabStats, VocabWord};
use crate::service::vocab_service;
use crate::service::vocab_relation_service;
use crate::service::ServiceCtx;
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
        ServiceCtx::new(&app, &state),
        vocab_service::AddWordBizArgs {
            word: &args.word,
            phonetic: &args.phonetic,
            meanings: &args.meanings,
            example: &args.example,
            example_zh: &args.example_zh,
            knowledge: args.knowledge.as_ref(),
            source: &args.source,
        },
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
        ServiceCtx::new(&app, &state),
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

/// 分页列出生词（虚拟滚动）：返回本页条目 + 匹配总数
///
/// `page` 0 基页码，`page_size` 每页条数。状态过滤 / 模糊搜索与 `vocab_list` 一致。
#[tauri::command]
pub fn vocab_list_page(
    app: AppHandle,
    state: State<AppDb>,
    status: Option<String>,
    query: Option<String>,
    page: i64,
    page_size: i64,
) -> Result<VocabPage, AppError> {
    vocab_service::list_words_page(
        &app,
        &state,
        status.as_deref(),
        query.as_deref(),
        page,
        page_size,
    )
}

/// 随机抽取 N 个已掌握词（「复习已掌握词」批量回炉入口）
#[tauri::command]
pub fn vocab_mastered_sample(
    app: AppHandle,
    state: State<AppDb>,
    limit: i64,
) -> Result<Vec<VocabWord>, AppError> {
    vocab_service::mastered_sample(&app, &state, limit)
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

/// 按单词精确查找（大小写不敏感），未收录返回 null
#[tauri::command]
pub fn vocab_get_by_word(state: State<AppDb>, word: String) -> Result<Option<VocabWord>, AppError> {
    vocab_service::get_by_word(&state, &word)
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

// ───────────────────────── 单词关联网络 ─────────────────────────

/// 某生词的全部关联（含关联词在生词本中的收录状态）
#[tauri::command]
pub fn vocab_relations_list(
    state: State<AppDb>,
    word_id: String,
) -> Result<Vec<crate::models::VocabRelationView>, AppError> {
    vocab_relation_service::list_relations(&state, &word_id)
}

/// 手动添加关联（relation_type: synonym/antonym/derived/inflection/manual；幂等）
#[tauri::command]
pub fn vocab_relations_add(
    app: AppHandle,
    state: State<AppDb>,
    word_id: String,
    related_word: String,
    relation_type: String,
) -> Result<crate::models::VocabRelation, AppError> {
    vocab_relation_service::add_relation(&app, &state, &word_id, &related_word, &relation_type)
}

/// 删除一条关联
#[tauri::command]
pub fn vocab_relations_remove(
    app: AppHandle,
    state: State<AppDb>,
    id: String,
) -> Result<(), AppError> {
    vocab_relation_service::remove_relation(&app, &state, &id)
}

/// ECDICT 变形家族建议（标注各成员是否已收录；未收录成员不落库）
#[tauri::command]
pub fn vocab_relations_suggest(
    app: AppHandle,
    state: State<AppDb>,
    word: String,
) -> Result<Vec<crate::models::VocabRelatedCandidate>, AppError> {
    vocab_relation_service::suggest_family(&app, &state, &word)
}

/// 全库关联条数（生词列表徽标用）
#[tauri::command]
pub fn vocab_relations_counts(
    state: State<AppDb>,
) -> Result<Vec<crate::models::VocabRelationCount>, AppError> {
    vocab_relation_service::relation_counts(&state)
}

/// 词族复习分组（学习中生词按 ECDICT 原型 lemma 聚族，≥2 成族，按成员数降序）
#[tauri::command]
pub fn vocab_family_groups(
    app: AppHandle,
    state: State<AppDb>,
) -> Result<Vec<crate::models::VocabFamilyGroup>, AppError> {
    vocab_relation_service::family_groups(&app, &state)
}

/// 关联图谱（include_potential 追加未收录叶子节点；status: all/learning/mastered/suspended；节点封顶 300）
#[tauri::command]
pub fn vocab_relations_graph(
    state: State<AppDb>,
    include_potential: Option<bool>,
    status: Option<String>,
) -> Result<crate::models::VocabGraph, AppError> {
    vocab_relation_service::graph(
        &state,
        include_potential.unwrap_or(false),
        status.as_deref(),
    )
}
