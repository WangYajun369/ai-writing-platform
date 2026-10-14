//! 单词关联网络业务服务
//!
//! 核心职责：
//! - **添加单词时自动建关系**（[`sync_auto_relations`]，尽力而为不阻断主流程）：
//!   1. AI 释义中的近/反义词 → 潜在关联（`source=ai`，不论关联词是否已收录）；
//!   2. 反向激活：存量关系中指向本词的，为本词补建反向关系；
//!   3. ECDICT 变形家族：仅当家族成员已在生词本时双向落库（`source=ecdict`），避免噪音。
//! - 手动关联增删（`source=manual`）、关联视图查询、变形家族建议。
//!
//! 自动同步属于后台簿记（单表多行幂等插入），不逐条写 SQL 审计，
//! 仅以 app_log 汇总；手动增删走 UnitOfWork 审计。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{
    VocabFamilyGroup, VocabGraph, VocabGraphEdge, VocabGraphNode, VocabKnowledge,
    VocabRelatedCandidate, VocabRelation, VocabRelationCount, VocabRelationView, VocabWord,
};
use crate::repository::{vocab_relation_repo, vocab_repo};
use crate::service::uow::UnitOfWork;
use crate::utils::{now, open_dict_db, validate_len};
use tauri::AppHandle;
use uuid::Uuid;

/// 合法关联类型白名单：近义 / 反义 / 派生 / 变形家族 / 手动
const RELATION_TYPES: &[&str] = &["synonym", "antonym", "derived", "inflection", "manual"];
/// 变形家族成员上限（避免高频词家族刷屏）
const FAMILY_LIMIT: usize = 12;
/// 词族复习分组数量上限
const FAMILY_GROUP_LIMIT: usize = 50;
/// 关联图谱节点数上限（超出按关联度截断）
const GRAPH_NODE_LIMIT: usize = 300;
/// 关联词文本长度上限（与生词一致）
const MAX_RELATED_LEN: usize = 100;

/// 校验并规范化关联词文本（小写、去空格、不含空白字符、非空）
fn normalize_related(raw: &str) -> Result<String, AppError> {
    let w = raw.trim().to_lowercase();
    validate_len("关联词", &w, MAX_RELATED_LEN)?;
    if w.is_empty() {
        return Err(AppError::Validation("关联词不能为空".to_string()));
    }
    if w.chars().any(|c| c.is_whitespace()) {
        return Err(AppError::Validation(
            "关联词仅支持单个单词（不能含空格）".to_string(),
        ));
    }
    Ok(w)
}

/// 从 AI 近/反义词条目提取英文词（剥离中文小注与括号，小写规范化）。
///
/// 条目形如 "happy（高兴的）" / "well-known"；取首个非 `[a-zA-Z-']` 字符前的部分，
/// 过滤空串与自身。词组类条目（如 "take off"）会退化为中心词 "take"。
pub(crate) fn extract_english_word(entry: &str, own_word: &str) -> Option<String> {
    let mut end = entry.len();
    for (i, c) in entry.char_indices() {
        if !(c.is_ascii_alphabetic() || c == '-' || c == '\'') {
            end = i;
            break;
        }
    }
    let w = entry[..end]
        .trim_matches(|c| c == '-' || c == '\'')
        .to_lowercase();
    if w.is_empty() || w == own_word {
        return None;
    }
    Some(w)
}

/// 解析 ECDICT exchange 字段中的原型 lemma（`0:` 项），无则 None。
///
/// exchange 形如 `p:worked/d:worked/i:working/3:works/0:work/1:ABC`（斜杠分隔 k:v）。
fn exchange_lemma(exchange: &str) -> Option<String> {
    for part in exchange.split('/') {
        if let Some(v) = part.strip_prefix("0:") {
            let v = v.trim().to_lowercase();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

/// 查询 ECDICT 变形家族：本词原型 lemma + 所有指向该 lemma 的变形词（排除自身，上限 12）。
///
/// LIKE 粗筛后在 Rust 侧精确解析 exchange 过滤，避免 `%0:at%` 误中 lemma=ate 之类前缀碰撞。
/// 词典未安装或本词未收录时返回空。
fn dict_family(app: &AppHandle, word: &str) -> Vec<String> {
    let Ok(Some(conn)) = open_dict_db(app) else {
        return Vec::new();
    };
    // 1. 本词 exchange → 原型 lemma（无 0: 项时视本词自身为 lemma）
    let exchange: Option<String> = conn
        .query_row(
            "SELECT exchange FROM stardict WHERE word = ?1 COLLATE NOCASE LIMIT 1",
            rusqlite::params![word],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let lemma = exchange
        .as_deref()
        .and_then(exchange_lemma)
        .unwrap_or_else(|| word.to_string());

    // 2. LIKE 粗筛候选，再精确比对 lemma
    let escaped = lemma
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%0:{}%", escaped);
    let mut stmt = match conn.prepare(
        "SELECT word, exchange FROM stardict WHERE exchange LIKE ?1 ESCAPE '\\' LIMIT 64",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(rusqlite::params![pattern], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        ))
    });
    let Ok(rows) = rows else {
        return Vec::new();
    };
    let mut family: Vec<String> = rows
        .filter_map(std::result::Result::ok)
        .filter(|(_, ex)| exchange_lemma(ex).as_deref() == Some(lemma.as_str()))
        .map(|(w, _)| w.to_lowercase())
        .collect();
    // 3. 原型本身也算家族成员（lemma 词条的 exchange 通常不含 0: 项，LIKE 查不到）
    if lemma != word {
        family.push(lemma);
    }
    family.retain(|w| w != word && !w.contains(' '));
    family.sort();
    family.dedup();
    family.sort_by_key(|w| w.len());
    family.truncate(FAMILY_LIMIT);
    family
}

/// 第 1 步：AI 近/反义词 → (word → related) 潜在关联。返回新增条数。
fn sync_knowledge_relations(
    conn: &rusqlite::Connection,
    word_id: &str,
    word: &str,
    knowledge: Option<&VocabKnowledge>,
) -> Result<usize, AppError> {
    let Some(k) = knowledge else {
        return Ok(0);
    };
    let ts = now();
    let mut inserted = 0usize;
    for (entries, ty) in [(&k.synonyms, "synonym"), (&k.antonyms, "antonym")] {
        for e in entries {
            let Some(rel) = extract_english_word(e, word) else {
                continue;
            };
            if vocab_relation_repo::insert_ignore(
                conn,
                vocab_relation_repo::InsertRelationArgs {
                    id: &Uuid::new_v4().to_string(),
                    word_id,
                    related_word: &rel,
                    relation_type: ty,
                    source: "ai",
                    ts: &ts,
                },
            )? {
                inserted += 1;
            }
        }
    }
    Ok(inserted)
}

/// 第 2 步：反向激活 —— 存量 (owner → word) 关系，为本词补建 (word → owner) 反向关系。
/// 近义↔近义、反义↔反义，类型与来源沿袭原关系。返回新增条数。
fn activate_reverse_relations(
    conn: &rusqlite::Connection,
    word_id: &str,
    word: &str,
) -> Result<usize, AppError> {
    let ts = now();
    let mut inserted = 0usize;
    for rel in vocab_relation_repo::list_pointing_to(conn, word)? {
        if rel.word_id == word_id {
            continue;
        }
        let Some(owner) = vocab_repo::find_by_id(conn, &rel.word_id)? else {
            continue;
        };
        if vocab_relation_repo::insert_ignore(
            conn,
            vocab_relation_repo::InsertRelationArgs {
                id: &Uuid::new_v4().to_string(),
                word_id,
                related_word: &owner.word,
                relation_type: &rel.relation_type,
                source: &rel.source,
                ts: &ts,
            },
        )? {
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// 第 3 步：ECDICT 变形家族 —— 仅当家族成员已在生词本时双向落库。返回新增条数。
fn sync_inflection_family(
    app: &AppHandle,
    conn: &rusqlite::Connection,
    word_id: &str,
    word: &str,
) -> Result<usize, AppError> {
    let family = dict_family(app, word);
    if family.is_empty() {
        return Ok(0);
    }
    let ts = now();
    let mut inserted = 0usize;
    let existing = vocab_relation_repo::existing_word_texts(conn, &family)?;
    for member in existing {
        if member == word {
            continue;
        }
        // 变形家族关系天然对称：word → member 与 member → word 一并落库
        let Some(mw) = vocab_repo::find_by_word(conn, &member)? else {
            continue;
        };
        for (wid, rel_word) in [(word_id, member.as_str()), (mw.id.as_str(), word)] {
            if vocab_relation_repo::insert_ignore(
                conn,
                vocab_relation_repo::InsertRelationArgs {
                    id: &Uuid::new_v4().to_string(),
                    word_id: wid,
                    related_word: rel_word,
                    relation_type: "inflection",
                    source: "ecdict",
                    ts: &ts,
                },
            )? {
                inserted += 1;
            }
        }
    }
    Ok(inserted)
}

/// 添加单词后的自动关系同步（尽力而为：调用方应捕获错误仅记日志，不阻断收录主流程）。
pub fn sync_auto_relations(
    app: &AppHandle,
    db: &AppDb,
    word_id: &str,
    word: &str,
    knowledge: Option<&VocabKnowledge>,
) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let mut n = sync_knowledge_relations(&conn, word_id, word, knowledge)?;
    n += activate_reverse_relations(&conn, word_id, word)?;
    n += sync_inflection_family(app, &conn, word_id, word)?;
    if n > 0 {
        crate::app_log!("[vocab] 自动关联同步 word={word} 新增关系 {n} 条");
    }
    Ok(())
}

// ───────────────────────── 查询 / 手动增删 ─────────────────────────

/// 某生词的全部关联（含关联词收录状态）
pub fn list_relations(db: &AppDb, word_id: &str) -> Result<Vec<VocabRelationView>, AppError> {
    let conn = db.pool.get()?;
    Ok(vocab_relation_repo::list_for_word(&conn, word_id)?)
}

/// 手动添加关联（幂等：同三元组已存在时直接返回原关系）
pub fn add_relation(
    app: &AppHandle,
    db: &AppDb,
    word_id: &str,
    related_word: &str,
    relation_type: &str,
) -> Result<VocabRelation, AppError> {
    if !RELATION_TYPES.contains(&relation_type) {
        return Err(AppError::Validation(format!(
            "不合法的关联类型: {relation_type}（应为 {}）",
            RELATION_TYPES.join(" / ")
        )));
    }
    let related = normalize_related(related_word)?;
    let conn = db.pool.get()?;
    let owner = vocab_repo::find_by_id(&conn, word_id)?
        .ok_or_else(|| AppError::NotFound(format!("生词不存在: {word_id}")))?;
    if related == owner.word {
        return Err(AppError::Validation("不能与自身建立关联".to_string()));
    }

    let ts = now();
    let id = Uuid::new_v4().to_string();
    let mut uow = UnitOfWork::new(&conn, Some(app));
    uow.audit(
        "INSERT",
        "vocab_word_relations",
        format!("word={}, related={related}, type={relation_type}", owner.word),
        file!(),
        line!(),
    );
    vocab_relation_repo::insert_ignore(
        uow.conn(),
        vocab_relation_repo::InsertRelationArgs {
            id: &id,
            word_id,
            related_word: &related,
            relation_type,
            source: "manual",
            ts: &ts,
        },
    )?;
    uow.commit()?;
    vocab_relation_repo::find_one(&conn, word_id, &related, relation_type)?
        .ok_or_else(|| AppError::Business("关联回读失败".to_string()))
}

/// 删除一条关联
pub fn remove_relation(app: &AppHandle, db: &AppDb, id: &str) -> Result<(), AppError> {
    let conn = db.pool.get()?;
    let mut uow = UnitOfWork::new(&conn, Some(app));
    uow.audit(
        "DELETE",
        "vocab_word_relations",
        format!("id={id}"),
        file!(),
        line!(),
    );
    vocab_relation_repo::delete_by_id(uow.conn(), id)?;
    uow.commit()?;
    Ok(())
}

/// ECDICT 变形家族建议（标注各成员是否已收录；未收录成员仅供前端提示，不落库）
pub fn suggest_family(
    app: &AppHandle,
    db: &AppDb,
    word: &str,
) -> Result<Vec<VocabRelatedCandidate>, AppError> {
    let w = word.trim().to_lowercase();
    if w.is_empty() {
        return Ok(Vec::new());
    }
    let family = dict_family(app, &w);
    if family.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.pool.get()?;
    let existing: std::collections::HashSet<String> =
        vocab_relation_repo::existing_word_texts(&conn, &family)?
            .into_iter()
            .collect();
    Ok(family
        .into_iter()
        .map(|f| VocabRelatedCandidate {
            in_vocab: existing.contains(&f),
            word: f,
        })
        .collect())
}

// ───────────────────────── 词族复习 / 关系统计 ─────────────────────────

/// 全库关联条数（生词列表徽标用）
pub fn relation_counts(db: &AppDb) -> Result<Vec<VocabRelationCount>, AppError> {
    let conn = db.pool.get()?;
    let rows = vocab_relation_repo::count_by_word(&conn)?;
    Ok(rows
        .into_iter()
        .map(|(word_id, count)| VocabRelationCount { word_id, count })
        .collect())
}

/// 查词典原型 lemma：ECDICT exchange 的 `0:` 字段；未收录或无原型信息时回退为词本身
fn dict_lemma(conn: &rusqlite::Connection, word: &str) -> String {
    let exchange: Option<String> = conn
        .query_row(
            "SELECT exchange FROM stardict WHERE word = ?1 COLLATE NOCASE LIMIT 1",
            rusqlite::params![word],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    exchange
        .as_deref()
        .and_then(exchange_lemma)
        .unwrap_or_else(|| word.to_string())
}

/// 纯函数：按 lemma 聚族 —— ≥2 成员成族，族内按字母序，族间按成员数降序
/// （同数按 lemma 字母序），封顶 [`FAMILY_GROUP_LIMIT`]
fn group_by_lemma(
    words: Vec<VocabWord>,
    lemma_of: impl Fn(&str) -> String,
) -> Vec<VocabFamilyGroup> {
    let mut by_lemma: std::collections::HashMap<String, Vec<VocabWord>> =
        std::collections::HashMap::new();
    for w in words {
        by_lemma.entry(lemma_of(&w.word)).or_default().push(w);
    }
    let mut groups: Vec<VocabFamilyGroup> = by_lemma
        .into_iter()
        .filter(|(_, members)| members.len() >= 2)
        .map(|(lemma, mut members)| {
            members.sort_by(|a, b| a.word.cmp(&b.word));
            VocabFamilyGroup {
                lemma,
                words: members,
            }
        })
        .collect();
    groups.sort_by(|a, b| {
        b.words
            .len()
            .cmp(&a.words.len())
            .then_with(|| a.lemma.cmp(&b.lemma))
    });
    groups.truncate(FAMILY_GROUP_LIMIT);
    groups
}

/// 词族复习分组：扫描学习中生词，按 ECDICT 原型 lemma 聚族（词典未安装时返回空）
pub fn family_groups(app: &AppHandle, db: &AppDb) -> Result<Vec<VocabFamilyGroup>, AppError> {
    let conn = db.pool.get()?;
    let words = vocab_repo::list_words(&conn, Some("learning"), None)?;
    if words.len() < 2 {
        return Ok(Vec::new());
    }
    let Ok(Some(dict)) = open_dict_db(app) else {
        return Ok(Vec::new());
    };
    Ok(group_by_lemma(words, |w| dict_lemma(&dict, w)))
}

// ───────────────────────── 关联图谱 ─────────────────────────

/// 纯函数：由关系行构建图谱（便于单测）。
///
/// - 边无向化：对称关系（如变形家族双向落库）按无序节点对 + 类型去重，只保留一条边；
/// - `include_potential=false` 时丢弃关联词未收录的边；为 true 时未收录词作为
///   `potential` 叶子节点（id 为 `p:<word>`）；
/// - `status`（all/learning/mastered/suspended）：任一端命中即保留该边；
/// - 节点超过 `limit` 时按度数降序（同数按词字母序）截断，丢弃悬空边并标记 truncated。
fn build_graph(
    rows: Vec<vocab_relation_repo::GraphRow>,
    include_potential: bool,
    status: Option<&str>,
    limit: usize,
) -> VocabGraph {
    use std::collections::{HashMap, HashSet};
    let filter = status.filter(|s| *s != "all" && !s.is_empty());
    let mut nodes: HashMap<String, VocabGraphNode> = HashMap::new();
    let mut edge_keys: HashSet<(String, String, String)> = HashSet::new();
    let mut edges: Vec<VocabGraphEdge> = Vec::new();

    for row in rows {
        if let Some(s) = filter {
            let hit = row.owner_status == s || row.rel_status.as_deref() == Some(s);
            if !hit {
                continue;
            }
        }
        let (rel_id, rel_status) = match row.rel_vocab_id {
            Some(id) => (id, row.rel_status.clone().unwrap_or_default()),
            None => {
                if !include_potential {
                    continue;
                }
                (
                    format!("p:{}", row.related_word),
                    "potential".to_string(),
                )
            }
        };
        // 无向去重键
        let (a, b) = if row.owner_id <= rel_id {
            (row.owner_id.clone(), rel_id.clone())
        } else {
            (rel_id.clone(), row.owner_id.clone())
        };
        if !edge_keys.insert((a.clone(), b.clone(), row.relation_type.clone())) {
            continue;
        }
        nodes
            .entry(row.owner_id.clone())
            .or_insert_with(|| VocabGraphNode {
                id: row.owner_id.clone(),
                word: row.owner_word.clone(),
                status: row.owner_status.clone(),
                degree: 0,
            });
        nodes.entry(rel_id.clone()).or_insert_with(|| VocabGraphNode {
            id: rel_id,
            word: row.related_word.clone(),
            status: rel_status,
            degree: 0,
        });
        if let Some(n) = nodes.get_mut(&a) {
            n.degree += 1;
        }
        if let Some(n) = nodes.get_mut(&b) {
            n.degree += 1;
        }
        edges.push(VocabGraphEdge {
            source: a,
            target: b,
            relation_type: row.relation_type,
        });
    }

    let mut node_list: Vec<VocabGraphNode> = nodes.into_values().collect();
    node_list.sort_by(|x, y| y.degree.cmp(&x.degree).then_with(|| x.word.cmp(&y.word)));
    let truncated = node_list.len() > limit;
    if truncated {
        node_list.truncate(limit);
        let keep: HashSet<&str> = node_list.iter().map(|n| n.id.as_str()).collect();
        edges.retain(|e| keep.contains(e.source.as_str()) && keep.contains(e.target.as_str()));
        // 截断丢弃悬空边后按保留边重算度数，避免节点半径与「N 个关联」虚高
        let mut deg: HashMap<&str, i64> = HashMap::new();
        for e in &edges {
            *deg.entry(e.source.as_str()).or_insert(0) += 1;
            *deg.entry(e.target.as_str()).or_insert(0) += 1;
        }
        for n in &mut node_list {
            n.degree = deg.get(n.id.as_str()).copied().unwrap_or(0);
        }
    }
    VocabGraph {
        nodes: node_list,
        edges,
        truncated,
        isolated_count: 0, // 由 graph() 查询填充（纯构图函数不依赖数据库）
    }
}

/// 关联图谱：全库词为节点、关系为边（节点封顶 [`GRAPH_NODE_LIMIT`]）
pub fn graph(
    db: &AppDb,
    include_potential: bool,
    status: Option<&str>,
) -> Result<VocabGraph, AppError> {
    let conn = db.pool.get()?;
    let rows = vocab_relation_repo::graph_rows(&conn)?;
    let mut g = build_graph(rows, include_potential, status, GRAPH_NODE_LIMIT);
    g.isolated_count = vocab_relation_repo::count_isolated_words(&conn)?;
    Ok(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存库：vocab_words 全列（vocab_repo::WORD_COLS 依赖）+ 完整 vocab_word_relations
    fn setup() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE vocab_words (
                id TEXT PRIMARY KEY,
                word TEXT NOT NULL UNIQUE,
                phonetic TEXT NOT NULL DEFAULT '',
                meanings TEXT NOT NULL DEFAULT '[]',
                example TEXT NOT NULL DEFAULT '',
                example_zh TEXT NOT NULL DEFAULT '',
                repetition INTEGER NOT NULL DEFAULT 0,
                interval_days INTEGER NOT NULL DEFAULT 0,
                ease_factor REAL NOT NULL DEFAULT 2.5,
                status TEXT NOT NULL DEFAULT 'learning',
                next_review_at TEXT,
                last_review_at TEXT,
                review_count INTEGER NOT NULL DEFAULT 0,
                correct_count INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'manual',
                ai_details TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE vocab_word_relations (
                id            TEXT PRIMARY KEY,
                word_id       TEXT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
                related_word  TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                source        TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                UNIQUE(word_id, related_word, relation_type)
             );
             INSERT INTO vocab_words (id, word, status, created_at, updated_at) VALUES
                ('w1', 'happy', 'learning', '2026-01-01', '2026-01-01'),
                ('w2', 'glad', 'mastered', '2026-01-01', '2026-01-01');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn extract_english_word_strips_chinese_note() {
        assert_eq!(
            extract_english_word("happy（高兴的）", "joy"),
            Some("happy".to_string())
        );
        assert_eq!(
            extract_english_word("well-known（众所周知的）", "famous"),
            Some("well-known".to_string())
        );
        assert_eq!(extract_english_word("sad", "happy"), Some("sad".to_string()));
        // 自身 / 空串 / 纯中文 → None
        assert_eq!(extract_english_word("happy", "happy"), None);
        assert_eq!(extract_english_word("（高兴的）", "joy"), None);
    }

    #[test]
    fn exchange_lemma_parses_zero_field() {
        assert_eq!(
            exchange_lemma("p:worked/d:worked/i:working/3:works/0:work/1:ABC"),
            Some("work".to_string())
        );
        assert_eq!(exchange_lemma("p:worked/d:worked"), None);
        assert_eq!(exchange_lemma(""), None);
    }

    #[test]
    fn sync_knowledge_relations_inserts_and_is_idempotent() {
        let conn = setup();
        let knowledge = VocabKnowledge {
            synonyms: vec!["glad（高兴的）".into(), "joyful".into()],
            antonyms: vec!["sad（难过的）".into()],
            ..Default::default()
        };
        let n = sync_knowledge_relations(&conn, "w1", "happy", Some(&knowledge)).unwrap();
        assert_eq!(n, 3);
        let list = vocab_relation_repo::list_for_word(&conn, "w1").unwrap();
        assert_eq!(list.len(), 3);
        // glad 已收录 → in_vocab；joyful/sad 未收录 → 潜在关联
        let glad = list.iter().find(|v| v.relation.related_word == "glad").unwrap();
        assert!(glad.in_vocab);
        assert_eq!(glad.relation.relation_type, "synonym");
        assert_eq!(glad.relation.source, "ai");
        let sad = list.iter().find(|v| v.relation.related_word == "sad").unwrap();
        assert!(!sad.in_vocab);
        assert_eq!(sad.relation.relation_type, "antonym");
        // 幂等重放：再次同步新增 0 条
        let n2 = sync_knowledge_relations(&conn, "w1", "happy", Some(&knowledge)).unwrap();
        assert_eq!(n2, 0);
        assert_eq!(vocab_relation_repo::list_for_word(&conn, "w1").unwrap().len(), 3);
    }

    #[test]
    fn activate_reverse_relations_backfills_inverse() {
        let conn = setup();
        // 存量：glad(w2) 曾把 happy 标为近义词（happy 当时未收录，潜在关联）
        vocab_relation_repo::insert_ignore(
            &conn,
            vocab_relation_repo::InsertRelationArgs {
                id: "r1",
                word_id: "w2",
                related_word: "happy",
                relation_type: "synonym",
                source: "ai",
                ts: "2026-01-01T00:00:00Z",
            },
        )
        .unwrap();
        // happy(w1) 收录后反向激活：补 (happy → glad)
        let n = activate_reverse_relations(&conn, "w1", "happy").unwrap();
        assert_eq!(n, 1);
        let list = vocab_relation_repo::list_for_word(&conn, "w1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].relation.related_word, "glad");
        assert_eq!(list[0].relation.relation_type, "synonym");
        assert!(list[0].in_vocab);
        // 幂等：重复激活新增 0
        assert_eq!(activate_reverse_relations(&conn, "w1", "happy").unwrap(), 0);
    }

    #[test]
    fn normalize_related_rejects_blank_and_spaces() {
        assert_eq!(normalize_related("  Joyful ").unwrap(), "joyful");
        assert!(normalize_related("   ").is_err());
        assert!(normalize_related("take off").is_err());
    }

    /// 构造最小 VocabWord（分组纯函数只读 word 字段）
    fn vw(id: &str, word: &str) -> VocabWord {
        VocabWord {
            id: id.into(),
            word: word.into(),
            phonetic: String::new(),
            meanings: vec![],
            example: String::new(),
            example_zh: String::new(),
            repetition: 0,
            interval_days: 0,
            ease_factor: 2.5,
            status: "learning".into(),
            next_review_at: None,
            last_review_at: None,
            review_count: 0,
            correct_count: 0,
            source: "manual".into(),
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
            knowledge: None,
        }
    }

    #[test]
    fn group_by_lemma_forms_families_sorted() {
        let words = vec![
            vw("w1", "work"),
            vw("w2", "worked"),
            vw("w3", "working"),
            vw("w4", "play"),
            vw("w5", "played"),
            vw("w6", "alone"), // 单词族 → 过滤
        ];
        let lemma_of = |w: &str| match w {
            "worked" | "working" => "work".to_string(),
            "played" => "play".to_string(),
            other => other.to_string(),
        };
        let groups = group_by_lemma(words, lemma_of);
        assert_eq!(groups.len(), 2);
        // 成员数降序：work 族 3 人排前
        assert_eq!(groups[0].lemma, "work");
        assert_eq!(groups[0].words.len(), 3);
        assert_eq!(groups[1].lemma, "play");
        assert_eq!(groups[1].words.len(), 2);
        // 族内字母序
        let names: Vec<&str> = groups[0].words.iter().map(|w| w.word.as_str()).collect();
        assert_eq!(names, ["work", "worked", "working"]);
    }

    #[test]
    fn group_by_lemma_caps_at_limit() {
        // 构造 60 个双成员族 → 封顶 FAMILY_GROUP_LIMIT
        let mut words = Vec::new();
        for i in 0..60 {
            words.push(vw(&format!("a{i}"), &format!("lemma{i}")));
            words.push(vw(&format!("b{i}"), &format!("lemma{i}s")));
        }
        let groups = group_by_lemma(words, |w| w.trim_end_matches('s').to_string());
        assert_eq!(groups.len(), FAMILY_GROUP_LIMIT);
        assert!(groups.iter().all(|g| g.words.len() == 2));
    }

    // ── 关联图谱 ──

    /// 便捷插关系 + 插生词
    fn ins_rel(conn: &rusqlite::Connection, id: &str, wid: &str, rel: &str, ty: &str) {
        vocab_relation_repo::insert_ignore(
            conn,
            vocab_relation_repo::InsertRelationArgs {
                id,
                word_id: wid,
                related_word: rel,
                relation_type: ty,
                source: "ai",
                ts: "2026-01-01T00:00:00Z",
            },
        )
        .unwrap();
    }

    #[test]
    fn build_graph_excludes_potential_by_default() {
        let conn = setup();
        ins_rel(&conn, "r1", "w1", "glad", "synonym"); // w2 已收录
        ins_rel(&conn, "r2", "w1", "joyful", "synonym"); // 未收录 → 潜在关联
        // 默认：潜在关联不出图
        let g = build_graph(vocab_relation_repo::graph_rows(&conn).unwrap(), false, None, 10);
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
        assert!(!g.truncated);
        // 开启：joyful 作为 potential 叶子节点
        let g = build_graph(vocab_relation_repo::graph_rows(&conn).unwrap(), true, None, 10);
        assert_eq!(g.nodes.len(), 3);
        assert_eq!(g.edges.len(), 2);
        let leaf = g.nodes.iter().find(|n| n.word == "joyful").unwrap();
        assert_eq!(leaf.id, "p:joyful");
        assert_eq!(leaf.status, "potential");
        assert_eq!(leaf.degree, 1);
    }

    #[test]
    fn build_graph_dedupes_symmetric_edges() {
        let conn = setup();
        // 变形家族对称落库：两个方向各一条 → 图中仅一条边
        ins_rel(&conn, "r1", "w1", "glad", "inflection");
        ins_rel(&conn, "r2", "w2", "happy", "inflection");
        let g = build_graph(vocab_relation_repo::graph_rows(&conn).unwrap(), false, None, 10);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].relation_type, "inflection");
        assert!(g.nodes.iter().all(|n| n.degree == 1));
    }

    #[test]
    fn build_graph_filters_by_status() {
        let conn = setup();
        ins_rel(&conn, "r1", "w1", "glad", "synonym"); // learning ↔ mastered
        let rows = || vocab_relation_repo::graph_rows(&conn).unwrap();
        // 任一端命中即保留
        assert_eq!(build_graph(rows(), false, Some("learning"), 10).edges.len(), 1);
        assert_eq!(build_graph(rows(), false, Some("mastered"), 10).edges.len(), 1);
        // 两端都不命中 → 空图
        let g = build_graph(rows(), false, Some("suspended"), 10);
        assert!(g.nodes.is_empty() && g.edges.is_empty());
        // all / None 不过滤
        assert_eq!(build_graph(rows(), false, Some("all"), 10).edges.len(), 1);
    }

    #[test]
    fn build_graph_truncates_by_degree() {
        let conn = setup();
        conn.execute(
            "INSERT INTO vocab_words (id, word, status, created_at, updated_at) \
             VALUES ('w3', 'merry', 'learning', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        // happy 度数 3，glad/merry/joyful 各 1
        ins_rel(&conn, "r1", "w1", "glad", "synonym");
        ins_rel(&conn, "r2", "w1", "merry", "synonym");
        ins_rel(&conn, "r3", "w1", "joyful", "synonym");
        let g = build_graph(vocab_relation_repo::graph_rows(&conn).unwrap(), true, None, 2);
        assert!(g.truncated);
        assert_eq!(g.nodes.len(), 2);
        // 度数降序 + 词字母序：happy(3) 与 glad(1) 保留
        assert_eq!(g.nodes[0].word, "happy");
        assert_eq!(g.nodes[1].word, "glad");
        // 悬空边被丢弃，仅余 happy-glad
        assert_eq!(g.edges.len(), 1);
        // 截断后度数按保留边重算（不再虚高为截断前的 3 / 1）
        assert_eq!(g.nodes[0].degree, 1);
        assert_eq!(g.nodes[1].degree, 1);
    }
}
