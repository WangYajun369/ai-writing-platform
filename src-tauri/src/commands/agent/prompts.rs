//! Agent Prompt 组装（自 Python agent/skills/prompts.py 迁移）
//!
//! 核心 Prompt + 场景提示分离，按用户消息关键词按需组合，节省 Token。
//!
//! ⚠️ 提示词文本与场景提示表已迁至 [`crate::commands::agent::profiles`]（L1 注册表），
//! 本模块只保留组装逻辑——新增 Skill 或领域不必再改本文件。
//!
//! ## 四段拼接顺序（阶段四）
//!
//! ```text
//! 领域基准提示 → 能力基准提示 → 领域动态提示 → 能力动态提示
//! ```
//!
//! 领域定义「世界观」、能力定义「动作」，后者更具体故靠后；
//! 两类动态提示**各自独立命中**（同一关键词可同时命中两者），领域在前。

use crate::commands::agent::profiles::{AgentProfile, EffectiveProfile};

/// 单个画像最多注入的动态场景提示条数（控制 Token 与提示冲突）
const MAX_HINTS_PER_PROFILE: usize = 3;

/// 从单个画像的 hints 表收集命中的提示，按表序最多取 `MAX_HINTS_PER_PROFILE` 条
fn matched_hints(profile: &AgentProfile, user_message: &str) -> Vec<&'static str> {
    let mut matched: Vec<&'static str> = Vec::new();
    for (keyword, hint) in profile.hints {
        if user_message.contains(*keyword) {
            matched.push(hint);
        }
        if matched.len() >= MAX_HINTS_PER_PROFILE {
            break;
        }
    }
    matched
}

/// 组装最终 System Prompt（领域 / 能力双路动态提示）
///
/// 基准提示来自 [`EffectiveProfile::base_prompt`]（已由 `profiles::merge` 拼好领域 + 能力）；
/// 本函数只负责按用户消息注入两类动态提示。
pub fn compose_system_prompt(eff: &EffectiveProfile, user_message: &str) -> String {
    let mut out = eff.base_prompt.clone();
    // 领域提示在前
    for hint in matched_hints(eff.domain, user_message) {
        out.push_str(hint);
    }
    // 能力提示在后（比领域更具体，靠后对模型影响更大）
    //
    // ⚠️ 未知能力 id 虽已兜底为 writing（基准提示需要内容），但**不注入 writing 的 hints**
    // ——与改造前 `get_dynamic_prompt` 的语义一致。与预算同理（见 `AgentBudget::from_effective`），
    // 未知能力一律走「安全默认」而非套用 writing 的个性化配置。
    if eff.ability_matched {
        for hint in matched_hints(eff.ability, user_message) {
            out.push_str(hint);
        }
    }
    out
}

/// 估算文本 Token 数（中文约 1.5 字符/Token）
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
    use crate::commands::agent::profiles::{merge, NOVEL_PROMPT, THESIS_PROMPT, WRITING_PROMPT};

    /// 拼接顺序：领域基准 → 能力基准（能力更具体，靠后）
    #[test]
    fn base_prompt_is_domain_then_ability() {
        let eff = merge("writing", "thesis");
        let thesis_at = eff.base_prompt.find(THESIS_PROMPT).expect("缺领域基准");
        let writing_at = eff.base_prompt.find(WRITING_PROMPT).expect("缺能力基准");
        assert!(thesis_at < writing_at, "领域基准必须在能力基准之前");
    }

    /// 无关键词命中时返回纯基础 Prompt（领域 + 能力两段）
    #[test]
    fn dynamic_prompt_without_keywords_is_base_only() {
        let eff = merge("writing", "novel");
        let p = compose_system_prompt(&eff, "随便帮我写点什么吧");
        assert_eq!(p, eff.base_prompt);
        assert!(p.contains(NOVEL_PROMPT) && p.contains(WRITING_PROMPT));
    }

    /// 只命中能力关键词时，注入能力提示
    #[test]
    fn dynamic_prompt_injects_ability_hints() {
        let eff = merge("writing", "novel");
        let p = compose_system_prompt(&eff, "帮我设计一个大纲");
        assert!(p.contains("大纲生成指引"));
        assert!(!p.contains("情节设计指引"));
    }

    /// 只命中领域关键词时，注入领域提示
    #[test]
    fn dynamic_prompt_injects_domain_hints() {
        let eff = merge("polish", "note");
        let p = compose_system_prompt(&eff, "这个公式帮我看看");
        assert!(p.contains("笔记·公式指引"), "应注入学科笔记的公式指引");
        assert!(!p.contains("笔记·概念指引"));
    }

    /// 同一关键词命中两类时**都注入**，且领域提示排在能力提示之前
    #[test]
    fn overlapping_keywords_inject_both_with_domain_first() {
        // 「文风」同时命中 novel 领域与 analysis 能力
        let eff = merge("analysis", "novel");
        let p = compose_system_prompt(&eff, "帮我分析一下文风");
        let domain_at = p.find("小说·文风指引").expect("应注入领域文风指引");
        let ability_at = p.find("文风分析指引").expect("应注入能力文风指引");
        assert!(domain_at < ability_at, "领域提示必须在能力提示之前");
    }

    /// 每类场景提示注入上限均为 3 条（超出按表序截断）
    #[test]
    fn dynamic_prompt_caps_at_three_hints_per_profile() {
        let eff = merge("writing", "novel");
        let p = compose_system_prompt(&eff, "大纲 情节 对话 冲突 角色 全都要");
        assert!(p.contains("大纲生成指引"));
        assert!(p.contains("情节设计指引"));
        assert!(p.contains("角色对话指引"));
        assert!(!p.contains("冲突设计指引"), "能力侧第 4 条命中应被截断");
        assert!(!p.contains("角色塑造指引"), "能力侧第 5 条命中应被截断");
    }

    /// 未知能力 id 回退 writing，但**不注入 writing 的 hints**（与改造前语义一致）
    #[test]
    fn unknown_ability_gets_writing_base_without_hints() {
        let eff = merge("no_such", "novel");
        assert!(eff.base_prompt.contains(WRITING_PROMPT));
        let p = compose_system_prompt(&eff, "帮我设计大纲");
        assert!(!p.contains("大纲生成指引"), "未知能力不应注入 writing 的 hints");
    }

    /// 未知 / 空领域 id 回退 novel，不报错
    #[test]
    fn unknown_domain_falls_back_to_novel() {
        for bad in ["", "poetry", "NOVEL"] {
            let eff = merge("polish", bad);
            assert_eq!(eff.domain.id, "novel", "领域 `{bad}` 应回退 novel");
            assert!(eff.base_prompt.contains(NOVEL_PROMPT));
        }
    }

    /// 验收要求：系统提示总长度可控（领域 + 能力 + 双路 hints 全命中仍须低于上限）
    #[test]
    fn composed_prompt_stays_within_token_budget() {
        // 4 个领域 × 4 个能力，取各维度全命中时的最大长度
        let worst = [
            ("writing", "novel", "大纲 情节 对话 冲突 角色 人物 文风"),
            ("analysis", "thesis", "文风 连贯 伏笔 节奏 论点 论据 引用"),
            ("research", "breakdown", "设定 世界观 关系 校验 拆解 卡片 要点"),
            ("polish", "note", "语法 文笔 风格 对话 概念 公式 例题 复习"),
        ];
        for (ability, domain, msg) in worst {
            let eff = merge(ability, domain);
            let p = compose_system_prompt(&eff, msg);
            let tokens = estimate_prompt_tokens(&p);
            assert!(
                tokens < 2000,
                "`{ability}` × `{domain}` 提示词过长：{tokens} tokens"
            );
        }
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
