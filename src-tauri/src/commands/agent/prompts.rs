//! Agent Prompt 组装（自 Python agent/skills/prompts.py 迁移）
//!
//! 核心 Prompt + 场景提示分离，按用户消息关键词按需组合，节省 Token。
//!
//! ⚠️ 提示词文本与场景提示表已迁至 [`crate::commands::agent::profiles`]（L1 注册表），
//! 本模块只保留组装逻辑——新增 Skill 不必再改本文件。

use crate::commands::agent::profiles::{find_profile, profile_or_writing};

/// Skill → 核心 Prompt 映射（未知 skill 回退到 writing）
pub fn skill_base_prompt(skill: &str) -> &'static str {
    profile_or_writing(skill).base_prompt
}

/// 各 Skill 的动态场景提示表（未知 skill 回退空表——与改造前语义一致）
fn dynamic_hints(skill: &str) -> &'static [(&'static str, &'static str)] {
    find_profile(skill).map(|p| p.hints).unwrap_or(&[])
}

/// 根据用户消息动态生成增强 System Prompt（最多注入 3 个场景提示）
pub fn get_dynamic_prompt(skill: &str, user_message: &str) -> String {
    let base = skill_base_prompt(skill).to_string();
    let hints = dynamic_hints(skill);
    let mut matched: Vec<&str> = Vec::new();
    for (keyword, hint) in hints {
        if user_message.contains(*keyword) {
            matched.push(hint);
        }
        if matched.len() >= 3 {
            break;
        }
    }
    if matched.is_empty() {
        base
    } else {
        base + &matched.join("")
    }
}

/// 估算文本 Token 数（中文约 1.5 字符/Token）
#[allow(dead_code)]
pub fn estimate_prompt_tokens(prompt: &str) -> usize {
    let chinese_chars = prompt
        .chars()
        .filter(|c| matches!(c, '\u{4e00}'..='\u{9fff}'))
        .count();
    let other_chars = prompt.chars().count() - chinese_chars;
    (chinese_chars as f64 / 1.5 + other_chars as f64 / 3.5) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent::profiles::{ANALYSIS_PROMPT, POLISH_PROMPT, RESEARCH_PROMPT, WRITING_PROMPT};

    /// 4 个 Skill 各有独立 Prompt；未知 skill 回退 writing
    #[test]
    fn base_prompt_maps_skills_and_fallback() {
        assert_eq!(skill_base_prompt("writing"), WRITING_PROMPT);
        assert_eq!(skill_base_prompt("analysis"), ANALYSIS_PROMPT);
        assert_eq!(skill_base_prompt("research"), RESEARCH_PROMPT);
        assert_eq!(skill_base_prompt("polish"), POLISH_PROMPT);
        assert_eq!(skill_base_prompt("no_such"), WRITING_PROMPT);
        assert_eq!(skill_base_prompt(""), WRITING_PROMPT);
        // 四个 Skill 的 Prompt 互不相同
        assert_ne!(skill_base_prompt("analysis"), skill_base_prompt("writing"));
        assert_ne!(skill_base_prompt("research"), skill_base_prompt("polish"));
    }

    /// 无关键词命中时返回纯基础 Prompt
    #[test]
    fn dynamic_prompt_without_keywords_is_base_only() {
        let p = get_dynamic_prompt("writing", "随便帮我写点什么吧");
        assert_eq!(p, WRITING_PROMPT);
    }

    /// 命中关键词注入对应场景提示；同名词条按 Skill 隔离（polish 的「对话」≠ writing 的「对话」）
    #[test]
    fn dynamic_prompt_injects_matched_hints_per_skill() {
        let p = get_dynamic_prompt("writing", "帮我设计一个大纲");
        assert!(p.starts_with(WRITING_PROMPT));
        assert!(p.contains("大纲生成指引"));
        assert!(!p.contains("情节设计指引"));

        // polish 命中「对话」应注入对话润色，而非 writing 的角色对话指引
        let p2 = get_dynamic_prompt("polish", "这段对话帮我润色");
        assert!(p2.contains("对话润色指引"));
        assert!(!p2.contains("角色对话指引"));
    }

    /// 场景提示注入上限为 3 条（超出按表序截断）
    #[test]
    fn dynamic_prompt_caps_at_three_hints() {
        let p = get_dynamic_prompt("writing", "大纲 情节 对话 冲突 角色 全都要");
        assert!(p.contains("大纲生成指引"));
        assert!(p.contains("情节设计指引"));
        assert!(p.contains("角色对话指引"));
        assert!(!p.contains("冲突设计指引"), "第 4 条命中应被截断");
        assert!(!p.contains("角色塑造指引"), "第 5 条命中应被截断");
    }

    /// 未知 Skill：基准提示回退 writing，但**不注入任何场景提示**（改造前即如此）
    #[test]
    fn unknown_skill_gets_base_prompt_without_hints() {
        let p = get_dynamic_prompt("no_such", "帮我设计大纲");
        assert_eq!(p, WRITING_PROMPT, "未知 skill 不应注入 writing 的 hints");
    }

    /// Token 估算：中文 1.5 字/Token，其他字符 3.5 字/Token
    #[test]
    fn token_estimation_respects_char_classes() {
        let cjk: String = "你".repeat(150);
        assert_eq!(estimate_prompt_tokens(&cjk), 100);
        let ascii: String = "a".repeat(35);
        assert_eq!(estimate_prompt_tokens(&ascii), 10);
        assert_eq!(estimate_prompt_tokens(""), 0);
    }
}
