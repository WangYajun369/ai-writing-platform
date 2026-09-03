//! 英语字典辅助命令
//!
//! - **离线词典**：读取应用数据目录下 `dict/ecdict.sqlite`（ECDICT 词库格式），
//!   支持状态检测、导入与查询（精确 + 前缀建议）
//! - **AI 兜底释义**：离线词库未命中或释义不理想时，调用 DeepSeek / OpenAI 兼容
//!   接口生成音标 + 词性释义 + 例句（JSON 结构化输出）

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use crate::error::AppError;
use crate::models::{
    AiWordExplain, DictHit, DictStatus, VocabKnowledge, VocabMeaning, VocabMorphItem, VocabPhrase,
    VocabSentence,
};
use crate::utils::get_http_client;

// ───────────────────────── 词典文件 ─────────────────────────

/// ECDICT 词典文件相对 app_data_dir 的位置
const DICT_DIR: &str = "dict";
const DICT_FILE: &str = "ecdict.sqlite";

/// 获取词典文件完整路径
fn dict_db_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Business(format!("无法获取应用数据目录: {e}")))?;
    Ok(dir.join(DICT_DIR).join(DICT_FILE))
}

/// 打开词典库（只读），校验 stardict 表存在
fn open_dict_db(app: &AppHandle) -> Result<Option<rusqlite::Connection>, AppError> {
    let path = dict_db_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let table_ok: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='stardict')",
        [],
        |row| row.get(0),
    )?;
    if !table_ok {
        return Ok(None);
    }
    Ok(Some(conn))
}

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

/// 词条总数
fn dict_word_count(app: &AppHandle) -> i64 {
    open_dict_db(app)
        .ok()
        .flatten()
        .and_then(|conn| {
            conn.query_row("SELECT COUNT(*) FROM stardict", [], |row| row.get(0))
                .ok()
        })
        .unwrap_or(0)
}

// ───────────────────────── 词典命令 ─────────────────────────

/// 词典状态
#[tauri::command]
pub fn dict_status(app: AppHandle) -> DictStatus {
    let installed = open_dict_db(&app).ok().flatten().is_some();
    DictStatus {
        installed,
        word_count: if installed { dict_word_count(&app) } else { 0 },
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
        return Err(AppError::Validation(format!("词典文件不存在: {source_path}")));
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
    let mut result = DictLookupResult { hit: None, suggestions: Vec::new() };
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
    let pattern = format!(
        "{}%",
        word.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let items = stmt
        .query_map(rusqlite::params![pattern, word], row_to_hit)?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    result.suggestions = items;
    Ok(result)
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

/// 用 AI（推荐 deepseek-v4-flash 等轻量模型）判断单词形态：
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
    let api_key = args
        .api_key
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    if api_key.is_empty() {
        return Err(AppError::Business("未配置 API Key，无法调用 AI 检查单词".to_string()));
    }

    let endpoint = args.endpoint.trim_end_matches('/');
    crate::app_log!(
        "[vocab] AI 单词检查开始 word={word} endpoint={endpoint} model={} api_key_len={}",
        args.model,
        api_key.len()
    );
    let system = CHECK_WORD_SYSTEM_PROMPT.replace("{{WORD}}", &word);

    let mut last_error = String::new();
    for attempt in 0..2usize {
        // 检查是轻量任务，输出上限给小额度即可（flash 快且省）
        let max_tokens = if attempt == 0 { 512 } else { 1024 };
        let body = explain_request_body(&args.model, &system, &word, 0.0, max_tokens, attempt == 1);
        let chat = request_chat_content("单词形态检查", &endpoint, &api_key, &word, &body).await?;
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
    Ok(WordCheckResult { kind, canonical, note })
}

/// 一次聊天补全返回的最终回答
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
        return Err(AppError::Business("未配置 AI 服务（端点/模型为空），请先在设置中完成 AI 配置".to_string()));
    }
    let api_key = args
        .api_key
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    if api_key.is_empty() {
        return Err(AppError::Business("未配置 API Key，无法调用 AI 生成释义".to_string()));
    }

    let endpoint = args.endpoint.trim_end_matches('/');
    crate::app_log!(
        "[vocab] AI 释义开始 word={word} endpoint={endpoint} model={} api_key_len={}",
        args.model,
        api_key.len()
    );

    let is_zh = args.lang.as_deref().unwrap_or("zh") == "zh";
    let system = if is_zh { EXPLAIN_SYSTEM_PROMPT_ZH } else { EXPLAIN_SYSTEM_PROMPT_EN }
        .replace("{{WORD}}", word);
    let temperature = args.temperature.unwrap_or(0.3);

    // 两次尝试：① 常规请求（输出上限 4096）；② 失败后强制 json_object + 上限 8192
    let mut last_error = String::new();
    let mut last_tail = String::new();
    let mut last_raw = String::new();
    for attempt in 0..2usize {
        let max_tokens = if attempt == 0 { 4096 } else { 8192 };
        let body =
            explain_request_body(&args.model, &system, word, temperature, max_tokens, attempt == 1);
        let chat = request_chat_content("释义", &endpoint, &api_key, word, &body).await?;
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
                    crate::app_log!("[vocab] AI 释义自动重试（强制 JSON + 扩大输出上限）word={word}");
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

/// 构造释义请求体
fn explain_request_body(
    model: &str,
    system: &str,
    word: &str,
    temperature: f64,
    max_tokens: u32,
    force_json: bool,
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
    body
}

/// 发起一次聊天补全请求并取出 message.content 原文与停止原因
///
/// `label` 用于日志区分调用场景（如 "释义" / "单词形态检查"）。
async fn request_chat_content(
    label: &str,
    endpoint: &str,
    api_key: &str,
    word: &str,
    body: &serde_json::Value,
) -> Result<ChatContent, AppError> {
    let resp = get_http_client()
        .post(format!("{endpoint}/chat/completions"))
        .bearer_auth(api_key)
        .timeout(std::time::Duration::from_secs(90))
        .json(body)
        .send()
        .await
        .map_err(|e| {
            crate::app_log_error!("[vocab] AI {label} HTTP 请求失败 word={word}: {e}");
            AppError::Http(format!("AI 请求失败: {e}"))
        })?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        crate::app_log_error!(
            "[vocab] AI {label} 失败 word={word} status={} body={}",
            status,
            snippet_err(&text)
        );
        let hint = match status.as_u16() {
            401 | 403 => "（可能是 API Key 无效或已过期，请检查 设置 → AI 设置）".to_string(),
            402 | 429 => "（可能是账户余额不足或触发限流，请检查 DeepSeek 账户）".to_string(),
            400 => {
                let low = text.to_lowercase();
                if low.contains("model") || low.contains("not exist") || low.contains("invalid") {
                    "（可能是所选模型不存在或不可用，请到 设置 → AI 设置 更换对话模型）".to_string()
                } else {
                    String::new()
                }
            }
            _ => String::new(),
        };
        return Err(AppError::Http(format!(
            "AI 服务返回错误（HTTP {status}）: {}{}",
            snippet_err(&text),
            hint
        )));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Http(format!("解析 AI 响应失败: {e}")))?;

    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let finish_reason = json
        .pointer("/choices/0/finish_reason")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let reasoning_bytes = json
        .pointer("/choices/0/message/reasoning_content")
        .and_then(|v| v.as_str())
        .map(|s| s.len())
        .unwrap_or(0);
    if content.is_empty() {
        return Err(AppError::Business(
            "AI 返回内容为空（模型可能只输出了思考过程），请重试".to_string(),
        ));
    }
    crate::app_log!(
        "[vocab] AI {label} 响应 word={word} content_bytes={} finish_reason={finish_reason} reasoning_bytes={reasoning_bytes} 头部: {} 尾部: {}",
        content.len(),
        snippet_err(&content),
        snippet_err_tail(&content)
    );
    Ok(ChatContent { text: content, finish_reason })
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
        cleaned.chars().skip(cleaned.chars().count() - 160).collect::<String>()
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
    let open = text.find('{').ok_or_else(|| AppError::Business("AI 返回内容不包含 JSON".to_string()))?;
    let close = text.rfind('}').ok_or_else(|| AppError::Business("AI 返回内容不包含完整 JSON".to_string()))?;
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
        return Err(AppError::Business("AI 未返回有效释义，请重试或手动填写".to_string()));
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
            synonyms: k.synonyms.into_iter().map(clean).filter(|s| !s.is_empty()).collect(),
            antonyms: k.antonyms.into_iter().map(clean).filter(|s| !s.is_empty()).collect(),
            phrases: k
                .phrases
                .into_iter()
                .filter(|p| !p.phrase.trim().is_empty())
                .map(|p| VocabPhrase { phrase: clean(p.phrase), meaning: clean(p.meaning) })
                .collect(),
            verb_forms: k.verb_forms.into_iter().map(clean).filter(|s| !s.is_empty()).collect(),
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
