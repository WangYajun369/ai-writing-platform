//! Agent 数据库工具（自 Python agent/tools/db_tools.py 迁移）
//!
//! 原实现通过 HTTP 回调 Rust Bridge(9876) 获取数据；迁移后直接在 Rust
//! 内访问 SQLite（repository 层），消除中间网络跳转，输出格式保持一致。

use rusqlite::Connection;
use serde_json::Value;

use crate::error::AppError;
use crate::repository;

/// 单次工具执行的最大内容长度（防御异常数据）
const MAX_TOOL_CONTENT_CHARS: usize = 200_000;

/// 生成 OpenAI function calling 的 tools 参数
///
/// 传入的是**已合并的工具名列表**（阶段四起由 `EffectiveProfile::tools` 提供，
/// 即「能力工具 ∪ 领域工具」）；此处不再自行按 skill 查表。
pub fn build_tools_schema(tool_names: &[&str]) -> Vec<Value> {
    let mut out = Vec::new();
    for name in tool_names {
        match tool_schema(name) {
            Some(schema) => out.push(serde_json::json!({
                "type": "function",
                "function": schema,
            })),
            // 未注册的工具名：跳过并告警，不 panic（改造前是静默跳过）
            None => eprintln!("[agent] 引用了未注册的工具 `{name}`，已跳过"),
        }
    }
    out
}

fn params_obj(props: Value, required: Vec<&str>) -> Value {
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": required,
    })
}

/// 字符串型 ID 参数的 schema（书籍 ID / 章节 ID 等）
fn id_schema(desc: &str) -> Value {
    serde_json::json!({"type": "string", "description": desc})
}

// ── L0 工具注册表（ADR-005 阶段一）──────────────────────────────────────────
// 新增一个工具只需在下方 `TOOLS` 追加一项，不必再改「订阅 / schema / 分发」三处
// match（改造前正是三处，见 ADR-005 与实施计划阶段一）。

/// 单个工具的完整定义：name / description / parameters / execute 四合一
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// 参数 JSON Schema。用函数指针而非 `Value` 字段：`Value` 无法在 `static` 中直接构造
    pub parameters: fn() -> Value,
    /// 执行体
    pub execute: fn(&Connection, &Value) -> Result<String, AppError>,
}

// 6 个工具只有 4 种参数形态，此处共享，避免逐工具重复字面量
fn params_book() -> Value {
    params_obj(
        serde_json::json!({ "book_id": id_schema("书籍 ID") }),
        vec!["book_id"],
    )
}

fn params_book_chapter() -> Value {
    params_obj(
        serde_json::json!({
            "book_id": id_schema("书籍 ID"),
            "chapter_id": id_schema("章节 ID"),
        }),
        vec!["book_id", "chapter_id"],
    )
}

fn params_book_chapter_chunk() -> Value {
    params_obj(
        serde_json::json!({
            "book_id": id_schema("书籍 ID"),
            "chapter_id": id_schema("章节 ID"),
            "chunk_index": {"type": "integer", "description": "分段索引，从 0 开始", "default": 0},
            "chunk_size": {"type": "integer", "description": "每段字符数，默认 2000", "default": 2000},
        }),
        vec!["book_id", "chapter_id"],
    )
}

fn params_book_query() -> Value {
    params_obj(
        serde_json::json!({
            "book_id": id_schema("书籍 ID"),
            "query": {"type": "string", "description": "搜索关键词"},
        }),
        vec!["book_id", "query"],
    )
}

fn params_book_chapter_size() -> Value {
    params_obj(
        serde_json::json!({
            "book_id": id_schema("书籍 ID"),
            "chapter_id": id_schema("章节 ID"),
            "max_chars": {"type": "integer", "description": "每段目标字符数，默认 1200", "default": 1200},
        }),
        vec!["book_id", "chapter_id"],
    )
}

fn params_create_card() -> Value {
    params_obj(
        serde_json::json!({
            "book_id": id_schema("书籍 ID"),
            "card_type": {"type": "string", "description": "卡片类型，取值仅限：character 人物 / location 地点 / timeline 时间线 / faction 势力 / item 物品 / misc 其他（拆书的要点、概念、术语一律用 misc，语义细节写进 tags）"},
            "title": {"type": "string", "description": "卡片标题，用原书主张或术语名，不用评价性措辞"},
            "content": {"type": "string", "description": "卡片正文，须自带背景，可脱离原文独立理解"},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "可选标签，用于承载章节出处、概念层级等语义细节"},
        }),
        vec!["book_id", "card_type", "title", "content"],
    )
}

/// 全部可用工具的注册表（单一真相源）
static TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "read_chapter",
        description: "读取指定章节的完整内容（含标题和摘要）。注意：如果章节内容很长（超过 3000 字），建议先使用 read_chapter_summary 查看摘要，再用 read_chapter_chunk 分页读取。",
        parameters: params_book_chapter,
        execute: tool_read_chapter,
    },
    ToolDef {
        name: "read_chapter_summary",
        description: "读取指定章节的摘要信息（不含正文），节省 Token。在需要了解章节内容但不需逐字分析时优先使用此工具。",
        parameters: params_book_chapter,
        execute: tool_read_chapter_summary,
    },
    ToolDef {
        name: "read_chapter_chunk",
        description: "分页读取章节内容，适用于大章节分段分析。每次只读取指定的一段内容，大幅减少单次 Token 消耗。",
        parameters: params_book_chapter_chunk,
        execute: tool_read_chapter_chunk,
    },
    ToolDef {
        name: "list_book_chapters",
        description: "列出指定书籍的所有章节（标题+摘要，不含正文）。",
        parameters: params_book,
        execute: tool_list_book_chapters,
    },
    ToolDef {
        name: "search_world_cards",
        description: "搜索世界观卡片（角色、地点、设定等）。为节省 Token，最多返回 5 条结果，每条内容截断 300 字。如需更多详情，请缩小搜索范围或指定更精确的关键词。",
        parameters: params_book_query,
        execute: tool_search_world_cards,
    },
    ToolDef {
        name: "get_book_context",
        description: "获取整本书的创作上下文（最近章节摘要+世界观概览）。",
        parameters: params_book,
        execute: tool_get_book_context,
    },
    // ── 领域工具（阶段六：拆书流水线）──
    ToolDef {
        name: "split_chapter",
        description: "把指定章节正文按段落边界切分为若干片段，返回带序号、字数与全文的片段列表。适用于拆书场景：先看清章节结构，再逐段提炼要点。片段过多时只返回前若干段全文，其余为预览——此时请调大 max_chars 减少片段数后重试。",
        parameters: params_book_chapter_size,
        execute: tool_split_chapter,
    },
    ToolDef {
        name: "create_note_card",
        description: "创建一张要点/概念卡片并写入世界观卡片库（world_cards）。拆书与学科笔记场景的落地步骤：把提炼出的要点固化为可检索的卡片。",
        parameters: params_create_card,
        execute: tool_create_note_card,
    },
];

/// 按名字查工具定义（注册表的唯一入口）
pub fn tool_def(name: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|t| t.name == name)
}

/// 注册表当前注册的全部工具名
///
/// 供插件宿主（ADR-006）校验插件画像引用的工具是否真实存在——
/// 插件是声明式的，只报工具名、由引擎代为执行，必须先确认名字合法。
pub fn registered_tool_names() -> Vec<&'static str> {
    TOOLS.iter().map(|t| t.name).collect()
}

/// 单个工具的 OpenAI function calling 定义（name / description / parameters）
pub fn tool_schema(name: &str) -> Option<Value> {
    tool_def(name).map(|t| {
        serde_json::json!({
            "name": t.name,
            "description": t.description,
            "parameters": (t.parameters)(),
        })
    })
}

/// 截断过长的工具结果，防止异常数据撑爆上下文
fn clamp(s: &str) -> String {
    if s.chars().count() > MAX_TOOL_CONTENT_CHARS {
        let mut out: String = s.chars().take(MAX_TOOL_CONTENT_CHARS).collect();
        out.push_str("\n...[内容过长，已截断]");
        out
    } else {
        s.to_string()
    }
}

/// 执行指定工具，返回注入给模型的文本结果
pub fn execute_tool(conn: &Connection, name: &str, args: &Value) -> Result<String, AppError> {
    let def = tool_def(name)
        .ok_or_else(|| AppError::Business(format!("未知工具: {name}")))?;
    let result = (def.execute)(conn, args)?;
    Ok(clamp(&result))
}

/// 获取章节数据（id / title / content / summary）
fn load_chapter(
    conn: &Connection,
    book_id: &str,
    chapter_id: &str,
) -> Result<(String, String, String, Option<String>), AppError> {
    let chapters = repository::chapter_repo::list_by_book(conn, book_id)?;
    let chapter = chapters
        .iter()
        .find(|c| c.id == chapter_id)
        .ok_or_else(|| AppError::Business(format!("章节 {chapter_id} 不存在")))?;
    let content = repository::chapter_repo::find_content(conn, chapter_id)?;
    Ok((
        chapter.id.clone(),
        chapter.title.clone(),
        content,
        chapter.summary.clone(),
    ))
}

fn tool_read_chapter(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapter_id = args["chapter_id"].as_str().unwrap_or("");
    let (_, title, content, summary) = load_chapter(conn, book_id, chapter_id)?;

    let mut parts = vec![format!("# {title}")];
    if let Some(s) = summary {
        if !s.is_empty() {
            parts.push(format!("\n> 摘要：{s}"));
        }
    }
    parts.push(format!("\n{content}"));
    Ok(parts.join("\n"))
}

fn tool_read_chapter_summary(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapter_id = args["chapter_id"].as_str().unwrap_or("");
    let (_, title, content, summary) = load_chapter(conn, book_id, chapter_id)?;

    let mut parts = vec![format!("## {title}")];
    match summary {
        Some(s) if !s.is_empty() => parts.push(format!("\n摘要：{s}")),
        _ => {
            let preview: String = content.chars().take(500).collect();
            parts.push(format!("\n内容预览（前500字）：{preview}..."));
        }
    }
    Ok(parts.join("\n"))
}

fn tool_read_chapter_chunk(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapter_id = args["chapter_id"].as_str().unwrap_or("");
    let chunk_index = args["chunk_index"].as_i64().unwrap_or(0);
    let chunk_size = args["chunk_size"].as_i64().unwrap_or(2000).max(100) as usize;

    let (_, title, content, summary) = load_chapter(conn, book_id, chapter_id)?;
    let chars: Vec<char> = content.chars().collect();
    let total_len = chars.len();
    let total_chunks = if total_len == 0 {
        0
    } else {
        total_len.div_ceil(chunk_size)
    };

    if chunk_index < 0 || chunk_index as usize >= total_chunks || total_chunks == 0 {
        let err = serde_json::json!({
            "error": "chunk_index 超出范围",
            "total_chunks": total_chunks,
            "valid_range": if total_chunks > 0 { format!("0 ~ {}", total_chunks - 1) } else { "0 ~ 0".to_string() },
        });
        return Ok(err.to_string());
    }

    let ci = chunk_index as usize;
    let start = ci * chunk_size;
    let end = (start + chunk_size).min(total_len);
    let chunk_text: String = chars[start..end].iter().collect();

    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = summary {
        if !s.is_empty() {
            parts.push(format!("> 全文摘要：{s}"));
        }
    }
    parts.push(format!("# {title} (第 {} / {total_chunks} 段)", ci + 1));
    parts.push(format!("字符范围: {} ~ {} / {total_len}", start + 1, end));
    parts.push(format!("\n{chunk_text}"));
    if ci < total_chunks - 1 {
        parts.push(format!(
            "\n---\n💡 还有 {} 段未读取，可使用 chunk_index={} 继续读取",
            total_chunks - ci - 1,
            ci + 1
        ));
    }
    Ok(parts.join("\n"))
}

fn tool_list_book_chapters(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapters = repository::chapter_repo::list_by_book(conn, book_id)?;

    let list: Vec<Value> = chapters
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "title": c.title,
                "summary": c.summary,
            })
        })
        .collect();
    Ok(serde_json::to_string_pretty(&list)?)
}

fn tool_search_world_cards(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let query = args["query"].as_str().unwrap_or("");

    let cards =
        repository::world_card_repo::search_fts5(conn, book_id, query, 20).or_else(|_| {
            repository::world_card_repo::search_like(conn, book_id, &format!("%{query}%"), 20)
        })?;

    const MAX_RESULTS: usize = 5;
    const CONTENT_TRUNCATE: usize = 300;

    let mut truncated: Vec<Value> = Vec::new();
    for c in cards.iter().take(MAX_RESULTS) {
        let content: String = c.content.chars().take(CONTENT_TRUNCATE).collect();
        let content = if c.content.chars().count() > CONTENT_TRUNCATE {
            format!("{content}...")
        } else {
            content
        };
        truncated.push(serde_json::json!({
            "id": c.id,
            "name": c.title,
            "category": c.card_type,
            "content": content,
            "tags": c.tags,
        }));
    }

    let mut result_obj = serde_json::json!({
        "total": cards.len(),
        "shown": truncated.len(),
        "cards": truncated,
    });
    if cards.len() > MAX_RESULTS {
        result_obj["hint"] = serde_json::json!(format!(
            "还有 {} 条结果未显示，请使用更精确的关键词缩小范围",
            cards.len() - MAX_RESULTS
        ));
    }
    Ok(serde_json::to_string_pretty(&result_obj)?)
}

fn tool_get_book_context(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let book = repository::book_repo::find_by_id(conn, book_id)?;
    let chapters = repository::chapter_repo::list_by_book(conn, book_id)?;
    let cards = repository::world_card_repo::list_by_book(conn, book_id)?;

    let mut parts = vec![format!("# 《{}》创作上下文\n", book.title)];

    if !chapters.is_empty() {
        parts.push("## 最近章节".to_string());
        for ch in chapters.iter().rev().take(5).rev() {
            let summary = ch.summary.as_deref().unwrap_or("(无摘要)");
            parts.push(format!("- {}: {}", ch.title, summary));
        }
    }

    if !cards.is_empty() {
        parts.push("\n## 世界观设定".to_string());
        for wc in cards.iter() {
            let mut content: String = wc.content.chars().take(200).collect();
            if wc.content.chars().count() > 200 {
                content.push_str("...");
            }
            parts.push(format!("- [{}] {}: {}", wc.card_type, wc.title, content));
        }
    }

    Ok(parts.join("\n"))
}

// ── 领域工具实现（阶段六）──────────────────────────────────────────────────
// 这两个工具是「拆书 / 学科笔记」流水线的读写两端：split_chapter 负责看清结构，
// create_note_card 负责把提炼结果落库。二者都不属于任何能力画像，只由提炼类领域
// 经 EXTRACTION_TOOLS 引入（见 profiles.rs）。

/// 需要折算成换行的块级标签（比较时统一小写）
const BLOCK_TAGS: &[&str] = &[
    "p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote",
    "section", "article", "ul", "ol", "table",
];

/// 解码正文里最常见的几个 HTML 实体
///
/// 实体名以 `\u{26}` 拼接而非写死字面量：源码里直接写「&」开头的实体会在清理
/// 管线里被二次转义。代表「&」自身的那一档放最后解，才不会把其余实体提前拆坏。
fn decode_entities(s: &str) -> String {
    const AMP: char = '\u{26}';
    let mut out = s.to_string();
    for (name, ch) in [
        ("nbsp;", ' '),
        ("lt;", '<'),
        ("gt;", '>'),
        ("quot;", '"'),
        ("#39;", '\''),
    ] {
        out = out.replace(&format!("{AMP}{name}"), &ch.to_string());
    }
    out.replace(&format!("{AMP}amp;"), &AMP.to_string())
}

/// 章节正文（HTML）→ 保留段落边界的纯文本
///
/// `utils::strip_html` 只删标签，会把 `<p>甲</p><p>乙</p>` 挤成「甲乙」，
/// 段落边界丢失后便无从切段。此处先把块级标签换成换行，再剥离其余标签。
fn html_to_plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut tag = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let name = tag
                    .trim()
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("");
                if BLOCK_TAGS.contains(&name.to_ascii_lowercase().as_str()) {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    decode_entities(&out)
}

/// 按句末标点切分（标点保留在各句末尾）；无标点时返回整段
fn split_sentences(para: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let mut start = 0usize;
    for (i, ch) in para.char_indices() {
        if matches!(ch, '。' | '！' | '？' | '；' | '.' | '!' | '?' | ';') {
            let end = i + ch.len_utf8();
            out.push(&para[start..end]);
            start = end;
        }
    }
    if start < para.len() {
        out.push(&para[start..]);
    }
    out
}

/// 把纯文本拆成一串「切分单元」
///
/// 三级递进，越靠后越粗暴：段落 → 句 → 按字数硬切。最后一级是万不得已的兜底
/// （例如整章是一段无标点的粘贴文本），保证单元长度可控。
fn split_units(text: &str, max_chars: usize) -> Vec<String> {
    let mut units: Vec<String> = Vec::new();
    for para in text.split('\n').map(str::trim).filter(|p| !p.is_empty()) {
        if para.chars().count() <= max_chars {
            units.push(para.to_string());
            continue;
        }
        for sent in split_sentences(para) {
            if sent.chars().count() <= max_chars {
                units.push(sent.to_string());
                continue;
            }
            let mut buf = String::new();
            for ch in sent.chars() {
                buf.push(ch);
                if buf.chars().count() >= max_chars {
                    units.push(std::mem::take(&mut buf));
                }
            }
            if !buf.is_empty() {
                units.push(buf);
            }
        }
    }
    units
}

/// 把切分单元贪心装箱为若干「不超过 max_chars」的片段
///
/// 片段数即章节的结构粒度，模型可据此决定逐段处理还是整章处理。
/// 计长把两个单元间的换行也算进去，故片段严格不超过 max_chars。
fn split_into_segments(text: &str, max_chars: usize) -> Vec<String> {
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();

    for unit in split_units(text, max_chars) {
        let unit_chars = unit.chars().count();
        // 装不下（含分隔换行）→ 先收口当前片段
        if !current.is_empty() && current.chars().count() + unit_chars + 1 > max_chars {
            segments.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(&unit);
        if current.chars().count() >= max_chars {
            segments.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

/// split_chapter 的每段最小字符数（再小会把句子切碎）
const MIN_SPLIT_CHARS: usize = 200;
/// 一次 split_chapter 返回带全文的片段上限，超出部分只给预览
const MAX_FULL_SEGMENTS: usize = 12;
/// 超出 MAX_FULL_SEGMENTS 的片段预览长度
const SEGMENT_PREVIEW_CHARS: usize = 100;

fn tool_split_chapter(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let chapter_id = args["chapter_id"].as_str().unwrap_or("");
    let max_chars = args["max_chars"].as_i64().unwrap_or(1200).max(MIN_SPLIT_CHARS as i64) as usize;

    let (_, title, content, summary) = load_chapter(conn, book_id, chapter_id)?;
    let segments = split_into_segments(&html_to_plain(&content), max_chars);

    let truncated = segments.len() > MAX_FULL_SEGMENTS;
    let items: Vec<Value> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let text = if i < MAX_FULL_SEGMENTS {
                s.clone()
            } else {
                let preview: String = s.chars().take(SEGMENT_PREVIEW_CHARS).collect();
                format!("{preview}…")
            };
            serde_json::json!({"index": i, "chars": s.chars().count(), "text": text})
        })
        .collect();

    let mut out = serde_json::json!({
        "chapter": title,
        "max_chars": max_chars,
        "segment_count": segments.len(),
        "total_chars": segments.iter().map(|s| s.chars().count()).sum::<usize>(),
        "segments": items,
    });
    if let Some(s) = summary {
        if !s.is_empty() {
            out["summary"] = serde_json::json!(s);
        }
    }
    if truncated {
        out["hint"] = serde_json::json!(format!(
            "仅返回前 {MAX_FULL_SEGMENTS} 段全文，其余 {} 段为预览。如需完整正文，请调大 max_chars（当前 {max_chars}）以减少片段数后重试。",
            segments.len() - MAX_FULL_SEGMENTS
        ));
    }
    Ok(serde_json::to_string_pretty(&out)?)
}

/// 允许写入的卡片类型（与前端 `WorldCardType` 保持一致的封闭值域）
///
/// 前端 `WORLD_CARD_TYPE_CONFIG[card.type].icon` 未做兜底，卡片面板一旦遇到
/// 未知类型即渲染崩溃。此处在写入侧硬性拦截，是防该崩溃的第一道闸。
const CARD_TYPES: &[&str] = &["character", "location", "timeline", "faction", "item", "misc"];

fn tool_create_note_card(conn: &Connection, args: &Value) -> Result<String, AppError> {
    let book_id = args["book_id"].as_str().unwrap_or("");
    let card_type = args["card_type"].as_str().unwrap_or("").trim();
    let title = args["title"].as_str().unwrap_or("").trim();
    let content = args["content"].as_str().unwrap_or("").trim();
    let tags: Vec<String> = args["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    // 参数类错误走结构化返回（模型可据此自我纠正）；数据不存在则走 Err
    if !CARD_TYPES.contains(&card_type) {
        return Ok(serde_json::json!({
            "error": "card_type 不在允许的值域内",
            "received": card_type,
            "allowed": CARD_TYPES,
        })
        .to_string());
    }
    if title.is_empty() {
        return Ok(serde_json::json!({"error": "title 不能为空"}).to_string());
    }
    if content.is_empty() {
        return Ok(serde_json::json!({"error": "content 不能为空"}).to_string());
    }
    crate::utils::validate_len("卡片标题", title, crate::utils::MAX_TITLE_LEN)?;
    if tags.len() > crate::utils::MAX_TAGS_COUNT {
        return Ok(serde_json::json!({
            "error": "标签数量超过上限",
            "received": tags.len(),
            "max": crate::utils::MAX_TAGS_COUNT,
        })
        .to_string());
    }

    // 先确认书籍存在，避免把卡片写进 dangling book_id
    let book = repository::book_repo::find_by_id(conn, book_id)
        .map_err(|_| AppError::Business(format!("书籍 {book_id} 不存在")))?;

    let id = uuid::Uuid::new_v4().to_string();
    let ts = crate::utils::now();
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
    repository::world_card_repo::insert(
        conn, &id, book_id, card_type, title, content, "", &tags_json, &ts,
    )?;

    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "ok": true,
        "id": id,
        "book": book.title,
        "card_type": card_type,
        "title": title,
        "tags": tags,
    }))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent::profiles;

    /// 与生产 schema 一致的 books / chapters / world_cards 表（db/mod.rs 同款 DDL）
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '', cover_image TEXT,
                word_count INTEGER NOT NULL DEFAULT 0, daily_target INTEGER NOT NULL DEFAULT 0,
                today_count INTEGER NOT NULL DEFAULT 0, db_path TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, outline TEXT NOT NULL DEFAULT '',
                book_type TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE chapters (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                volume_id TEXT, title TEXT NOT NULL, content_html TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
                sort_order INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                summary TEXT, summary_at TEXT, outline TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE world_cards (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'misc',
                title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
                content_html TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                vectorized INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            "#,
        )
        .expect("create test schema");
        conn.execute(
            "INSERT INTO books (id, title, created_at, updated_at) VALUES ('b1', '测试书', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        // c1：有摘要的短章；c2：无摘要的长章（5000 字，供分页测试）；c3：已删除章节
        conn.execute(
            "INSERT INTO chapters (id, book_id, title, content_html, sort_order, created_at, updated_at, summary)
             VALUES ('c1', 'b1', '第一章', '<p>正文一</p>', 0, '2026-01-01', '2026-01-01', '本章摘要')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, book_id, title, content_html, sort_order, created_at, updated_at)
             VALUES ('c2', 'b1', '第二章', ?1, 1, '2026-01-01', '2026-01-01')",
            rusqlite::params!["字".repeat(5000)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chapters (id, book_id, title, sort_order, deleted_at, created_at, updated_at)
             VALUES ('c3', 'b1', '已删章', 2, '2026-01-02', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        // c4：多段落 HTML 章节（供 split_chapter 的段落边界测试）
        conn.execute(
            "INSERT INTO chapters (id, book_id, title, content_html, sort_order, created_at, updated_at)
             VALUES ('c4', 'b1', '第四章', '<p>第一段。</p><p>第二段。</p><p>第三段。</p>', 3, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO world_cards (id, book_id, type, title, content, created_at, updated_at)
             VALUES ('w1', 'b1', 'char', '林雪', '冷静的女剑客', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn
    }

    /// L0 重构前导出的基线（2026-10-10）。
    /// 任何工具 schema 的**非预期**变更都会在此失败——这是「纯重构、零行为变化」的防线。
    const SCHEMA_SNAPSHOTS: &[(&str, &str)] = &[
        ("read_chapter", r#"{"description":"读取指定章节的完整内容（含标题和摘要）。注意：如果章节内容很长（超过 3000 字），建议先使用 read_chapter_summary 查看摘要，再用 read_chapter_chunk 分页读取。","name":"read_chapter","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"},"chapter_id":{"description":"章节 ID","type":"string"}},"required":["book_id","chapter_id"],"type":"object"}}"#),
        ("read_chapter_summary", r#"{"description":"读取指定章节的摘要信息（不含正文），节省 Token。在需要了解章节内容但不需逐字分析时优先使用此工具。","name":"read_chapter_summary","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"},"chapter_id":{"description":"章节 ID","type":"string"}},"required":["book_id","chapter_id"],"type":"object"}}"#),
        ("read_chapter_chunk", r#"{"description":"分页读取章节内容，适用于大章节分段分析。每次只读取指定的一段内容，大幅减少单次 Token 消耗。","name":"read_chapter_chunk","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"},"chapter_id":{"description":"章节 ID","type":"string"},"chunk_index":{"default":0,"description":"分段索引，从 0 开始","type":"integer"},"chunk_size":{"default":2000,"description":"每段字符数，默认 2000","type":"integer"}},"required":["book_id","chapter_id"],"type":"object"}}"#),
        ("list_book_chapters", r#"{"description":"列出指定书籍的所有章节（标题+摘要，不含正文）。","name":"list_book_chapters","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"}},"required":["book_id"],"type":"object"}}"#),
        ("search_world_cards", r#"{"description":"搜索世界观卡片（角色、地点、设定等）。为节省 Token，最多返回 5 条结果，每条内容截断 300 字。如需更多详情，请缩小搜索范围或指定更精确的关键词。","name":"search_world_cards","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"},"query":{"description":"搜索关键词","type":"string"}},"required":["book_id","query"],"type":"object"}}"#),
        ("get_book_context", r#"{"description":"获取整本书的创作上下文（最近章节摘要+世界观概览）。","name":"get_book_context","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"}},"required":["book_id"],"type":"object"}}"#),
        // 阶段六新增：无「重构前基线」可比，以首次上线时的定义为准
        ("split_chapter", r#"{"description":"把指定章节正文按段落边界切分为若干片段，返回带序号、字数与全文的片段列表。适用于拆书场景：先看清章节结构，再逐段提炼要点。片段过多时只返回前若干段全文，其余为预览——此时请调大 max_chars 减少片段数后重试。","name":"split_chapter","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"},"chapter_id":{"description":"章节 ID","type":"string"},"max_chars":{"default":1200,"description":"每段目标字符数，默认 1200","type":"integer"}},"required":["book_id","chapter_id"],"type":"object"}}"#),
        ("create_note_card", r#"{"description":"创建一张要点/概念卡片并写入世界观卡片库（world_cards）。拆书与学科笔记场景的落地步骤：把提炼出的要点固化为可检索的卡片。","name":"create_note_card","parameters":{"properties":{"book_id":{"description":"书籍 ID","type":"string"},"card_type":{"description":"卡片类型，取值仅限：character 人物 / location 地点 / timeline 时间线 / faction 势力 / item 物品 / misc 其他（拆书的要点、概念、术语一律用 misc，语义细节写进 tags）","type":"string"},"content":{"description":"卡片正文，须自带背景，可脱离原文独立理解","type":"string"},"tags":{"description":"可选标签，用于承载章节出处、概念层级等语义细节","items":{"type":"string"},"type":"array"},"title":{"description":"卡片标题，用原书主张或术语名，不用评价性措辞","type":"string"}},"required":["book_id","card_type","title","content"],"type":"object"}}"#),
    ];

    #[test]
    fn tool_schemas_match_pre_refactor_snapshot() {
        for (name, expected) in SCHEMA_SNAPSHOTS {
            let actual = serde_json::to_string(&tool_schema(name).expect(name)).unwrap();
            assert_eq!(&actual, expected, "工具 `{name}` 的 schema 与重构前基线不一致");
        }
        // 快照条数须与注册表条目数一致，防止新增工具后忘记补快照
        assert_eq!(
            SCHEMA_SNAPSHOTS.len(),
            TOOLS.len(),
            "注册表条目数与快照条数不符：新增工具时须同步补快照"
        );
    }

    #[test]
    fn registry_is_self_consistent() {
        let mut seen = std::collections::HashSet::new();
        for t in TOOLS {
            assert!(seen.insert(t.name), "注册表出现重复工具名: {}", t.name);
            assert!(!t.description.is_empty(), "{} 缺少 description", t.name);
            let p = (t.parameters)();
            assert_eq!(p["type"], "object", "{} 的 parameters 须为 object", t.name);
            assert!(p["properties"].is_object(), "{} 缺少 properties", t.name);
            assert!(p["required"].is_array(), "{} 缺少 required", t.name);
        }
        // 每个能力画像引用的工具名都必须在注册表中（防止引用了不存在的工具）
        for skill in ["writing", "analysis", "research", "polish"] {
            for name in profiles::merge(skill, "novel").tools {
                assert!(
                    tool_def(name).is_some(),
                    "能力 `{skill}` 引用了未注册的工具 `{name}`"
                );
            }
        }
    }

    #[test]
    fn skill_tool_mapping_and_schemas() {
        assert_eq!(profiles::merge("polish", "novel").tools.len(), 3);
        assert_eq!(profiles::merge("research", "novel").tools.len(), 4);
        // 未知能力回退 writing，故工具集为 writing 的 5 项
        assert_eq!(profiles::merge("no_such", "novel").tools.len(), 5);
        // 每个映射工具都必须有 schema 定义
        for skill in ["writing", "analysis", "research", "polish"] {
            for name in profiles::merge(skill, "novel").tools {
                assert!(
                    tool_schema(name).is_some(),
                    "{skill} 的工具 {name} 缺少 schema"
                );
            }
        }
        // schema 结构符合 OpenAI function calling 契约
        let schemas = build_tools_schema(&profiles::merge("research", "novel").tools);
        assert_eq!(schemas.len(), 4);
        for s in &schemas {
            assert_eq!(s["type"], "function");
            assert!(s["function"]["name"].as_str().is_some());
            assert_eq!(s["function"]["parameters"]["type"], "object");
        }
    }

    #[test]
    fn clamp_truncates_long_results() {
        let short = "短内容";
        assert_eq!(clamp(short), short);

        let long = "字".repeat(MAX_TOOL_CONTENT_CHARS + 10);
        let out = clamp(&long);
        assert!(out.starts_with(&"字".repeat(MAX_TOOL_CONTENT_CHARS)));
        assert!(out.contains("已截断"));
        // 截断后长度 = 上限 + 截断标记
        assert_eq!(
            out.chars().count(),
            MAX_TOOL_CONTENT_CHARS + "\n...[内容过长，已截断]".chars().count()
        );
    }

    #[test]
    fn unknown_tool_rejected() {
        let conn = test_conn();
        let err = execute_tool(&conn, "delete_everything", &serde_json::json!({})).unwrap_err();
        assert!(err.to_string().contains("未知工具"), "{err}");
    }

    #[test]
    fn read_chapter_full_and_summary_preview() {
        let conn = test_conn();
        // 有摘要：标题 + 摘要 + 正文
        let out = execute_tool(
            &conn,
            "read_chapter",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c1"}),
        )
        .unwrap();
        assert!(out.contains("# 第一章"));
        assert!(out.contains("摘要：本章摘要"));
        assert!(out.contains("<p>正文一</p>"));

        // 无摘要：回退 500 字内容预览
        let out = execute_tool(
            &conn,
            "read_chapter_summary",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2"}),
        )
        .unwrap();
        assert!(out.contains("内容预览（前500字）"));

        // 不存在的章节
        let err = execute_tool(
            &conn,
            "read_chapter",
            &serde_json::json!({"book_id": "b1", "chapter_id": "nope"}),
        )
        .unwrap_err();
        assert!(err.to_string().contains("不存在"), "{err}");
    }

    #[test]
    fn read_chapter_chunk_paging_and_bounds() {
        let conn = test_conn();
        // 5000 字 / 2000 = 3 段；首页含导航提示
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 0}),
        )
        .unwrap();
        assert!(out.contains("第 1 / 3 段"), "{out}");
        assert!(out.contains("chunk_index=1"), "应提示下一段: {out}");

        // 末页不再有导航提示
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 2}),
        )
        .unwrap();
        assert!(out.contains("第 3 / 3 段"));
        assert!(!out.contains("还有"), "末段不应有续读提示");

        // 越界返回结构化错误（非 Err）
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 9}),
        )
        .unwrap();
        assert!(out.contains("chunk_index 超出范围"), "{out}");
        assert!(out.contains("\"total_chunks\":3"), "{out}");

        // chunk_size 下限 100：5000 / 100 = 50 段
        let out = execute_tool(
            &conn,
            "read_chapter_chunk",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "chunk_index": 0, "chunk_size": 10}),
        )
        .unwrap();
        assert!(out.contains("第 1 / 50 段"), "{out}");
    }

    #[test]
    fn list_chapters_excludes_deleted() {
        let conn = test_conn();
        let out = execute_tool(
            &conn,
            "list_book_chapters",
            &serde_json::json!({"book_id": "b1"}),
        )
        .unwrap();
        let list: Vec<Value> = serde_json::from_str(&out).unwrap();
        // c1 / c2 / c4 在册，c3 已删除
        assert_eq!(list.len(), 3, "已删除章节不应列出: {out}");
        assert!(out.contains("第一章"));
        assert!(!out.contains("已删章"));
    }

    #[test]
    fn search_world_cards_like_fallback() {
        let conn = test_conn(); // 无 FTS5 表 → search_fts5 失败 → 降级 LIKE
        let out = execute_tool(
            &conn,
            "search_world_cards",
            &serde_json::json!({"book_id": "b1", "query": "林雪"}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["total"], 1);
        assert_eq!(obj["cards"][0]["name"], "林雪");

        // 无命中
        let out = execute_tool(
            &conn,
            "search_world_cards",
            &serde_json::json!({"book_id": "b1", "query": "不存在的人"}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["total"], 0);
    }

    #[test]
    fn get_book_context_overview() {
        let conn = test_conn();
        let out = execute_tool(
            &conn,
            "get_book_context",
            &serde_json::json!({"book_id": "b1"}),
        )
        .unwrap();
        assert!(out.contains("《测试书》"));
        assert!(out.contains("第一章: 本章摘要"));
        assert!(out.contains("第二章: (无摘要)"));
        assert!(out.contains("[char] 林雪: 冷静的女剑客"));
    }

    // ── 领域工具：拆章 ──

    #[test]
    fn html_to_plain_keeps_paragraph_boundaries() {
        // 直接 strip_html 会把两段挤成一行「甲乙」；html_to_plain 必须保留边界
        let plain = html_to_plain("<p>甲</p><p>乙</p>");
        assert!(plain.contains("甲\n"), "{plain:?}");
        assert!(plain.contains("乙"), "{plain:?}");

        // 自闭合与大写块级标签同样折算为换行（开闭各一次 → 4 个换行）
        let plain = html_to_plain("<DIV>a</DIV><br/><h2>标题</h2>");
        assert_eq!(plain.matches('\n').count(), 4, "{plain:?}");

        // 行内标签不引入换行
        assert_eq!(html_to_plain("<p><strong>粗</strong><em>斜</em></p>").trim(), "粗斜");

        // 实体解码（用 \u{26} 拼接，避免源码字面量在清理管线里被二次转义）
        let amp = '\u{26}';
        assert_eq!(decode_entities(&format!("a{amp}nbsp;b")), "a b");
        assert_eq!(decode_entities(&format!("x{amp}lt;y{amp}gt;z")), "x<y>z");
        // 双重转义须解一层：先解 lt/gt 会失败，最后解 amp 才得到字面 `<`
        assert_eq!(decode_entities(&format!("{amp}amp;lt;")), format!("{amp}lt;"));
    }

    #[test]
    fn split_units_falls_back_to_hard_chunks() {
        // 无标点的长段落：句切分退化后按字数硬切，保证单元不超上限
        let units = split_units(&"字".repeat(500), 200);
        assert_eq!(units.len(), 3, "{units:?}");
        assert!(units.iter().all(|u| u.chars().count() <= 200));

        // 段落未超限时不主动按句拆（优先保持段落完整）
        assert_eq!(split_units("甲。乙。", 20), vec!["甲。乙。"]);

        // 段落超限才降级到句切分，单个句子保留完整
        assert_eq!(
            split_units("一二三。四五六。七八九。", 5),
            vec!["一二三。", "四五六。", "七八九。"]
        );
    }

    #[test]
    fn split_into_segments_respects_max_chars() {
        // 每段严格不超上限（计长含单元间换行）
        let segs = split_into_segments(&"字".repeat(5000), 1200);
        assert_eq!(segs.len(), 5, "5000 / 1200 → 5 段");
        assert!(segs.iter().all(|s| s.chars().count() <= 1200));

        // 多段落按上限聚合：3 段各 4 字，上限 12 → 前两段合并、第三段独立
        let segs = split_into_segments("第一段。\n第二段。\n第三段。", 12);
        assert_eq!(segs.len(), 2, "{segs:?}");
        assert_eq!(segs[0], "第一段。\n第二段。");
        assert_eq!(segs[1], "第三段。");

        // 上限充裕时整章归一，段落以换行相连
        let segs = split_into_segments("甲。\n乙。", 1200);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0], "甲。\n乙。");
    }

    #[test]
    fn split_chapter_output_and_preview_cap() {
        let conn = test_conn();
        // 多段落章节（c4）在上限充裕时归为一段，且保留段落换行
        let out = execute_tool(
            &conn,
            "split_chapter",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c4", "max_chars": 1200}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["chapter"], "第四章");
        assert_eq!(obj["segment_count"], 1);
        assert!(obj["segments"][0]["text"]
            .as_str()
            .unwrap()
            .contains("第二段。"));
        assert!(obj.get("hint").is_none(), "片段数在上限内不应有 hint: {out}");

        // 上限压到最小（200）→ 25 段，超出 12 段的部分只给预览
        let out = execute_tool(
            &conn,
            "split_chapter",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c2", "max_chars": 10}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["max_chars"], 200, "低于下限须钳到 MIN_SPLIT_CHARS");
        assert_eq!(obj["segment_count"], 25);
        assert!(obj["hint"].as_str().unwrap().contains("调大 max_chars"), "{out}");
        let last = obj["segments"][24]["text"].as_str().unwrap();
        assert!(last.ends_with('…'), "超限片段只给预览: {last}");
        assert!(last.chars().count() < 200);

        // 摘要透出
        let out = execute_tool(
            &conn,
            "split_chapter",
            &serde_json::json!({"book_id": "b1", "chapter_id": "c1"}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["summary"], "本章摘要");
    }

    // ── 领域工具：生成卡片 ──

    #[test]
    fn create_note_card_writes_row_and_validates() {
        let conn = test_conn();
        let out = execute_tool(
            &conn,
            "create_note_card",
            &serde_json::json!({
                "book_id": "b1",
                "card_type": "misc",
                "title": "复利效应",
                "content": "长期小增益的指数累积。",
                "tags": ["第三章", "核心概念"],
            }),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(obj["ok"], true, "{out}");
        assert_eq!(obj["book"], "测试书");
        assert_eq!(obj["card_type"], "misc");
        let id = obj["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        // 真的落库，且标签原样保存
        let cards = repository::world_card_repo::list_by_book(&conn, "b1").unwrap();
        assert_eq!(cards.len(), 2, "原有 w1 + 新写入 1 张");
        let saved = cards.iter().find(|c| c.id == id).expect("新卡片应可查到");
        assert_eq!(saved.title, "复利效应");
        assert_eq!(
            saved.tags,
            vec!["第三章".to_string(), "核心概念".to_string()]
        );

        // 非法 card_type：结构化错误，且不落库（前端对未知类型无兜底，会崩渲染）
        let out = execute_tool(
            &conn,
            "create_note_card",
            &serde_json::json!({"book_id": "b1", "card_type": "concept", "title": "t", "content": "c"}),
        )
        .unwrap();
        let obj: Value = serde_json::from_str(&out).unwrap();
        assert!(obj["error"].as_str().unwrap().contains("card_type"), "{out}");
        assert_eq!(obj["allowed"].as_array().unwrap().len(), CARD_TYPES.len());
        assert_eq!(
            repository::world_card_repo::list_by_book(&conn, "b1")
                .unwrap()
                .len(),
            2,
            "校验失败不应写入"
        );

        // 空标题 / 空正文
        for field in ["title", "content"] {
            let mut args = serde_json::json!({
                "book_id": "b1", "card_type": "misc", "title": "t", "content": "c"
            });
            args[field] = serde_json::json!("");
            let out = execute_tool(&conn, "create_note_card", &args).unwrap();
            let obj: Value = serde_json::from_str(&out).unwrap();
            assert!(
                obj["error"].as_str().unwrap().contains("不能为空"),
                "{field}: {out}"
            );
        }

        // 书籍不存在 → Err
        let err = execute_tool(
            &conn,
            "create_note_card",
            &serde_json::json!({"book_id": "nope", "card_type": "misc", "title": "t", "content": "c"}),
        )
        .unwrap_err();
        assert!(err.to_string().contains("不存在"), "{err}");
    }

    #[test]
    fn domain_tools_are_registered_and_referenced() {
        // 两个领域工具都必须能在注册表查到（否则领域画像引用即静默失效）
        for name in ["split_chapter", "create_note_card"] {
            assert!(tool_def(name).is_some(), "{name} 未注册");
            assert!(tool_schema(name).is_some(), "{name} 缺少 schema");
        }
        // 卡片类型值域与前端 WorldCardType 一致，任一项不得在注册表外
        for t in ["character", "location", "timeline", "faction", "item", "misc"] {
            assert!(CARD_TYPES.contains(&t), "值域缺少 {t}");
        }
    }
}
