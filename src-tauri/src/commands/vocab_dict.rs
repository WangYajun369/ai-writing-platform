//! 英语字典辅助命令
//!
//! - **离线词典**：读取应用数据目录下 `dict/ecdict.sqlite`（ECDICT 词库格式），
//!   支持状态检测、导入与查询（精确 + 前缀建议）
//! - **AI 兜底释义**：离线词库未命中或释义不理想时，调用 DeepSeek / OpenAI 兼容
//!   接口生成音标 + 词性释义 + 例句（JSON 结构化输出）
//!
//! 对应 tauri-bridge.ts 的 `dictApi`（生词添加面板 / DeepSeek 翻译取词卡）。

use crate::error::{AppError, ErrCode};
use crate::models::{
    AiWordExplain, DictHit, DictStatus, VocabKnowledge, VocabMeaning, VocabMorphItem, VocabPhrase,
    VocabSentence,
};
use crate::utils::get_sse_client;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tauri::{AppHandle, Emitter};

// ───────────────────────── 词典文件 ─────────────────────────

// 词典文件路径与只读打开逻辑已上移到 `crate::utils`（dict_db_path / open_dict_db），
// 供本模块与单词关联服务共享。
use crate::utils::{dict_db_path, open_dict_db};

/// 从 stardict 行解析 DictHit（列顺序依赖查询语句）
fn row_to_hit(row: &rusqlite::Row) -> rusqlite::Result<DictHit> {
    Ok(DictHit {
        word: row.get(0)?,
        phonetic: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
        translation: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        definition: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        exchange: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
    })
}

// ───────────────────────── 词典命令 ─────────────────────────

/// 词典状态（只打开一次只读连接，状态与词条数共用）
#[tauri::command]
pub fn dict_status(app: AppHandle) -> DictStatus {
    let conn = open_dict_db(&app).ok().flatten();
    let installed = conn.is_some();
    let word_count = conn
        .as_ref()
        .and_then(|c| {
            c.query_row("SELECT COUNT(*) FROM stardict", [], |row| row.get(0))
                .ok()
        })
        .unwrap_or(0);
    DictStatus {
        installed,
        word_count,
        db_path: if installed {
            dict_db_path(&app)
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        } else {
            dict_db_path(&app)
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        },
    }
}

/// 导入离线词典文件（复制 ECDICT sqlite 到应用数据目录并校验）
#[tauri::command]
pub fn dict_import(app: AppHandle, source_path: String) -> Result<DictStatus, AppError> {
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err(AppError::Validation(format!(
            "词典文件不存在: {source_path}"
        )));
    }
    // 预校验：目标文件是含 stardict 表的 SQLite
    {
        let check = rusqlite::Connection::open_with_flags(
            &src,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let table_ok: bool = check.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='stardict')",
            [],
            |row| row.get(0),
        )?;
        if !table_ok {
            return Err(AppError::Validation(
                "所选文件不是有效的 ECDICT 词典库（缺少 stardict 表）".to_string(),
            ));
        }
    }

    let dest = dict_db_path(&app)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&src, &dest)?;
    // 词库被替换：清空 lemma / 变形家族查询缓存，避免读到旧词库结果；
    // 并重建变形家族侧车索引（一次性全表扫描），以等值查询替代全表 LIKE 扫描。
    crate::service::vocab_relation_service::invalidate_dict_cache();
    crate::service::vocab_relation_service::rebuild_lemma_index(&app)?;
    Ok(dict_status(app))
}

/// 词典查询结果：精确命中 + 前缀建议
#[derive(Debug, Serialize)]
pub struct DictLookupResult {
    pub hit: Option<DictHit>,
    /// 前缀建议（形近词），至多 6 条
    pub suggestions: Vec<DictHit>,
}

/// 查询单词（离线词典）
#[tauri::command]
pub fn dict_lookup(app: AppHandle, word: String) -> Result<DictLookupResult, AppError> {
    let word = word.trim().to_lowercase();
    let mut result = DictLookupResult {
        hit: None,
        suggestions: Vec::new(),
    };
    let Some(conn) = open_dict_db(&app)? else {
        return Ok(result);
    };

    let hit = conn
        .query_row(
            "SELECT word, phonetic, translation, definition, exchange FROM stardict \
             WHERE word = ?1 COLLATE NOCASE LIMIT 1",
            rusqlite::params![word],
            row_to_hit,
        )
        .ok();
    result.hit = hit;

    let mut stmt = conn.prepare(
        "SELECT word, phonetic, translation, definition, exchange FROM stardict \
         WHERE word LIKE ?1 ESCAPE '\\' AND word != ?2 COLLATE NOCASE \
         ORDER BY length(word) ASC LIMIT 6",
    )?;
    let pattern = format!("{}%", escape_like(&word));
    let items = stmt
        .query_map(rusqlite::params![pattern, word], row_to_hit)?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    result.suggestions = items;

    // 前缀建议太少时做一次「包含」兜底（用户只记得片段 / 拼写不完整时仍能给候选）。
    // 该匹配无法利用索引，需全表扫描，故仅在「前缀命中 <3 条且输入 ≥4 字符」时触发。
    if result.suggestions.len() < 3 && word.chars().count() >= 4 {
        let taken: Vec<String> = result.suggestions.iter().map(|s| s.word.clone()).collect();
        let contains = format!("%{}%", escape_like(&word));
        let mut stmt2 = conn.prepare(
            "SELECT word, phonetic, translation, definition, exchange FROM stardict \
             WHERE word LIKE ?1 ESCAPE '\\' AND word != ?2 COLLATE NOCASE \
             ORDER BY length(word) ASC LIMIT 12",
        )?;
        let extra = stmt2
            .query_map(rusqlite::params![contains, word], row_to_hit)?
            .filter_map(Result::ok)
            .filter(|h| !taken.contains(&h.word))
            .take(6 - result.suggestions.len())
            .collect::<Vec<_>>();
        result.suggestions.extend(extra);
    }
    Ok(result)
}

/// 转义 LIKE 模式中的通配符（`\` `%` `_`），配合 SQL 中的 `ESCAPE '\'`
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

// ───────────────────────── AI 请求取消 ─────────────────────────

/// 取消令牌：原子标志 + `Notify`（与 Agent 引擎的 CancelToken 同构）。
///
/// `notify_waiters()` 唤醒阻塞在 SSE 流读取上的循环（`tokio::select!` 竞争），
/// 实现「关闭对话框即刻断流」，不必等下一帧数据或空闲超时。
struct CancelToken {
    flag: AtomicBool,
    notify: tokio::sync::Notify,
}

impl CancelToken {
    fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }
    fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    fn notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.notify.notified()
    }
}

/// 全局只保留一个「当前请求」的取消令牌：词典 AI 同一时刻仅一个请求在跑
/// （前端 aiBusy 禁用按钮），语义与 Agent 引擎的全局取消一致；过期取消是安全 no-op。
static DICT_AI_CANCEL: StdMutex<Option<Arc<CancelToken>>> = StdMutex::new(None);

fn register_cancel_token() -> Arc<CancelToken> {
    let token = Arc::new(CancelToken::new());
    if let Ok(mut guard) = DICT_AI_CANCEL.lock() {
        *guard = Some(token.clone());
    }
    token
}

/// RAII 注销：请求结束（含 `?` 提前返回 / 超时被丢弃）时自动摘除令牌；
/// 仅当注册表中仍是自己时才清除，避免误删后续请求的新令牌。
struct CancelGuard(Arc<CancelToken>);

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = DICT_AI_CANCEL.lock() {
            if let Some(cur) = guard.as_ref() {
                if Arc::ptr_eq(cur, &self.0) {
                    *guard = None;
                }
            }
        }
    }
}

/// 用户取消的统一错误（前端按 `E_AI_CANCELLED` 静默收场：不回退同步接口、不弹错）
fn cancelled_error() -> AppError {
    AppError::business(ErrCode::AiCancelled, "已取消")
}

/// 取消进行中的词典 AI 请求（形态检查 / 流式释义共用同一令牌）：
/// 置位标志并唤醒阻塞中的流读取，SSE 连接随请求丢弃而关闭。
#[tauri::command]
pub fn dict_ai_cancel() {
    if let Ok(guard) = DICT_AI_CANCEL.lock() {
        if let Some(token) = guard.as_ref() {
            token.cancel();
            crate::app_log!("[vocab] AI 请求已取消（用户关闭对话框）");
        }
    }
}

// ───────────────────────── AI 兜底释义 ─────────────────────────

/// AI 释义请求参数（前端传入其 AI 配置，与流式对话一致）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainWordArgs {
    pub word: String,
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
    pub temperature: Option<f64>,
    /// 翻译目标语言：zh（默认）/ en
    pub lang: Option<String>,
    /// DeepSeek 思考模式：`Some(false)` 显式关闭（结构化词典任务提速）；
    /// `None` 不下发该字段（非 DeepSeek 端点免受未知字段影响）
    pub thinking_enabled: Option<bool>,
}

const EXPLAIN_SYSTEM_PROMPT_ZH: &str = r#"你是一位专业英语词典编纂者，精通词源学与词汇记忆法。请为英文单词 {{WORD}} 生成一份"便于理解与记忆"的完整词典学习条目，严格只输出 JSON（不要代码块围栏、不要任何多余文字）。JSON 结构如下（字段名保持英文不变）：

{
  "phonetic": "英式音标（放在 / 斜杠中，如 /ˈwɜːd/），拿不准也不要编造，宁缺毋滥",
  "meanings": [{"pos": "词性缩写，如 n. / v. / adj. / adv.", "def": "精炼准确的中文释义"}],
  "example": "一句最常用、最利于记忆的完整英文例句",
  "exampleZh": "example 例句的中文翻译（贴合句意、自然通顺）",
  "knowledge": {
    "morphology": [{"kind": "prefix | root | suffix", "part": "词缀片段，如 un- / -able / -ion", "meaning": "该部分的中文含义"}],
    "synonyms": ["近义词（英文，可附简短中文注，如 happy（高兴的））"],
    "antonyms": ["反义词（英文）"],
    "phrases": [{"phrase": "英文常用词组/搭配", "meaning": "中文释义"}],
    "verbForms": ["动词变形说明条目（仅动词词条生成），如 \"第三人称单数: works\"、\"现在分词: working\"、\"过去式: worked\"、\"过去分词: worked\""],
    "examples": [{"pos": "词性", "sentence": "该词性下一句自然、贴近生活的完整英文例句", "translation": "例句中文翻译"}]
  }
}

规则：
1. meanings 覆盖主要词性并按使用频率排序，def 尽量简短（勿堆砌长句）。
2. **字段分离**：pos 字段只能放词性缩写（如 n. / v. / adj. / adv. 等），释义必须放进 def 字段，不要把释义写进 pos。正确示例：{"pos":"n.","def":"来源；出处"} / {"pos":"v.","def":"源于；来自"}。
3. morphology 分析真实构词：有前缀/后缀就分别列出，词根给出核心含义；简单词（如 take）无法可靠拆分时 kind 用 root 并给出核心含义即可。
4. synonyms / antonyms 各给 2~5 个真正贴切的，不要硬凑。
5. phrases 给 2~4 个最常用的搭配或短语。
6. 词条含动词词性时必给 verbForms（第三人称单数/现在分词/过去式/过去分词，不规则动词务必准确），否则给空数组。
7. examples 为每个主要词性各生成一条例句，语境能体现该词性的用法差异。
8. 没有的信息返回空数组或空字符串，不要省略键。
9. 音标一律采用英式（BrE）读音标注。
10. 给出 example 例句时，必须同时把其中文翻译填入 exampleZh，二者缺一不可；没有例句则都为 ""。
11. 保持 JSON 合法：键与值用双引号，不要有尾随逗号。"#;

const EXPLAIN_SYSTEM_PROMPT_EN: &str = "You are a professional English lexicographer skilled in etymology. Given the English word {{WORD}}, produce a rich dictionary entry as strict JSON only (no code fences, no extra text) with exactly this shape: {\"phonetic\": \"BrE IPA with slashes\", \"meanings\": [{\"pos\": \"pos tag like n. / v. / adj.\", \"def\": \"concise English definition\"}], \"example\": \"one natural example sentence\", \"exampleZh\": \"Chinese translation of the example\", \"knowledge\": {\"morphology\": [{\"kind\": \"prefix|root|suffix\", \"part\": \"affix string like un- / -able\", \"meaning\": \"brief meaning\"}], \"synonyms\": [\"...\"], \"antonyms\": [\"...\"], \"phrases\": [{\"phrase\": \"common collocation\", \"meaning\": \"brief gloss\"}], \"verbForms\": [\"third-person singular: works\", \"present participle: working\", ...only for verbs], \"examples\": [{\"pos\": \"pos tag\", \"sentence\": \"natural full sentence for that sense\", \"translation\": \"English rephrase or brief gloss\"}]}}. Use empty arrays/strings for missing info; keep valid JSON.";

// ───────────────────────── AI 单词形态检查（flash 轻量） ─────────────────────────

/// 单词形态检查结果 kind：
/// - word         输入本身是有效单词（词头/原型或独立派生词），直接走释义
/// - inflected    输入是变形/屈折形式（过去式、三单、进行时、复数、比较级等），canonical 给原型
/// - abbreviation 输入是简写（截短词），canonical 给完整单词
/// - acronym      输入是首字母缩写，canonical 给规范全称
/// - not_a_word   不存在该单词（拼写错误/生造），canonical 为空
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WordCheckKind {
    Word,
    Inflected,
    Abbreviation,
    Acronym,
    NotAWord,
}

#[derive(Debug, Serialize)]
pub struct WordCheckResult {
    pub kind: WordCheckKind,
    /// 标准形式（变形词给原型、简写/缩写给完整形式；其余情况为空字符串）
    pub canonical: String,
    /// 简短中文说明（变形词仅写变化类型，如"动词过去式"）
    pub note: String,
}

const CHECK_WORD_SYSTEM_PROMPT: &str = r#"你是一位严谨的英语词汇审核助手。判断用户输入的词条属于哪种情况，严格只输出 JSON（不要代码块围栏、不要任何多余文字），结构如下：
{"kind": "word | inflected | abbreviation | acronym | not_a_word", "canonical": "标准形式（仅 inflected/abbreviation/acronym 填写，其余为空字符串）", "note": "不超过 20 字的中文说明"}

判定规则：
1. word：输入本身就是词典词头（原型），无法再还原成另一个更基础的单词。包括独立派生词（加前后缀成新词、词典单独收录的，如 happiness、unbreakable、worker、quickly、friendly）与真实专有名词。canonical 空，note 空字符串。
2. inflected（变形/屈折形式，词库应收录其原型）：输入是由某个原型按语法规则变化而来的形式，必须给出原型。例如：
   - 动词过去式/过去分词：went→go、ran→run、done→do、built→build、studied→study
   - 第三人称单数：works→work、goes→go、studies→study、has→have
   - 现在分词/动名词：running→run、making→make、writing→write
   - 名词复数：children→child、mice→mouse、photos→photo、babies→baby、feet→foot
   - 比较级/最高级：better→good、best→good、easier→easy、bigger→big
   canonical 填原型 lemma（全小写，保留其标准拼写），note 仅写变化类型短语（如"动词过去式""名词复数""第三人称单数"）。
3. abbreviation（简写，单词被截短）：如 lab→laboratory、ad→advertisement、flu→influenza、phone→telephone、exam→examination、fridge→refrigerator。canonical 填完整单词（全小写）。
4. acronym（首字母缩写）：如 UN→United Nations、AI→Artificial Intelligence、ASAP→as soon as possible、NASA→National Aeronautics and Space Administration。canonical 填规范全称。
5. not_a_word：拼写错误、无意义字符、明显不是英文单词（如 asdf、hqwe、拼错的单词）。canonical 空，note 提示用户检查拼写。
6. 区分派生词与变形词：仅因语法屈折变化的（works、running、mice、better、went）判 inflected；独立派生词（happiness、worker、quickly）判 word。无法确定时优先判定为 word，不要误伤生僻但真实存在的单词。
用户词条: {{WORD}}"#;

/// 用 AI 判断单词形态（模型由前端传入，DeepSeek 服务商下取轻量模型，避免硬编码过时模型名）：
/// 完整单词 / 变形词（还原原型）/ 简写 / 缩写 / 不存在。
///
/// 供「DeepSeek 翻译」在生成完整学习卡片前调用：变形词返回原型，简写与缩写返回完整原词，
/// 不存在时提示"没有这个单词"。检查失败不会阻断后续释义流程（由前端降级）。
#[tauri::command]
pub async fn check_word_ai(args: ExplainWordArgs) -> Result<WordCheckResult, AppError> {
    let word = args.word.trim().to_lowercase();
    if word.is_empty() {
        return Err(AppError::Validation("单词不能为空".to_string()));
    }
    if args.endpoint.trim().is_empty() || args.model.trim().is_empty() {
        return Err(AppError::Business(
            "未配置 AI 服务（端点/模型为空），请先在设置中完成 AI 配置".to_string(),
        ));
    }
    let api_key = args.api_key.clone().unwrap_or_default().trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::Business(
            "未配置 API Key，无法调用 AI 检查单词".to_string(),
        ));
    }

    let endpoint = args.endpoint.trim_end_matches('/');
    crate::app_log!(
        "[vocab] AI 单词检查开始 word={word} endpoint={endpoint} model={} api_key_len={}",
        args.model,
        api_key.len()
    );
    let system = CHECK_WORD_SYSTEM_PROMPT.replace("{{WORD}}", &word);

    // 注册取消令牌：对话框关闭时前端调 dict_ai_cancel 即刻断流（覆盖两次重试全程）
    let cancel = CancelGuard(register_cancel_token());

    // 总超时兜底：单次尝试最长 45s（无进度超时）× 3 次传输重试 × 2 次解析重试，
    // 叠加可达数分钟；轻量检查任务不该让用户等那么久。
    const TOTAL_TIMEOUT_SECS: u64 = 90;
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(TOTAL_TIMEOUT_SECS),
        async {
            let mut last_error = String::new();
            for attempt in 0..2usize {
                // 检查是轻量任务，输出上限给小额度即可（flash 快且省）
                let max_tokens = if attempt == 0 { 512 } else { 1024 };
                let mut body = explain_request_body(
                    &args.model,
                    &system,
                    &word,
                    0.0,
                    max_tokens,
                    attempt == 1,
                    args.thinking_enabled,
                );
                body["stream"] = serde_json::json!(true);
                let chat = request_chat_stream_text(
                    "单词形态检查",
                    endpoint,
                    &api_key,
                    &word,
                    &body,
                    &cancel.0,
                )
                .await?;
                match parse_word_check(&word, &chat.text) {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        last_error = format!("{e}");
                        crate::app_log_error!(
                            "[vocab] AI 单词检查解析失败 word={word} attempt={} err={} 原始内容: {}",
                            attempt + 1,
                            e,
                            snippet_err(&chat.text)
                        );
                        if attempt == 0 {
                            crate::app_log!("[vocab] AI 单词检查自动重试（强制 JSON）word={word}");
                            continue;
                        }
                    }
                }
            }
            Err(AppError::Business(format!(
                "AI 单词检查失败（已自动重试一次）：{last_error}"
            )))
        },
    )
    .await;
    match outcome {
        Ok(r) => r,
        Err(_) => Err(AppError::Http(format!(
            "AI 单词检查超时（{TOTAL_TIMEOUT_SECS} 秒，DeepSeek 服务可能拥堵无响应），请稍后重试"
        ))),
    }
}

/// 解析单词形态检查结果；未知 kind 一律按 word 放行，避免误伤真实单词
fn parse_word_check(word: &str, raw: &str) -> Result<WordCheckResult, AppError> {
    let payload = extract_json_payload(raw)?;

    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct RawCheck {
        kind: String,
        canonical: String,
        note: String,
    }
    let parsed: RawCheck = serde_json::from_str(payload)
        .map_err(|e| AppError::Business(format!("AI 单词检查结果解析失败: {e}")))?;

    let kind = match parsed.kind.trim().to_lowercase().as_str() {
        "inflected" | "inflection" => WordCheckKind::Inflected,
        "abbreviation" => WordCheckKind::Abbreviation,
        "acronym" => WordCheckKind::Acronym,
        "not_a_word" | "notaword" | "not a word" => WordCheckKind::NotAWord,
        _ => WordCheckKind::Word,
    };
    let canonical = parsed.canonical.trim().to_string();
    let note = parsed.note.trim().to_string();
    crate::app_log!(
        "[vocab] AI 单词检查结果 word={word} kind={} canonical={canonical} note={note}",
        match kind {
            WordCheckKind::Word => "word",
            WordCheckKind::Inflected => "inflected",
            WordCheckKind::Abbreviation => "abbreviation",
            WordCheckKind::Acronym => "acronym",
            WordCheckKind::NotAWord => "not_a_word",
        }
    );
    Ok(WordCheckResult {
        kind,
        canonical,
        note,
    })
}

/// 一次聊天补全返回的最终回答
#[derive(Debug)]
struct ChatContent {
    text: String,
    finish_reason: String,
}

/// 用 AI（DeepSeek 等 OpenAI 兼容接口）生成单词释义
///
/// 模型偶尔会输出不完整的 JSON（输出被截断 / 附带说明文字），此时自动重试一次：
/// 第二次请求强制 `json_object` 输出并把输出上限放宽到 8192；仍失败则返回原始
/// 内容头尾片段便于排查。
#[tauri::command]
pub async fn dict_explain_ai(args: ExplainWordArgs) -> Result<AiWordExplain, AppError> {
    let word = args.word.trim();
    if word.is_empty() {
        return Err(AppError::Validation("单词不能为空".to_string()));
    }
    if args.endpoint.trim().is_empty() || args.model.trim().is_empty() {
        return Err(AppError::Business(
            "未配置 AI 服务（端点/模型为空），请先在设置中完成 AI 配置".to_string(),
        ));
    }
    let api_key = args.api_key.clone().unwrap_or_default().trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::Business(
            "未配置 API Key，无法调用 AI 生成释义".to_string(),
        ));
    }

    let endpoint = args.endpoint.trim_end_matches('/');
    crate::app_log!(
        "[vocab] AI 释义开始 word={word} endpoint={endpoint} model={} api_key_len={}",
        args.model,
        api_key.len()
    );

    let is_zh = args.lang.as_deref().unwrap_or("zh") == "zh";
    let system = if is_zh {
        EXPLAIN_SYSTEM_PROMPT_ZH
    } else {
        EXPLAIN_SYSTEM_PROMPT_EN
    }
    .replace("{{WORD}}", word);
    let temperature = args.temperature.unwrap_or(0.3);

    // 注册取消令牌：对话框关闭时前端调 dict_ai_cancel 即刻断流（覆盖两次重试全程）
    let cancel = CancelGuard(register_cancel_token());

    // 两次尝试：① 常规请求（输出上限 4096）；② 失败后强制 json_object + 上限 8192
    let mut last_error = String::new();
    let mut last_tail = String::new();
    let mut last_raw = String::new();
    for attempt in 0..2usize {
        let max_tokens = if attempt == 0 { 4096 } else { 8192 };
        let mut body = explain_request_body(
            &args.model,
            &system,
            word,
            temperature,
            max_tokens,
            attempt == 1,
            args.thinking_enabled,
        );
        // 同形态检查：走流式读体（传输中断不丢已收内容，详见 request_chat_stream_text）
        body["stream"] = serde_json::json!(true);
        let chat = request_chat_stream_text("释义", endpoint, &api_key, word, &body, &cancel.0).await?;
        match parse_explain(word, &chat.text) {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_error = format!("{e}");
                last_tail = snippet_err_tail(&chat.text);
                last_raw = chat.text;
                if chat.finish_reason == "length" {
                    last_error.push_str("（模型输出在达到长度上限时被截断）");
                }
                crate::app_log_error!(
                    "[vocab] AI 释义内容解析失败 word={word} attempt={} finish_reason={} err={}\n头部: {}\n尾部: {}",
                    attempt + 1,
                    chat.finish_reason,
                    e,
                    snippet_err(&last_raw),
                    last_tail
                );
                if attempt == 0 {
                    crate::app_log!(
                        "[vocab] AI 释义自动重试（强制 JSON + 扩大输出上限）word={word}"
                    );
                    continue;
                }
            }
        }
    }
    Err(AppError::Business(format!(
        "AI 返回内容无法解析（已自动重试一次）：{last_error}\n原始内容头部：{}\n原始内容尾部：{last_tail}",
        snippet_err(&last_raw)
    )))
}

// ───────────────────────── 流式释义（NDJSON 增量渲染） ─────────────────────────

/// 流式释义事件名：前端 `listen` 后按行增量渲染学习卡片
pub const DICT_EXPLAIN_EVENT: &str = "dict-explain-chunk";

/// 流式释义系统提示（中文）：要求模型按固定顺序逐行输出，每行一个独立 JSON 对象
/// （NDJSON）。之所以不沿用「整体一个大 JSON」，是因为整段解析必须等最后一个 `}`
/// 才可能成功——那正是用户面对全程白屏的根因；逐行对象可让音标/释义/例句在生成
/// 过程中即时上屏。
const EXPLAIN_STREAM_SYSTEM_PROMPT_ZH: &str = r#"你是一位专业英语词典编纂者，精通词源学与词汇记忆法。请为英文单词 {{WORD}} 生成一份"便于理解与记忆"的完整词典学习条目。

【输出格式】不要数组括号、不要代码块围栏、不要任何多余文字；**每一行恰好是一个独立 JSON 对象**（NDJSON），行与行之间用换行分隔，行尾不要逗号。按下列顺序逐行输出：

1. 音标（必须有且只有一行）：{"type":"phonetic","text":"英式音标，放在 / 斜杠中，如 /ˈwɜːd/"}
2. 词性释义（按使用频率排序，每条一行）：{"type":"meaning","pos":"词性缩写，如 n. / v. / adj. / adv.","def":"精炼准确的中文释义"}
3. 记忆例句（一行）：{"type":"example","text":"一句最常用、最利于记忆的完整英文例句","translation":"该例句的中文翻译"}
4. 词根词缀（有则逐条一行）：{"type":"morph","kind":"prefix 或 root 或 suffix","part":"词缀片段，如 un- / -able / -ion","meaning":"该部分的中文含义"}
5. 近义词（逐条一行，2~5 条）：{"type":"synonym","text":"近义词（可附简短中文注，如 happy（高兴的））"}
6. 反义词（逐条一行，2~5 条）：{"type":"antonym","text":"反义词（英文）"}
7. 常用词组（逐条一行，2~4 条）：{"type":"phrase","phrase":"英文常用词组/搭配","meaning":"中文释义"}
8. 动词变形（仅动词词条，逐条一行）：{"type":"verbForm","text":"第三人称单数: works"}
9. 按词性例句（每个主要词性一行）：{"type":"exampleByPos","pos":"词性","sentence":"该词性下一句自然、贴近生活的完整英文例句","translation":"例句中文翻译"}

【规则】
1. **字段分离**：pos 字段只能放词性缩写，释义必须放进 def，不要把释义写进 pos。正确示例：{"type":"meaning","pos":"n.","def":"来源；出处"}。
2. 音标一律采用英式（BrE）读音标注；拿不准也不要编造，宁缺毋滥。
3. morph 分析真实构词：有前缀/后缀就分别列出，词根给出核心含义；简单词无法可靠拆分时 kind 用 root 给出核心含义即可。
4. synonym / antonym 只给真正贴切的，不要硬凑。
5. 词条含动词词性时必给 verbForm（第三人称单数/现在分词/过去式/过去分词，不规则动词务必准确）；否则不输出该类行。
6. exampleByPos 的语境要能体现各词性的用法差异。
7. 没有的信息直接省略该类行，不要输出空行或空对象占位。
8. 每一行都必须是合法 JSON：键与值用双引号，行尾不要逗号。"#;

/// 流式释义系统提示（英文）
const EXPLAIN_STREAM_SYSTEM_PROMPT_EN: &str = r#"You are a professional English lexicographer skilled in etymology. Given the English word {{WORD}}, produce a dictionary entry as NEWLINE-DELIMITED JSON (NDJSON): no array brackets, no code fences, no extra text. Output exactly one JSON object per line, no trailing commas, in this order:
{"type":"phonetic","text":"BrE IPA with slashes"}
{"type":"meaning","pos":"pos tag like n. / v. / adj.","def":"concise English definition"}
{"type":"example","text":"one natural example sentence","translation":"Chinese translation of the example"}
{"type":"morph","kind":"prefix|root|suffix","part":"affix string like un- / -able","meaning":"brief meaning"}
{"type":"synonym","text":"..."}
{"type":"antonym","text":"..."}
{"type":"phrase","phrase":"common collocation","meaning":"brief gloss"}
{"type":"verbForm","text":"third-person singular: works"}
{"type":"exampleByPos","pos":"pos tag","sentence":"natural full sentence for that sense","translation":"Chinese translation"}
Repeat meaning / morph / synonym / antonym / phrase / verbForm / exampleByPos lines as needed; omit any category that does not apply (never emit empty lines). Keep every line valid JSON."#;

/// 流式释义事件载荷
///
/// - `delta`：本次新增的原始文本（供 UI 显示生成进度）
/// - `line`：本次已完整输出且可解析的一行 NDJSON 对象，前端据此增量渲染
/// - `done`：流结束标记；`result` 在结束时带回完整释义（兼容 NDJSON 与整段 JSON）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictExplainChunk {
    pub word: String,
    pub delta: String,
    pub line: Option<serde_json::Value>,
    pub done: bool,
    pub error: Option<String>,
    pub result: Option<AiWordExplain>,
}

/// 推送一条流式释义事件（推送失败只记日志，不影响释义流程）
fn emit_explain_chunk(app: &AppHandle, payload: DictExplainChunk) {
    if let Err(e) = app.emit(DICT_EXPLAIN_EVENT, payload) {
        crate::app_log_warn!("[vocab] 流式释义事件推送失败: {e}");
    }
}

/// 逐行累加器：把 NDJSON 的每一行归位到最终 `AiWordExplain` 的各字段
#[derive(Default)]
struct NdjsonAccumulator {
    phonetic: String,
    meanings: Vec<VocabMeaning>,
    example: String,
    example_zh: String,
    morphology: Vec<VocabMorphItem>,
    synonyms: Vec<String>,
    antonyms: Vec<String>,
    phrases: Vec<VocabPhrase>,
    verb_forms: Vec<String>,
    examples: Vec<VocabSentence>,
}

/// 取 JSON 对象的字符串字段并去空白（缺字段/类型不符时按空串处理）。
/// 键名匹配大小写不敏感——模型偶发输出 `"Type"` / `"Def"` 等漂移写法时仍可归位。
fn json_str(v: &serde_json::Value, key: &str) -> String {
    let raw = v
        .get(key)
        .and_then(|x| x.as_str())
        .or_else(|| {
            v.as_object().and_then(|o| {
                o.iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                    .and_then(|(_, val)| val.as_str())
            })
        })
        .unwrap_or_default();
    raw.trim().to_string()
}

/// 把 `type` 字段统一为小写，降低模型大小写漂移对前端分支的影响
fn normalize_line(v: &serde_json::Value) -> serde_json::Value {
    let mut out = v.clone();
    if let Some(ty) = v.get("type").and_then(|t| t.as_str()) {
        out["type"] = serde_json::Value::String(ty.trim().to_lowercase());
    }
    out
}

impl NdjsonAccumulator {
    /// 归位一行；返回 false 表示该行不是已知类型（忽略）
    fn apply(&mut self, v: &serde_json::Value) -> bool {
        let ty = json_str(v, "type").to_lowercase();
        match ty.as_str() {
            "phonetic" => {
                self.phonetic = json_str(v, "text");
                true
            }
            "meaning" => {
                let (pos, def) = split_pos_def(&json_str(v, "pos"), &json_str(v, "def"));
                if !def.is_empty() {
                    self.meanings.push(VocabMeaning { pos, def });
                }
                true
            }
            "example" => {
                self.example = json_str(v, "text");
                self.example_zh = json_str(v, "translation");
                true
            }
            "morph" => {
                let part = json_str(v, "part");
                if !part.is_empty() {
                    self.morphology.push(VocabMorphItem {
                        kind: json_str(v, "kind"),
                        part,
                        meaning: json_str(v, "meaning"),
                    });
                }
                true
            }
            "synonym" => {
                let t = json_str(v, "text");
                if !t.is_empty() {
                    self.synonyms.push(t);
                }
                true
            }
            "antonym" => {
                let t = json_str(v, "text");
                if !t.is_empty() {
                    self.antonyms.push(t);
                }
                true
            }
            "phrase" => {
                let p = json_str(v, "phrase");
                if !p.is_empty() {
                    self.phrases.push(VocabPhrase {
                        phrase: p,
                        meaning: json_str(v, "meaning"),
                    });
                }
                true
            }
            "verbform" => {
                let t = json_str(v, "text");
                if !t.is_empty() {
                    self.verb_forms.push(t);
                }
                true
            }
            "examplebypos" => {
                let s = json_str(v, "sentence");
                if !s.is_empty() {
                    self.examples.push(VocabSentence {
                        pos: json_str(v, "pos"),
                        sentence: s,
                        translation: json_str(v, "translation"),
                    });
                }
                true
            }
            _ => false,
        }
    }

    /// 组装为 `AiWordExplain`；无有效释义（模型未按 NDJSON 输出）时返回 None，
    /// 交由调用方回退到整段 JSON 解析——保证流式路径不会比原同步路径更差。
    fn into_explain(self) -> Option<AiWordExplain> {
        if self.meanings.is_empty() {
            return None;
        }
        Some(AiWordExplain {
            phonetic: self.phonetic,
            meanings: self.meanings,
            example: self.example,
            example_zh: self.example_zh,
            knowledge: VocabKnowledge {
                morphology: self.morphology,
                synonyms: self.synonyms,
                antonyms: self.antonyms,
                phrases: self.phrases,
                verb_forms: self.verb_forms,
                examples: self.examples,
            },
        })
    }
}

/// 解析单行 NDJSON 对象：剥掉代码块围栏、数组括号与行尾逗号等噪声；
/// 解析失败返回 None（该行被忽略，不影响其它行）。
///
/// 注意：整段 pretty-print 的单对象 JSON（如 `"phonetic": "...",`）不会命中此函数，
/// 这正是期望行为——它由结尾的整段 `parse_explain` 兜底。
fn parse_ndjson_object(line: &str) -> Option<serde_json::Value> {
    let mut s = line.trim();
    if s.is_empty() || s.starts_with("```") {
        return None;
    }
    while let Some(rest) = s.strip_prefix('[') {
        s = rest.trim_start();
    }
    while let Some(rest) = s.strip_suffix(']') {
        s = rest.trim_end();
    }
    s = s.trim_end_matches(',').trim_end();
    if !s.starts_with('{') || !s.ends_with('}') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(s)
        .ok()
        .filter(|v| v.is_object())
}

/// 处理一条内容行：解析成功则归一化、累加并推送增量事件；返回是否命中
fn handle_content_line(
    app: &AppHandle,
    word: &str,
    acc: &mut NdjsonAccumulator,
    line: &str,
) -> bool {
    let Some(v) = parse_ndjson_object(line) else {
        return false;
    };
    let v = normalize_line(&v);
    if !acc.apply(&v) {
        return false;
    }
    emit_explain_chunk(
        app,
        DictExplainChunk {
            word: word.to_string(),
            delta: String::new(),
            line: Some(v),
            done: false,
            error: None,
            result: None,
        },
    );
    true
}

/// 流结束后的收尾：刷出最后一行（无换行结尾）、组装结果并推送 done 事件。
/// `warning` 用于「连接中断但已保留部分内容」的降级提示。
fn finish_explain_stream(
    app: &AppHandle,
    word: &str,
    mut acc: NdjsonAccumulator,
    content_tail: &str,
    full: &str,
    warning: Option<String>,
) -> Result<AiWordExplain, AppError> {
    let tail = content_tail.trim();
    if !tail.is_empty() {
        if let Some(v) = parse_ndjson_object(tail) {
            let v = normalize_line(&v);
            acc.apply(&v);
        }
    }
    // 优先用逐行结果；模型未按 NDJSON 输出时回退到整段 JSON 解析（与同步路径同构）
    let parsed = match acc.into_explain() {
        Some(v) => Ok(v),
        None => parse_explain(word, full),
    };
    match parsed {
        Ok(explain) => {
            if let Some(w) = warning.as_deref() {
                crate::app_log_warn!("[vocab] 流式释义降级完成 word={word}: {w}");
            }
            emit_explain_chunk(
                app,
                DictExplainChunk {
                    word: word.to_string(),
                    delta: String::new(),
                    line: None,
                    done: true,
                    error: warning,
                    result: Some(explain.clone()),
                },
            );
            Ok(explain)
        }
        Err(e) => Err(e),
    }
}

/// AI 流式释义（SSE + NDJSON 逐行增量渲染）
///
/// 与 `dict_explain_ai` 的差别仅在传输与解析方式：请求体 `stream: true`，边收边把
/// **已完整的行**推送为 `dict-explain-chunk` 事件（payload 的 `line` 为该行解析结果），
/// 让音标/释义/例句在生成过程中即时上屏；结束时无论模型输出的是 NDJSON 还是整体 JSON，
/// 都组装出与同步路径完全一致的 `AiWordExplain` 并作为命令返回值。
#[tauri::command]
pub async fn dict_explain_stream(
    app: AppHandle,
    args: ExplainWordArgs,
) -> Result<AiWordExplain, AppError> {
    let word = args.word.trim().to_string();
    if word.is_empty() {
        return Err(AppError::Validation("单词不能为空".to_string()));
    }
    if args.endpoint.trim().is_empty() || args.model.trim().is_empty() {
        return Err(AppError::Business(
            "未配置 AI 服务（端点/模型为空），请先在设置中完成 AI 配置".to_string(),
        ));
    }
    let api_key = args.api_key.clone().unwrap_or_default().trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::Business(
            "未配置 API Key，无法调用 AI 生成释义".to_string(),
        ));
    }

    let endpoint = args.endpoint.trim_end_matches('/').to_string();
    crate::app_log!(
        "[vocab] 流式释义开始 word={word} endpoint={endpoint} model={} api_key_len={}",
        args.model,
        api_key.len()
    );

    let is_zh = args.lang.as_deref().unwrap_or("zh") == "zh";
    let system = if is_zh {
        EXPLAIN_STREAM_SYSTEM_PROMPT_ZH
    } else {
        EXPLAIN_STREAM_SYSTEM_PROMPT_EN
    }
    .replace("{{WORD}}", &word);
    let temperature = args.temperature.unwrap_or(0.3);

    // 复用同步路径的请求体构造（force_json=false，避免 json_object 与 NDJSON 冲突），
    // 再打开流式开关。
    let mut body = explain_request_body(
        &args.model,
        &system,
        &word,
        temperature,
        4096,
        false,
        args.thinking_enabled,
    );
    body["stream"] = serde_json::json!(true);

    // 注册取消令牌：对话框关闭时前端调 dict_ai_cancel 即刻断流
    // （RAII 保证正常结束 / 超时被丢弃 / 出错提前返回都会注销）
    let cancel = CancelGuard(register_cancel_token());

    let started = std::time::Instant::now();
    const TOTAL_TIMEOUT_SECS: u64 = 300;
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(TOTAL_TIMEOUT_SECS),
        stream_explain_sse(&app, &endpoint, &api_key, &word, &body, &cancel.0),
    )
    .await;

    let result = match outcome {
        Ok(r) => r,
        Err(_) => Err(AppError::Business(format!(
            "AI 流式响应超时（超过 {TOTAL_TIMEOUT_SECS} 秒未完成），请检查网络后重试"
        ))),
    };
    match &result {
        Ok(explain) => crate::app_log!(
            "[vocab] 流式释义完成 word={word} 耗时={}ms meanings={} 音标={} 词性例句={}",
            started.elapsed().as_millis(),
            explain.meanings.len(),
            if explain.phonetic.is_empty() { "无" } else { "有" },
            explain.knowledge.examples.len()
        ),
        Err(e) => crate::app_log_error!(
            "[vocab] 流式释义失败 word={word} 耗时={}ms err={e}",
            started.elapsed().as_millis()
        ),
    }
    result
}

/// 流式释义的 SSE 主循环
async fn stream_explain_sse(
    app: &AppHandle,
    endpoint: &str,
    api_key: &str,
    word: &str,
    body: &serde_json::Value,
    cancel: &CancelToken,
) -> Result<AiWordExplain, AppError> {
    /// 「无内容进度」超时：仅当收到新生成内容（delta）才刷新计时。
    /// 服务端故障时可能只发 SSE 心跳注释行（`: keep-alive`）而永不产出内容——
    /// 单帧超时会被心跳无限续期，必须以「内容进度」为计时基准。
    const NO_PROGRESS_SECS: u64 = 60;
    /// 未形成完整行时的进度事件节流阈值（字符数）：避免逐 token 推送拖垮前端
    const PROGRESS_FLUSH_CHARS: usize = 120;

    if cancel.is_cancelled() {
        return Err(cancelled_error());
    }
    let client = get_sse_client().clone();
    let response = client
        .post(format!("{endpoint}/chat/completions"))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(body)
        .send()
        .await
        .map_err(|e| AppError::Http(format!("AI 请求失败: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let hint = match status.as_u16() {
            401 | 403 => "（可能是 API Key 无效或已过期，请检查 设置 → AI 设置）",
            402 | 429 => "（可能是账户余额不足或触发限流，请检查 DeepSeek 账户）",
            _ => "",
        };
        return Err(AppError::Http(format!(
            "AI 服务返回错误（HTTP {status}）: {}{hint}",
            snippet_err(&text)
        )));
    }

    // 部分网关/代理会忽略 `stream: true` 而返回普通 JSON——此时按非流式解析，
    // 保证「流式不可用」不会变成「功能不可用」。
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("event-stream"))
        .unwrap_or(false);
    if !is_sse {
        let raw = response
            .text()
            .await
            .map_err(|e| AppError::Http(format!("读取 AI 响应失败: {e}")))?;
        crate::app_log!("[vocab] 流式释义降级为整体响应（非 SSE）word={word}");
        return finish_non_sse_response(app, word, &raw);
    }

    let mut stream = response.bytes_stream();
    let mut sse_buf = String::new();
    let mut acc = NdjsonAccumulator::default();
    let mut full = String::new();
    let mut content_buf = String::new();
    let mut pending_chars = 0usize;
    let mut warning: Option<String> = None;
    let no_progress = std::time::Duration::from_secs(NO_PROGRESS_SECS);
    let mut deadline = tokio::time::Instant::now() + no_progress;

    'stream: loop {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let chunk = tokio::select! {
            // 用户取消：即刻断流，不等下一帧或空闲超时
            _ = cancel.notified() => {
                return Err(cancelled_error());
            }
            // 无内容进度超时：心跳注释行不刷新计时，服务端「连着但不出活」时在此止损
            _ = tokio::time::sleep_until(deadline) => {
                warning = Some(format!(
                    "AI 服务响应超时（{NO_PROGRESS_SECS} 秒未收到生成内容，连接可能仅剩心跳），已保留已生成的内容"
                ));
                break 'stream;
            }
            r = stream.next() => match r {
                Some(Ok(c)) => c,
                Some(Err(e)) => {
                    warning = Some(format!("AI 服务连接中断，已保留已生成的内容（{e}）"));
                    break 'stream;
                }
                None => break 'stream,
            },
        };

        let before_len = full.len();
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = sse_buf.find('\n') {
            let line = sse_buf[..pos].trim().to_string();
            sse_buf.drain(..=pos);
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let payload = line[5..].trim();
            if payload == "[DONE]" {
                break 'stream;
            }
            let Ok(data) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            let Some(delta) = data
                .pointer("/choices/0/delta/content")
                .and_then(|v| v.as_str())
            else {
                continue;
            };
            if delta.is_empty() {
                continue;
            }

            full.push_str(delta);
            content_buf.push_str(delta);
            pending_chars += delta.chars().count();

            let mut emitted = false;
            while let Some(p) = content_buf.find('\n') {
                let content_line = content_buf[..p].to_string();
                content_buf.drain(..=p);
                if handle_content_line(app, word, &mut acc, &content_line) {
                    emitted = true;
                }
            }
            if emitted {
                pending_chars = 0;
            } else if pending_chars >= PROGRESS_FLUSH_CHARS {
                emit_explain_chunk(
                    app,
                    DictExplainChunk {
                        word: word.to_string(),
                        delta: delta.to_string(),
                        line: None,
                        done: false,
                        error: None,
                        result: None,
                    },
                );
                pending_chars = 0;
            }
        }
        // 收到新生成内容才刷新「无进度」计时；纯心跳 / 注释行不刷新
        if full.len() > before_len {
            deadline = tokio::time::Instant::now() + no_progress;
        }
    }

    crate::app_log!(
        "[vocab] 流式释义流结束 word={word} 全文={} 字节 已归位释义={} 条 结果={}",
        full.len(),
        acc.meanings.len(),
        if warning.is_none() { "正常" } else { "降级" }
    );

    finish_explain_stream(app, word, acc, &content_buf, &full, warning)
}

/// 非 SSE（网关忽略 `stream: true`）时的兜底：按整体 JSON 响应解析，
/// 先尝试 NDJSON 组装（部分网关虽不流式但仍遵守提示），否则走整段 JSON 解析。
fn finish_non_sse_response(
    app: &AppHandle,
    word: &str,
    raw: &str,
) -> Result<AiWordExplain, AppError> {
    let json: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        AppError::Http(format!(
            "解析 AI 响应失败: {e}（原始内容片段: {}）",
            snippet_err(raw)
        ))
    })?;
    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() {
        return Err(AppError::Business(
            "AI 返回内容为空（模型可能只输出了思考过程），请重试".to_string(),
        ));
    }
    let mut acc = NdjsonAccumulator::default();
    for line in content.lines() {
        if let Some(v) = parse_ndjson_object(line) {
            let v = normalize_line(&v);
            acc.apply(&v);
        }
    }
    finish_explain_stream(app, word, acc, "", &content, None)
}

/// 构造释义 / 形态检查请求体
///
/// `thinking_enabled`：`Some(false)` 时下发 `thinking: { type: "disabled" }` 显式关闭思考模式
/// —— 词典任务是结构化的短输出任务，思考 token 既挤占 `max_tokens` 预算（易触发截断重试，
/// 等于耗时翻倍），又显著拉长首字延迟。
fn explain_request_body(
    model: &str,
    system: &str,
    word: &str,
    temperature: f64,
    max_tokens: u32,
    force_json: bool,
    thinking_enabled: Option<bool>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("请解释单词: {word}") }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": false
    });
    if force_json {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    if let Some(enabled) = thinking_enabled {
        body["thinking"] = serde_json::json!({
            "type": if enabled { "enabled" } else { "disabled" }
        });
    }
    body
}

/// 以 SSE 流式方式请求一次聊天补全，边收边累积模型输出的纯文本（含 finish_reason）。
///
/// 与一次性读完整响应体（`BodyExt::collect`）的关键差别：非流式下一旦「响应头已
/// 到达、正文在传输途中被中断」，reqwest 会把已收到的字节全部丢弃并只报
/// `error decoding response body`（`Kind::Decode`——`bytes()`/`chunk()` 均
/// `map_err(error::decode)`），表现为硬失败；流式按块消费，**已到达的内容不会因后续
/// 断流而丢失**。故「中途断流但有内容」降级为正常返回（warn 记录原因，`{:?}` 展开
/// reqwest source 链给出 hyper 真实中断原因），「断流且无内容」才换连接重试
/// （退避 1s / 2s，共 3 次尝试）；HTTP 状态错误、请求超时与用户取消不重试。
async fn request_chat_stream_text(
    label: &str,
    endpoint: &str,
    api_key: &str,
    word: &str,
    body: &serde_json::Value,
    cancel: &CancelToken,
) -> Result<ChatContent, AppError> {
    /// 「无内容进度」超时：仅收到新生成内容才刷新计时（心跳免疫）
    const NO_PROGRESS_SECS: u64 = 45;
    const MAX_ATTEMPTS: usize = 3;

    let mut last_error = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        match request_chat_stream_once(
            label,
            endpoint,
            api_key,
            word,
            body,
            cancel,
            NO_PROGRESS_SECS,
        )
        .await
        {
            Ok(v) => return Ok(v),
            Err(StreamFail::Fatal(e)) => return Err(e),
            Err(StreamFail::Retryable(reason)) => {
                last_error = reason;
                if attempt + 1 < MAX_ATTEMPTS {
                    let delay_ms = 1000 * 2u64.pow(attempt as u32);
                    crate::app_log_warn!(
                        "[vocab] AI {label} 传输失败，第 {} 次重试（{delay_ms}ms 后）word={word}: {last_error}",
                        attempt + 2
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }
    Err(AppError::Http(format!(
        "AI 响应多次中断（已重试 {MAX_ATTEMPTS} 次），请检查网络后重试；最后一次错误: {last_error}"
    )))
}

/// 单次流式尝试的失败分类
#[derive(Debug)]
enum StreamFail {
    /// 未收到任何内容的传输中断（发送失败 / 空转超时 / 断流无内容）——换连接重发可能恢复
    Retryable(String),
    /// HTTP 状态错误、请求超时、用户取消等——重试无意义，直接上抛
    Fatal(AppError),
}

async fn request_chat_stream_once(
    label: &str,
    endpoint: &str,
    api_key: &str,
    word: &str,
    body: &serde_json::Value,
    cancel: &CancelToken,
    no_progress_secs: u64,
) -> Result<ChatContent, StreamFail> {
    let started = std::time::Instant::now();
    let response = get_sse_client()
        .post(format!("{endpoint}/chat/completions"))
        .header("Accept", "text/event-stream")
        .bearer_auth(api_key)
        .json(body)
        .send()
        .await
        .map_err(|e| {
            crate::app_log_error!("[vocab] AI {label} 请求发送失败 word={word} err={e:?}");
            if e.is_timeout() {
                // 连接超时：重发只会再等满连接超时，直接报错
                StreamFail::Fatal(AppError::Http(format!("AI 请求超时: {e}")))
            } else {
                StreamFail::Retryable(format!("AI 请求失败: {e}"))
            }
        })?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        crate::app_log_error!(
            "[vocab] AI {label} 失败 word={word} status={status} 耗时={}ms body={}",
            started.elapsed().as_millis(),
            snippet_err(&text)
        );
        let hint = match status.as_u16() {
            401 | 403 => "（可能是 API Key 无效或已过期，请检查 设置 → AI 设置）",
            402 | 429 => "（可能是账户余额不足或触发限流，请检查 DeepSeek 账户）",
            400 => {
                let low = text.to_lowercase();
                if low.contains("model") || low.contains("not exist") || low.contains("invalid") {
                    "（可能是所选模型不存在或不可用，请到 设置 → AI 设置 更换对话模型）"
                } else {
                    ""
                }
            }
            _ => "",
        };
        return Err(StreamFail::Fatal(AppError::Http(format!(
            "AI 服务返回错误（HTTP {status}）: {}{hint}",
            snippet_err(&text)
        ))));
    }

    // 网关忽略 `stream: true` 而直接返回整体 JSON 时按整体解析（与流式释义一致）
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("event-stream"))
        .unwrap_or(false);
    if !is_sse {
        let raw = response
            .text()
            .await
            .map_err(|e| StreamFail::Retryable(format!("读取 AI 响应失败（未收到内容）: {e}")))?;
        crate::app_log!("[vocab] AI {label} 降级为整体响应（非 SSE）word={word}");
        return Ok(chat_content_from_json(&raw));
    }

    let mut stream = response.bytes_stream();
    let mut sse_buf = String::new();
    let mut content = String::new();
    let mut finish_reason = String::new();
    let mut interrupted: Option<String> = None;
    // 「无内容进度」超时：仅收到新生成内容（delta）才刷新计时。服务端故障时可能
    // 只发 SSE 心跳注释行（`: keep-alive`）而永不产出内容——单帧超时会被心跳
    // 无限续期，必须以「内容进度」为计时基准。
    let no_progress = std::time::Duration::from_secs(no_progress_secs);
    let mut deadline = tokio::time::Instant::now() + no_progress;

    'stream: loop {
        if cancel.is_cancelled() {
            return Err(StreamFail::Fatal(cancelled_error()));
        }
        let chunk = tokio::select! {
            // 用户取消：即刻断流，不等下一帧或空闲超时
            _ = cancel.notified() => {
                return Err(StreamFail::Fatal(cancelled_error()));
            }
            // 无内容进度超时：心跳注释行不刷新计时，服务端「连着但不出活」时在此止损
            _ = tokio::time::sleep_until(deadline) => {
                interrupted = Some(format!("{no_progress_secs} 秒未收到生成内容（连接可能仅剩心跳）"));
                break 'stream;
            }
            r = stream.next() => match r {
                Some(Ok(c)) => c,
                Some(Err(e)) => {
                    // `{:?}` 展开 source 链，给出 hyper 的真实中断原因
                    interrupted = Some(format!("{e:?}"));
                    break 'stream;
                }
                None => break 'stream,
            },
        };

        let mut progressed = false;
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = sse_buf.find('\n') {
            let line = sse_buf[..pos].trim().to_string();
            sse_buf.drain(..=pos);
            if !line.starts_with("data:") {
                continue;
            }
            let payload = line[5..].trim();
            if payload == "[DONE]" {
                break 'stream;
            }
            let Ok(data) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            if let Some(fr) = data.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()) {
                finish_reason = fr.to_string();
            }
            if let Some(delta) = data
                .pointer("/choices/0/delta/content")
                .and_then(|v| v.as_str())
            {
                if !delta.is_empty() {
                    content.push_str(delta);
                    progressed = true;
                }
            }
        }
        if progressed {
            deadline = tokio::time::Instant::now() + no_progress;
        }
    }

    let elapsed_ms = started.elapsed().as_millis();
    if content.trim().is_empty() {
        return Err(match interrupted {
            Some(reason) => {
                StreamFail::Retryable(format!("AI 响应被中断（未收到任何内容，{reason}）"))
            }
            None => StreamFail::Fatal(AppError::Business(
                "AI 返回内容为空（模型可能只输出了思考过程），请重试".to_string(),
            )),
        });
    }
    if let Some(reason) = interrupted {
        crate::app_log_warn!(
            "[vocab] AI {label} 流式中断但已保留内容 word={word} 耗时={elapsed_ms}ms 原因={reason}"
        );
    }
    crate::app_log!(
        "[vocab] AI {label} 流式响应 word={word} 耗时={elapsed_ms}ms content_bytes={} finish_reason={finish_reason}",
        content.len()
    );
    Ok(ChatContent {
        text: content,
        finish_reason,
    })
}

/// 从整体（非流式）聊天补全响应 JSON 中取出 content 与 finish_reason
fn chat_content_from_json(text: &str) -> ChatContent {
    let json = serde_json::from_str::<serde_json::Value>(text).ok();
    let pick = |path: &str| {
        json.as_ref()
            .and_then(|v| v.pointer(path))
            .and_then(|c| c.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    ChatContent {
        text: pick("/choices/0/message/content"),
        finish_reason: pick("/choices/0/finish_reason"),
    }
}

/// 提取错误响应摘要（截断避免日志过长）
fn snippet_err(text: &str) -> String {
    let cleaned: String = text.chars().filter(|&c| c != '\n' && c != '\r').collect();
    if cleaned.chars().count() <= 200 {
        cleaned
    } else {
        cleaned.chars().take(200).chain(['…']).collect()
    }
}

/// 提取文本尾部片段（用于观察截断 / 污染点）
fn snippet_err_tail(text: &str) -> String {
    let cleaned: String = text.chars().filter(|&c| c != '\n' && c != '\r').collect();
    if cleaned.chars().count() <= 160 {
        cleaned
    } else {
        cleaned
            .chars()
            .skip(cleaned.chars().count() - 160)
            .collect::<String>()
    }
}

/// 拆分混在 pos 里的 "n. 释义" 之类格式，并把释义补回 def
static POS_SPLIT_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

fn split_pos_def(pos: &str, def: &str) -> (String, String) {
    let def = def.trim();
    if !def.is_empty() {
        return (pos.trim().to_string(), def.to_string());
    }
    let re = POS_SPLIT_RE.get_or_init(|| {
        regex_lite::Regex::new(
            r"^(n|v|vt|vi|adj|adv|prep|conj|pron|art|aux|modal|num|int|det|abbr|phr|sentence)\.?\s*(.*)$",
        )
        .expect("pos split regex")
    });
    let pos = pos.trim();
    if let Some(caps) = re.captures(pos) {
        let p = format!("{}.", &caps[1]);
        let d = caps.get(2).map_or("", |m| m.as_str()).trim();
        return (p, d.to_string());
    }
    (pos.to_string(), String::new())
}

/// 从 AI 文本中提取 JSON 主体（兼容代码块围栏包裹、前后说明文字）
fn extract_json_payload(raw: &str) -> Result<&str, AppError> {
    let mut text = raw.trim();
    // 剥掉可能的 ```json ... ``` / ``` ... ``` 围栏（允许围栏前后有说明文字）
    if let Some(fence_start) = text.find("```") {
        let after_fence = &text[fence_start + 3..];
        let rest = match after_fence.find('\n') {
            Some(i) => after_fence[i + 1..].trim_start(),
            None => after_fence.trim_start(),
        };
        if let Some(end) = rest.rfind("```") {
            text = rest[..end].trim();
        } else {
            text = rest;
        }
    }
    // 定位第一个 { 到最后一个 }
    let open = text
        .find('{')
        .ok_or_else(|| AppError::Business("AI 返回内容不包含 JSON".to_string()))?;
    let close = text
        .rfind('}')
        .ok_or_else(|| AppError::Business("AI 返回内容不包含完整 JSON".to_string()))?;
    Ok(&text[open..=close])
}

/// 解析 AI 输出的 JSON（兼容代码块围栏包裹、前后说明文字）
fn parse_explain(word: &str, raw: &str) -> Result<AiWordExplain, AppError> {
    let payload = extract_json_payload(raw)?;

    #[derive(Deserialize, Default)]
    struct RawExplain {
        #[serde(default)]
        phonetic: String,
        #[serde(default)]
        meanings: Vec<RawMeaning>,
        #[serde(default)]
        example: String,
        #[serde(rename = "exampleZh", default)]
        example_zh: String,
        #[serde(default)]
        knowledge: Option<RawKnowledge>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct RawMeaning {
        pos: String,
        def: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct RawKnowledge {
        morphology: Vec<RawMorph>,
        synonyms: Vec<String>,
        antonyms: Vec<String>,
        phrases: Vec<RawPhrase>,
        verb_forms: Vec<String>,
        examples: Vec<RawSentence>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct RawMorph {
        kind: String,
        part: String,
        meaning: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct RawPhrase {
        phrase: String,
        meaning: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct RawSentence {
        pos: String,
        sentence: String,
        translation: String,
    }

    let parsed: RawExplain = serde_json::from_str(payload)
        .map_err(|e| AppError::Business(format!("AI 释义格式解析失败: {e}")))?;

    let raw_meanings = parsed.meanings;
    let raw_count = raw_meanings.len();
    let mut meanings: Vec<VocabMeaning> = Vec::new();
    for m in raw_meanings {
        let (pos, def) = split_pos_def(&m.pos, &m.def);
        if !def.is_empty() {
            meanings.push(VocabMeaning { pos, def });
        }
    }
    crate::app_log!(
        "[vocab] AI 释义拆分检查 word={word} raw_meanings_count={raw_count} final_meanings_count={}",
        meanings.len()
    );
    if meanings.is_empty() {
        return Err(AppError::Business(
            "AI 未返回有效释义，请重试或手动填写".to_string(),
        ));
    }

    let clean = |s: String| s.trim().to_string();
    let knowledge: VocabKnowledge = parsed
        .knowledge
        .map(|k| VocabKnowledge {
            morphology: k
                .morphology
                .into_iter()
                .filter(|m| !m.part.trim().is_empty())
                .map(|m| VocabMorphItem {
                    kind: clean(m.kind),
                    part: clean(m.part),
                    meaning: clean(m.meaning),
                })
                .collect(),
            synonyms: k
                .synonyms
                .into_iter()
                .map(clean)
                .filter(|s| !s.is_empty())
                .collect(),
            antonyms: k
                .antonyms
                .into_iter()
                .map(clean)
                .filter(|s| !s.is_empty())
                .collect(),
            phrases: k
                .phrases
                .into_iter()
                .filter(|p| !p.phrase.trim().is_empty())
                .map(|p| VocabPhrase {
                    phrase: clean(p.phrase),
                    meaning: clean(p.meaning),
                })
                .collect(),
            verb_forms: k
                .verb_forms
                .into_iter()
                .map(clean)
                .filter(|s| !s.is_empty())
                .collect(),
            examples: k
                .examples
                .into_iter()
                .filter(|e| !e.sentence.trim().is_empty())
                .map(|e| VocabSentence {
                    pos: clean(e.pos),
                    sentence: clean(e.sentence),
                    translation: clean(e.translation),
                })
                .collect(),
        })
        .unwrap_or_default();

    Ok(AiWordExplain {
        phonetic: parsed.phonetic,
        meanings,
        example: parsed.example,
        example_zh: parsed.example_zh,
        knowledge,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_all(ndjson: &str) -> NdjsonAccumulator {
        let mut acc = NdjsonAccumulator::default();
        for line in ndjson.lines() {
            if let Some(v) = parse_ndjson_object(line) {
                acc.apply(&normalize_line(&v));
            }
        }
        acc
    }

    /// 标准 NDJSON 输出能完整归位到各字段
    #[test]
    fn ndjson_assembles_full_entry() {
        let text = r#"{"type":"phonetic","text":"/ˈwɜːd/"}
{"type":"meaning","pos":"n.","def":"来源；出处"}
{"type":"meaning","pos":"v.","def":"源于；来自"}
{"type":"example","text":"The word comes from Latin.","translation":"这个词源自拉丁语。"}
{"type":"morph","kind":"prefix","part":"un-","meaning":"否定"}
{"type":"synonym","text":"origin（起源）"}
{"type":"antonym","text":"end"}
{"type":"phrase","phrase":"come from","meaning":"来自"}
{"type":"verbForm","text":"过去式: worded"}
{"type":"exampleByPos","pos":"n.","sentence":"It is a word.","translation":"它是一个词。"}"#;
        let acc = apply_all(text);
        assert_eq!(acc.meanings.len(), 2);
        let explain = acc.into_explain().expect("应有释义");
        assert_eq!(explain.phonetic, "/ˈwɜːd/");
        assert_eq!(explain.meanings[0].pos, "n.");
        assert_eq!(explain.example_zh, "这个词源自拉丁语。");
        assert_eq!(explain.knowledge.morphology.len(), 1);
        assert_eq!(explain.knowledge.synonyms, vec!["origin（起源）"]);
        assert_eq!(explain.knowledge.phrases[0].phrase, "come from");
        assert_eq!(explain.knowledge.verb_forms.len(), 1);
        assert_eq!(explain.knowledge.examples.len(), 1);
    }

    /// 容错：围栏行、数组括号、行尾逗号与大小写漂移都不影响解析
    #[test]
    fn ndjson_tolerates_noise() {
        let text = "```json\n[\n{\"Type\":\"Phonetic\",\"Text\":\"/w/\"},\n{\"type\":\"Meaning\",\"pos\":\"n. 来源\",\"def\":\"\"},\n]\n```";
        let acc = apply_all(text);
        let explain = acc.into_explain().expect("应能容错解析出释义");
        assert_eq!(explain.phonetic, "/w/");
        // pos 里夹带的释义被 split_pos_def 拆回 def
        assert_eq!(explain.meanings[0].pos, "n.");
        assert_eq!(explain.meanings[0].def, "来源");
    }

    /// 无有效释义行时返回 None（交由整段 JSON 兜底），而非产出空卡片
    #[test]
    fn ndjson_requires_meanings() {
        let acc = apply_all(r#"{"type":"phonetic","text":"/w/"}"#);
        assert!(acc.into_explain().is_none());
    }

    /// 整段 pretty-print 的单对象 JSON 不会被误判为 NDJSON 行
    #[test]
    fn pretty_printed_object_is_not_a_ndjson_line() {
        for line in ["{", "  \"phonetic\": \"/w/\",", "  \"meanings\": [],", "}"] {
            assert!(parse_ndjson_object(line).is_none(), "不应命中: {line}");
        }
    }

    /// 单行完整对象仍是合法 NDJSON 行（但无 type，不能独立成卡片）
    #[test]
    fn single_line_object_parses_but_yields_no_entry() {
        let v = parse_ndjson_object(r#"{"phonetic":"/w/","meanings":[{"pos":"n.","def":"词"}]}"#);
        assert!(v.is_some());
        let mut acc = NdjsonAccumulator::default();
        assert!(!acc.apply(&v.unwrap()));
        assert!(acc.into_explain().is_none());
    }

    // ── 流式传输层端到端：本地 mini HTTP/SSE 服务器 + 真实全局 SSE 客户端 ──
    // 覆盖 request_chat_stream_once / request_chat_stream_text 的完整链路
    // （SSE 分帧解析、[DONE]、finish_reason、断流保留内容、失败分类、取消即时返回）。

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 起一个一次性 HTTP 服务器：读掉完整请求（headers + body）后，按脚本写出响应。
    /// 每项为「写入前延迟（毫秒）+ 字节」，独立 flush——用于模拟真实 SSE 分包、
    /// 心跳间隔与慢速生成。客户端提前断开时安静退出（写失败即止）。
    async fn spawn_sse_server(chunks: Vec<(u64, Vec<u8>)>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // 读掉完整请求：先凑齐 headers，再按 Content-Length 读满 body
            let mut acc: Vec<u8> = Vec::new();
            let mut buf = [0u8; 16384];
            loop {
                let n = socket.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                acc.extend_from_slice(&buf[..n]);
                let s = String::from_utf8_lossy(&acc);
                if let Some(hend) = s.find("\r\n\r\n") {
                    let cl = s
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("content-length"))
                        .and_then(|l| l.split(':').nth(1))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if acc.len() >= hend + 4 + cl {
                        break;
                    }
                }
            }
            for (delay_ms, c) in chunks {
                if delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                if socket.write_all(&c).await.is_err() || socket.flush().await.is_err() {
                    break;
                }
            }
            let _ = socket.shutdown().await;
        });
        format!("http://{addr}")
    }

    fn sse_head() -> Vec<u8> {
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n".to_vec()
    }

    fn sse_data(json: &str) -> Vec<u8> {
        format!("data: {json}\n\n").into_bytes()
    }

    /// 正常流：多个 delta 分帧 → 拼接完整；末帧带 finish_reason；[DONE] 收尾
    #[tokio::test]
    async fn stream_once_accumulates_deltas_and_finish_reason() {
        let endpoint = spawn_sse_server(vec![
            (0, sse_head()),
            (0, sse_data(r#"{"choices":[{"delta":{"content":"{\"kind\":"},"finish_reason":null}]}"#)),
            (0, sse_data(r#"{"choices":[{"delta":{"content":"\"word\"}"}}]}"#)),
            (0, sse_data(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#)),
            (0, b"data: [DONE]\n\n".to_vec()),
        ])
        .await;
        let body = serde_json::json!({"stream": true});
        let out = request_chat_stream_once("测试", &endpoint, "k", "word", &body, &CancelToken::new(), 5)
            .await
            .expect("正常流应成功");
        assert_eq!(out.text, r#"{"kind":"word"}"#);
        assert_eq!(out.finish_reason, "stop");
    }

    /// 中途断流（无 [DONE]、无 finish 帧即关连接）：已到达内容必须保留、不报错
    #[tokio::test]
    async fn stream_once_keeps_content_when_disconnected_midway() {
        let endpoint = spawn_sse_server(vec![
            (0, sse_head()),
            (0, sse_data(r#"{"choices":[{"delta":{"content":"part1"}}]}"#)),
            (0, sse_data(r#"{"choices":[{"delta":{"content":"part2"}}]}"#)),
            // 到此直接断开
        ])
        .await;
        let body = serde_json::json!({"stream": true});
        let out = request_chat_stream_once("测试", &endpoint, "k", "word", &body, &CancelToken::new(), 5)
            .await
            .expect("断流但已有内容应 Ok 返回");
        assert_eq!(out.text, "part1part2");
    }

    /// 空内容 + 流正常结束（无任何 delta）：Fatal（模型未输出，非传输故障）
    #[tokio::test]
    async fn stream_once_empty_stream_is_fatal() {
        let endpoint = spawn_sse_server(vec![(0, sse_head())]).await;
        let body = serde_json::json!({"stream": true});
        let err = request_chat_stream_once("测试", &endpoint, "k", "word", &body, &CancelToken::new(), 5)
            .await
            .expect_err("空流应失败");
        assert!(matches!(err, StreamFail::Fatal(_)), "空流应为 Fatal: {err:?}");
    }

    /// 连接建立失败（无监听端口）：Retryable（换连接重发可能恢复）
    #[tokio::test]
    async fn stream_once_connect_failure_is_retryable() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l); // 立即释放，端口无监听
        let err = request_chat_stream_once(
            "测试",
            &format!("http://{addr}"),
            "k",
            "word",
            &serde_json::json!({"stream": true}),
            &CancelToken::new(),
            5,
        )
        .await
        .expect_err("连接失败应返回错误");
        assert!(matches!(err, StreamFail::Retryable(_)), "连接失败应为 Retryable: {err:?}");
    }

    /// 网关忽略 stream:true（Content-Type 为 application/json）：整体 JSON 兜底解析
    #[tokio::test]
    async fn stream_once_non_sse_falls_back_to_json() {
        let payload = r#"{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}"#;
        let resp: Vec<u8> = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
            payload.len()
        )
        .into_bytes();
        let endpoint = spawn_sse_server(vec![(0, resp)]).await;
        let out = request_chat_stream_once(
            "测试",
            &endpoint,
            "k",
            "word",
            &serde_json::json!({"stream": true}),
            &CancelToken::new(),
            5,
        )
        .await
        .expect("非 SSE 应整体解析成功");
        assert_eq!(out.text, "hi");
        assert_eq!(out.finish_reason, "stop");
    }

    /// 服务端只发 SSE 心跳注释行、永不产出内容（DeepSeek 服务端故障的真实形态）：
    /// 「无内容进度」超时必须触发（心跳不能续命），且分类为 Retryable（空内容）
    #[tokio::test]
    async fn stream_once_heartbeat_only_triggers_no_progress_timeout() {
        // 每 150ms 一条心跳，持续约 2.5s；no_progress=1s → 应在 ~1s 被打断
        let mut chunks = vec![(0u64, sse_head())];
        for _ in 0..16 {
            chunks.push((150, b": keep-alive\n\n".to_vec()));
        }
        let endpoint = spawn_sse_server(chunks).await;
        let started = std::time::Instant::now();
        let err = request_chat_stream_once(
            "测试",
            &endpoint,
            "k",
            "word",
            &serde_json::json!({"stream": true}),
            &CancelToken::new(),
            1,
        )
        .await
        .expect_err("仅心跳的流应触发无进度超时");
        assert!(
            matches!(err, StreamFail::Retryable(ref r) if r.contains("未收到生成内容")),
            "应为无进度超时的 Retryable: {err:?}"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_millis(1900),
            "应在 no_progress 超时附近返回，而非等满心跳流: {:?}",
            started.elapsed()
        );
    }

    /// 慢速生成（内容间隔 400ms）不应被「无进度」超时误杀（间隔 < 超时阈值）
    #[tokio::test]
    async fn stream_once_slow_content_not_killed_by_no_progress() {
        let endpoint = spawn_sse_server(vec![
            (0, sse_head()),
            (400, sse_data(r#"{"choices":[{"delta":{"content":"a"}}]}"#)),
            (400, sse_data(r#"{"choices":[{"delta":{"content":"b"}}]}"#)),
            (400, sse_data(r#"{"choices":[{"delta":{"content":"c"}}]}"#)),
            (0, b"data: [DONE]\n\n".to_vec()),
        ])
        .await;
        let out = request_chat_stream_once(
            "测试",
            &endpoint,
            "k",
            "word",
            &serde_json::json!({"stream": true}),
            &CancelToken::new(),
            2,
        )
        .await
        .expect("慢速内容流应正常完成");
        assert_eq!(out.text, "abc");
    }

    /// 已取消的令牌：请求发起到一半也即刻以 E_AI_CANCELLED 失败，不重试
    #[tokio::test]
    async fn stream_text_returns_cancelled_when_token_fired() {
        let token = CancelToken::new();
        token.cancel();
        let err = request_chat_stream_text(
            "测试",
            "http://127.0.0.1:1",
            "k",
            "word",
            &serde_json::json!({"stream": true}),
            &token,
        )
        .await
        .expect_err("已取消应直接失败");
        let msg = format!("{err}");
        assert!(msg.contains("E_AI_CANCELLED"), "应为取消错误: {msg}");
    }
}
