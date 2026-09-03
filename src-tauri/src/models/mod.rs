//! TimeWrite 数据模型定义
//!
//! 与前端 TypeScript 类型保持一致，使用 serde 序列化/反序列化，
//! 字段名通过 `#[serde(rename)]` 映射为 camelCase。

use serde::{Deserialize, Serialize};

/// 书籍 — 对应 `books` 表，支持软删除 (deleted_at)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: String,
    #[serde(rename = "coverImage")]
    pub cover_image: Option<String>,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    #[serde(rename = "dailyTarget")]
    pub daily_target: i64,
    #[serde(rename = "todayCount")]
    pub today_count: i64,
    #[serde(rename = "dbPath")]
    pub db_path: String,
    pub tags: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: Option<String>,
    /// 作品大纲（纯文本）
    pub outline: String,
}

/// 卷 — 对应 `volumes` 表，按 sort_order 排序，支持软删除 (deleted_at)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Volume {
    pub id: String,
    #[serde(rename = "bookId")]
    pub book_id: String,
    pub title: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: Option<String>,
}

/// 章节 — 对应 `chapters` 表，支持软删除 (deleted_at)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Chapter {
    pub id: String,
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "volumeId")]
    pub volume_id: Option<String>,
    pub title: String,
    #[serde(rename = "contentHtml")]
    pub content_html: Option<String>,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    pub status: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "deletedAt")]
    pub deleted_at: Option<String>,
    /// AI 章节总结内容
    pub summary: Option<String>,
    /// 上次总结时间 ISO
    #[serde(rename = "summaryAt")]
    pub summary_at: Option<String>,
    /// 章节大纲
    pub outline: String,
}

/// 版本快照 — 对应 `snapshots` 表，type 为 auto 或 milestone
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Snapshot {
    pub id: String,
    #[serde(rename = "chapterId")]
    pub chapter_id: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    #[serde(rename = "type")]
    pub snapshot_type: String,
    pub label: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// 世界观卡片 — 对应 `world_cards` 表，6 种类型，vectorized 标识向量化状态
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorldCard {
    pub id: String,
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "type")]
    pub card_type: String,
    pub title: String,
    pub content: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    pub tags: Vec<String>,
    pub vectorized: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 日记 — 对应 `diaries` 表，每天最多一篇（diary_date 唯一索引约束）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Diary {
    pub id: String,
    /// 日记日期 YYYY-MM-DD
    #[serde(rename = "diaryDate")]
    pub diary_date: String,
    #[serde(rename = "contentHtml")]
    pub content_html: String,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    /// 关键字列表（存 TEXT JSON）
    pub keywords: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 日记摘要 — 列表/日历场景，不含正文
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiaryMeta {
    pub id: String,
    /// 日记日期 YYYY-MM-DD
    #[serde(rename = "diaryDate")]
    pub diary_date: String,
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    /// 关键字列表
    pub keywords: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// 日程 — 对应 schedules 表，某天可有多条日程
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Schedule {
    pub id: String,
    /// 日程日期 YYYY-MM-DD
    #[serde(rename = "scheduleDate")]
    pub schedule_date: String,
    pub content: String,
    pub done: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

// ══════════ 英语生词本（艾宾浩斯 / SM-2 复习）══════════

/// 单条释义 {pos: 词性, def: 释义}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabMeaning {
    /// 词性，如 "n." / "v."，可空
    pub pos: String,
    /// 释义文本
    pub def: String,
}

/// 生词条目 — 对应 `vocab_words` 表
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabWord {
    pub id: String,
    /// 单词（小写规范化存储）
    pub word: String,
    /// 音标，如 /ˈwɜːd/
    pub phonetic: String,
    /// 释义列表（存 TEXT JSON）
    pub meanings: Vec<VocabMeaning>,
    /// 例句
    pub example: String,
    /// 例句中文翻译
    #[serde(rename = "exampleZh")]
    pub example_zh: String,
    /// SM-2 连续答对次数（阶段）
    pub repetition: i64,
    /// 当前复习间隔（天）
    #[serde(rename = "intervalDays")]
    pub interval_days: i64,
    /// SM-2 难度系数 EF（初始 2.5，最低 1.3）
    #[serde(rename = "easeFactor")]
    pub ease_factor: f64,
    /// learning / mastered / suspended
    pub status: String,
    /// 下次复习日期 YYYY-MM-DD，可为空（新词未排期）
    #[serde(rename = "nextReviewAt")]
    pub next_review_at: Option<String>,
    /// 上次复习时间 RFC3339
    #[serde(rename = "lastReviewAt")]
    pub last_review_at: Option<String>,
    #[serde(rename = "reviewCount")]
    pub review_count: i64,
    #[serde(rename = "correctCount")]
    pub correct_count: i64,
    /// 收录来源 manual / editor / import
    pub source: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    /// AI 翻译附带的学习知识（词根词缀/近反义词/词组/动词变形/词性例句），无则为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<VocabKnowledge>,
}

/// 复习记录 — 对应 `vocab_reviews` 表
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabReviewLog {
    pub id: String,
    #[serde(rename = "wordId")]
    pub word_id: String,
    /// 复习日期 YYYY-MM-DD
    #[serde(rename = "reviewDate")]
    pub review_date: String,
    /// 自评 0忘记 1模糊 2记得 3轻松
    pub rating: i64,
    /// 本次复习后的 SM-2 repetition
    pub repetition: i64,
    #[serde(rename = "intervalDays")]
    pub interval_days: i64,
    #[serde(rename = "easeFactor")]
    pub ease_factor: f64,
    #[serde(rename = "reviewedAt")]
    pub reviewed_at: String,
}

/// 复习统计中的每日数据（折线图用）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StatsDay {
    /// YYYY-MM-DD
    pub date: String,
    pub count: i64,
}

/// 生词本统计概览
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabStats {
    pub total: i64,
    pub learning: i64,
    pub mastered: i64,
    pub suspended: i64,
    /// 今日待复习数（含逾期）
    #[serde(rename = "dueToday")]
    pub due_today: i64,
    /// 今日已复习数
    #[serde(rename = "reviewedToday")]
    pub reviewed_today: i64,
    /// 近 7 天新收录
    #[serde(rename = "newThisWeek")]
    pub new_this_week: i64,
    /// 近 30 天复习量分布（升序）
    #[serde(rename = "reviewHistory")]
    pub review_history: Vec<StatsDay>,
}

/// 离线词典词条命中（ECDICT stardict）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DictHit {
    pub word: String,
    pub phonetic: String,
    /// 中文释义（可能多行，\n 分隔）
    pub translation: String,
    /// 英文释义（可为空）
    pub definition: String,
    /// 词形变化
    pub exchange: String,
}

/// 离线词典状态
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DictStatus {
    /// 词典文件是否已就绪
    pub installed: bool,
    /// 词条总数（未安装为 0）
    #[serde(rename = "wordCount")]
    pub word_count: i64,
    /// 词典文件路径（未安装为空串）
    #[serde(rename = "dbPath")]
    pub db_path: String,
}

/// AI 兜底释义结果（DeepSeek 生成）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiWordExplain {
    pub phonetic: String,
    pub meanings: Vec<VocabMeaning>,
    pub example: String,
    /// 例句中文翻译
    #[serde(rename = "exampleZh", default)]
    pub example_zh: String,
    /// AI 翻译附带的学习知识（词根词缀/近反义词/词组/动词变形/词性例句）
    #[serde(default)]
    pub knowledge: VocabKnowledge,
}

// ══════════ 生词学习知识（DeepSeek AI 翻译生成，可选存 ai_details 列）══════════

/// 词根词缀分析项，kind 取值：prefix / root / suffix
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabMorphItem {
    /// prefix / root / suffix
    pub kind: String,
    /// 词缀片段，如 un- / -able / -ion
    pub part: String,
    /// 中文含义说明
    pub meaning: String,
}

/// 常用词组短语 {phrase: 英文词组, meaning: 中文含义}
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabPhrase {
    pub phrase: String,
    pub meaning: String,
}

/// 词性例句 {pos: 词性, sentence: 英文例句, translation: 中文译文}
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabSentence {
    pub pos: String,
    pub sentence: String,
    pub translation: String,
}

/// 生词学习知识集合（DeepSeek 翻译生成，尽量完整的词典信息）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabKnowledge {
    /// 词根词缀（前缀 prefix / 词根 root / 后缀 suffix）
    pub morphology: Vec<VocabMorphItem>,
    /// 近义词（条目可含中文小注，如 "happy（高兴的）"）
    pub synonyms: Vec<String>,
    /// 反义词
    pub antonyms: Vec<String>,
    /// 常用词组短语
    pub phrases: Vec<VocabPhrase>,
    /// 动词变形（如 ["第三人称单数: works", "现在分词: working"]），仅动词词条生成
    pub verb_forms: Vec<String>,
    /// 按词性区分的例句（帮助结合语境理解）
    pub examples: Vec<VocabSentence>,
}
