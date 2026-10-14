//! 单词关联网络数据访问层（vocab_word_relations）
//!
//! 提供关系表的纯 SQL 操作：幂等插入 / 属主查询（含关联词收录状态）/
//! 按 id 删除 / 反查指向某词的关系（反向激活用）/ 批量在库检测。
//! 业务规则（关系类型白名单、文本规范化、反向激活）在 service 层完成。

use crate::models::{VocabRelation, VocabRelationView};
use rusqlite::{params, Connection, Result};

/// SELECT 常用列（顺序固定，row_to_relation 依赖此顺序）
const RELATION_COLS: &str = "id, word_id, related_word, relation_type, source, created_at";

/// 按固定列序从行中解析 VocabRelation
fn row_to_relation(row: &rusqlite::Row) -> rusqlite::Result<VocabRelation> {
    Ok(VocabRelation {
        id: row.get(0)?,
        word_id: row.get(1)?,
        related_word: row.get(2)?,
        relation_type: row.get(3)?,
        source: row.get(4)?,
        created_at: row.get(5)?,
    })
}

/// insert_ignore 的业务参数封装（除 conn 外）
#[derive(Debug)]
pub struct InsertRelationArgs<'a> {
    pub id: &'a str,
    pub word_id: &'a str,
    pub related_word: &'a str,
    pub relation_type: &'a str,
    pub source: &'a str,
    pub ts: &'a str,
}

/// 幂等插入关系（UNIQUE(word_id, related_word, relation_type) 冲突时忽略）。
/// 返回是否真正插入了新行（false = 已存在跳过）。
pub fn insert_ignore(conn: &Connection, args: InsertRelationArgs<'_>) -> Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO vocab_word_relations \
         (id, word_id, related_word, relation_type, source, created_at) \
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            args.id,
            args.word_id,
            args.related_word,
            args.relation_type,
            args.source,
            args.ts
        ],
    )?;
    Ok(n > 0)
}

/// 某生词的全部关联（LEFT JOIN 标注关联词在生词本中的收录状态）
pub fn list_for_word(conn: &Connection, word_id: &str) -> Result<Vec<VocabRelationView>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.word_id, r.related_word, r.relation_type, r.source, r.created_at, \
                w.id, w.status \
         FROM vocab_word_relations r \
         LEFT JOIN vocab_words w ON w.word = r.related_word COLLATE NOCASE \
         WHERE r.word_id = ?1 \
         ORDER BY r.relation_type ASC, r.created_at ASC",
    )?;
    let items = stmt.query_map(params![word_id], |row| {
        let vocab_word_id: Option<String> = row.get(6)?;
        Ok(VocabRelationView {
            in_vocab: vocab_word_id.is_some(),
            vocab_word_id,
            vocab_status: row.get(7)?,
            relation: VocabRelation {
                id: row.get(0)?,
                word_id: row.get(1)?,
                related_word: row.get(2)?,
                relation_type: row.get(3)?,
                source: row.get(4)?,
                created_at: row.get(5)?,
            },
        })
    })?;
    items.collect()
}

/// 按 id 删除关系
pub fn delete_by_id(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vocab_word_relations WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// 反查：related_word 指向某词文本的全部关系（反向激活潜在关联用）
pub fn list_pointing_to(conn: &Connection, related_word: &str) -> Result<Vec<VocabRelation>> {
    let sql = format!(
        "SELECT {} FROM vocab_word_relations WHERE related_word = ?1 COLLATE NOCASE",
        RELATION_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt.query_map(params![related_word], row_to_relation)?;
    items.collect()
}

/// 按三元组精确查找（手动添加幂等回读用）
pub fn find_one(
    conn: &Connection,
    word_id: &str,
    related_word: &str,
    relation_type: &str,
) -> Result<Option<VocabRelation>> {
    let sql = format!(
        "SELECT {} FROM vocab_word_relations \
         WHERE word_id = ?1 AND related_word = ?2 COLLATE NOCASE AND relation_type = ?3",
        RELATION_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![word_id, related_word, relation_type], row_to_relation)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// 全库关系统计：每个属主生词的关联条数（生词列表徽标用）
pub fn count_by_word(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt =
        conn.prepare("SELECT word_id, COUNT(*) FROM vocab_word_relations GROUP BY word_id")?;
    let items = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    items.collect()
}

/// 批量检测哪些词文本已收录进生词本（大小写不敏感），返回已收录的词文本（小写库内形式）
pub fn existing_word_texts(conn: &Connection, words: &[String]) -> Result<Vec<String>> {
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<String> = (1..=words.len()).map(|i| format!("?{}", i)).collect();
    let sql = format!(
        "SELECT word FROM vocab_words WHERE word COLLATE NOCASE IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::types::ToSql> =
        words.iter().map(|w| w as &dyn rusqlite::types::ToSql).collect();
    let items = stmt.query_map(refs.as_slice(), |row| row.get::<_, String>(0))?;
    items.collect()
}

/// 全库无任何关联的生词数：既未作为属主建立关系、词文本也未被任何关系指向
/// （关联图谱「孤立词」提示用；全库口径，不受状态筛选影响）
pub fn count_isolated_words(conn: &Connection) -> Result<i64> {
    let n = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words w \
         WHERE NOT EXISTS (SELECT 1 FROM vocab_word_relations r WHERE r.word_id = w.id) \
           AND NOT EXISTS ( \
             SELECT 1 FROM vocab_word_relations r2 \
             JOIN vocab_words w2 ON w2.word = r2.related_word COLLATE NOCASE \
             WHERE w2.id = w.id \
           )",
        [],
        |row| row.get(0),
    )?;
    Ok(n)
}

/// 图谱查询行：一条关系 + 两端生词信息（关联词未收录时右端为 None）
#[derive(Debug)]
pub struct GraphRow {
    pub owner_id: String,
    pub owner_word: String,
    pub owner_status: String,
    pub related_word: String,
    pub relation_type: String,
    pub rel_vocab_id: Option<String>,
    pub rel_status: Option<String>,
}

/// 全库关系 + 两端生词状态（关联图谱数据源；业务过滤/截断在 service 层）
pub fn graph_rows(conn: &Connection) -> Result<Vec<GraphRow>> {
    let mut stmt = conn.prepare(
        "SELECT w.id, w.word, w.status, r.related_word, r.relation_type, rw.id, rw.status \
         FROM vocab_word_relations r \
         JOIN vocab_words w ON w.id = r.word_id \
         LEFT JOIN vocab_words rw ON rw.word = r.related_word COLLATE NOCASE",
    )?;
    let items = stmt.query_map([], |row| {
        Ok(GraphRow {
            owner_id: row.get(0)?,
            owner_word: row.get(1)?,
            owner_status: row.get(2)?,
            related_word: row.get(3)?,
            relation_type: row.get(4)?,
            rel_vocab_id: row.get(5)?,
            rel_status: row.get(6)?,
        })
    })?;
    items.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存库：最小 vocab_words + 完整 vocab_word_relations（外键开启以验证级联）
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE vocab_words (id TEXT PRIMARY KEY, word TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'learning');
             CREATE TABLE vocab_word_relations (
                id            TEXT PRIMARY KEY,
                word_id       TEXT NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
                related_word  TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                source        TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                UNIQUE(word_id, related_word, relation_type)
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vocab_words (id, word, status) VALUES ('w1', 'happy', 'learning'), ('w2', 'glad', 'mastered')",
            [],
        )
        .unwrap();
        conn
    }

    fn args<'a>(id: &'a str, word_id: &'a str, related: &'a str, ty: &'a str) -> InsertRelationArgs<'a> {
        InsertRelationArgs {
            id,
            word_id,
            related_word: related,
            relation_type: ty,
            source: "ai",
            ts: "2026-01-01T00:00:00Z",
        }
    }

    #[test]
    fn insert_ignore_dedups_on_unique_triple() {
        let conn = setup();
        assert!(insert_ignore(&conn, args("r1", "w1", "joyful", "synonym")).unwrap());
        // 同三元组冲突 → 跳过
        assert!(!insert_ignore(&conn, args("r2", "w1", "joyful", "synonym")).unwrap());
        // 不同 relation_type → 允许
        assert!(insert_ignore(&conn, args("r3", "w1", "joyful", "derived")).unwrap());
        let list = list_for_word(&conn, "w1").unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn list_for_word_joins_vocab_status() {
        let conn = setup();
        insert_ignore(&conn, args("r1", "w1", "glad", "synonym")).unwrap(); // 已收录
        insert_ignore(&conn, args("r2", "w1", "joyful", "synonym")).unwrap(); // 未收录
        let list = list_for_word(&conn, "w1").unwrap();
        assert_eq!(list.len(), 2);
        let glad = list.iter().find(|v| v.relation.related_word == "glad").unwrap();
        assert!(glad.in_vocab);
        assert_eq!(glad.vocab_status.as_deref(), Some("mastered"));
        assert_eq!(glad.vocab_word_id.as_deref(), Some("w2"));
        let joyful = list.iter().find(|v| v.relation.related_word == "joyful").unwrap();
        assert!(!joyful.in_vocab);
        assert!(joyful.vocab_word_id.is_none());
    }

    #[test]
    fn delete_by_id_and_pointing_to() {
        let conn = setup();
        insert_ignore(&conn, args("r1", "w1", "glad", "synonym")).unwrap();
        insert_ignore(&conn, args("r2", "w2", "glad", "synonym")).unwrap();
        // 反查 glad：两条关系命中
        let pointing = list_pointing_to(&conn, "GLAD").unwrap();
        assert_eq!(pointing.len(), 2);
        delete_by_id(&conn, "r1").unwrap();
        assert_eq!(list_pointing_to(&conn, "glad").unwrap().len(), 1);
    }

    #[test]
    fn cascade_delete_removes_relations() {
        let conn = setup();
        insert_ignore(&conn, args("r1", "w1", "glad", "synonym")).unwrap();
        conn.execute("DELETE FROM vocab_words WHERE id = 'w1'", []).unwrap();
        assert!(list_for_word(&conn, "w1").unwrap().is_empty());
    }

    #[test]
    fn count_by_word_groups_per_owner() {
        let conn = setup();
        insert_ignore(&conn, args("r1", "w1", "glad", "synonym")).unwrap();
        insert_ignore(&conn, args("r2", "w1", "joyful", "synonym")).unwrap();
        insert_ignore(&conn, args("r3", "w2", "happy", "synonym")).unwrap();
        let map: std::collections::HashMap<String, i64> =
            count_by_word(&conn).unwrap().into_iter().collect();
        assert_eq!(map.get("w1"), Some(&2));
        assert_eq!(map.get("w2"), Some(&1));
        // 无关系的词不出现
        assert!(!map.contains_key("w3"));
    }

    #[test]
    fn existing_word_texts_case_insensitive() {
        let conn = setup();
        let found = existing_word_texts(&conn, &["HAPPY".into(), "unknown".into()]).unwrap();
        assert_eq!(found, vec!["happy".to_string()]);
        assert!(existing_word_texts(&conn, &[]).unwrap().is_empty());
    }

    #[test]
    fn count_isolated_words_excludes_both_endpoints() {
        let conn = setup();
        conn.execute(
            "INSERT INTO vocab_words (id, word, status) VALUES ('w3', 'lonely', 'learning')",
            [],
        )
        .unwrap();
        // 初始无关系：happy / glad / lonely 全部孤立
        assert_eq!(count_isolated_words(&conn).unwrap(), 3);
        // w1 作为属主、w2 词文本被指向 → 均不再孤立；w3 仍孤立
        insert_ignore(&conn, args("r1", "w1", "glad", "synonym")).unwrap();
        assert_eq!(count_isolated_words(&conn).unwrap(), 1);
        // w3 建立关系后全库无孤立词
        insert_ignore(&conn, args("r2", "w3", "happy", "synonym")).unwrap();
        assert_eq!(count_isolated_words(&conn).unwrap(), 0);
    }
}
