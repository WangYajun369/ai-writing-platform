//! 插件画像的发现与执行期合并（ADR-006 任务 10）
//!
//! 插件通过 `manifest.json` 的 `profiles[]` 贡献 Agent 画像。本模块负责两件事：
//!
//! 1. **下发**：把已启用插件的画像转成 [`ProfileMeta`]，并入 L3
//!    `list_agent_profiles` 的返回值——否则插件装了前端也看不见。
//! 2. **执行**：把插件画像合并成 [`EffectiveProfile`]，交给引擎跑。
//!
//! ## 为什么必须改执行侧
//!
//! `engine` 原本只调 `profiles::merge(skill, domain)`，而该函数对未知能力 id
//! **兜底为 writing**。插件画像 id 不在内置注册表里，光加进列表而不改执行侧，
//! 用户选中插件画像后跑起来的依然是 writing。
//!
//! ## 为什么不需要改 `EffectiveProfile` 的结构
//!
//! | 字段 | 插件画像如何满足 |
//! |------|----------------|
//! | `base_prompt` | 已经是 owned `String` |
//! | `tools` | 工具名虽然在 `Vec<String>` 里，但**值必然在 L0 注册表内**（加载时校验过），可映射回 `&'static str` |
//! | `max_rounds` / `timeout_secs` | 数值，直接填 |
//! | `ability` | 用 writing 占位——插件画像等价于「自定义了基准提示与预算的未知能力」 |
//!
//! 于是 `ability_matched: false` 连带两个正确后果：
//! `prompts` 不会注入 writing 的动态提示（插件未声明 hints），
//! 预算也不会套用 writing 的 `(5, 300)`。

use tauri::AppHandle;

use crate::commands::agent::profiles::{
    self, EffectiveProfile, OwnedStep, ProfileKind, ProfileMeta, RuntimeMode,
};
use crate::commands::agent::tools;
use crate::error::{AppError, ErrCode};
use crate::plugin::loader::enabled_plugins;
use crate::plugin::model::{
    grant_for_tool, Grant, PluginProfile, MAX_PLUGIN_ROUNDS, PLUGIN_TIMEOUT_SECS,
};

/// 按画像 id 查找**已启用**插件贡献的画像
///
/// 一并返回该插件声明的 `grants`——执行侧要用它校验插件动态生成的编排计划。
///
/// 插件顺序由 `list_plugins` 的 id 排序保证稳定，故同名画像恒由同一插件胜出。
pub fn find(app: &AppHandle, profile_id: &str) -> Option<(PluginProfile, Vec<Grant>)> {
    enabled_plugins(app)
        .into_iter()
        .flat_map(|p| {
            let grants = p.manifest.grants;
            p.manifest
                .profiles
                .into_iter()
                .map(move |prof| (prof, grants.clone()))
        })
        .find(|(p, _)| p.id == profile_id)
}

/// 校验插件生成的编排计划：每个工具都必须被该插件的 `grants` 覆盖
///
/// **前端已经校验过一遍，但那一遍只是 UX**——IPC 边界不可信，
/// 插件完全可以直接构造 `execute_agent_skill` 请求塞进越权工具。
/// 真正的边界在这里，故 Rust 侧必须独立再校验一次。
pub fn plan_is_allowed(plan: &[OwnedStep], grants: &[Grant]) -> Result<(), AppError> {
    for step in plan {
        for t in &step.tools {
            match grant_for_tool(t) {
                Some(g) if grants.contains(&g) => {}
                Some(g) => {
                    return Err(AppError::business(
                        ErrCode::PluginManifest,
                        format!(
                            "编排步骤「{}」引用了工具 `{}`，需要权限 `{}`，但插件未声明该 grant",
                            step.name,
                            t,
                            g.as_str()
                        ),
                    ));
                }
                None => {
                    return Err(AppError::business(
                        ErrCode::PluginManifest,
                        format!("编排步骤「{}」引用了未知工具 `{}`", step.name, t),
                    ));
                }
            }
        }
    }
    Ok(())
}

/// 已启用插件贡献的全部画像元数据（供 L3 下发）
///
/// 跨插件的同名画像**先出现者胜**（按插件 id 排序），被覆盖的那个记一条告警——
/// 安装时无法预知将来会装哪些插件，故去重放在读取侧而非安装侧。
pub fn plugin_profile_metas(app: &AppHandle) -> Vec<ProfileMeta> {
    let mut out: Vec<ProfileMeta> = Vec::new();
    for p in enabled_plugins(app)
        .into_iter()
        .flat_map(|p| p.manifest.profiles)
    {
        if out.iter().any(|m| m.id == p.id) {
            crate::app_log_warn!(
                "[Plugin] 画像 id `{}` 被多个插件声明，已忽略后者",
                p.id
            );
            continue;
        }
        out.push(ProfileMeta {
            id: p.id,
            kind: ProfileKind::Ability,
            label: p.label,
            description: p.description,
            icon: p.icon,
            color: p.color,
            quick_actions: p.quick_actions,
        });
    }
    out
}

/// 插件画像 × 领域画像 → 有效画像
///
/// 合并规则与 [`profiles::merge`] 对齐（领域提示在前、工具取并集、
/// 执行模式领域优先），仅「能力侧」换成插件声明的运行时数据。
pub fn to_effective(p: &PluginProfile, domain_id: &str) -> EffectiveProfile {
    let domain = profiles::domain_or_novel(domain_id);

    // 插件工具名 → L0 注册表的 'static 引用。
    // 加载时已校验过全部存在，filter_map 不会静默丢项；保留它是为了防御
    // 「校验与执行之间注册表被改动」的极端情况。
    let mut tools: Vec<&'static str> = p
        .tools
        .iter()
        .filter_map(|t| tools::tool_def(t).map(|d| d.name))
        .collect();
    for t in domain.tools {
        if !tools.contains(t) {
            tools.push(t);
        }
    }

    // 执行模式领域优先（与 merge 一致）：插件不直接声明 Pipeline，
    // 但领域（如 breakdown）可以，此时流程形状仍由领域决定。
    // 插件自己的编排计划由 `engine` 在拿到 plan 后覆盖为 DynamicPipeline。
    let runtime = match &domain.runtime {
        RuntimeMode::ReAct => RuntimeMode::ReAct,
        RuntimeMode::Pipeline(steps) => RuntimeMode::Pipeline(steps),
        RuntimeMode::DynamicPipeline(steps) => RuntimeMode::DynamicPipeline(steps.clone()),
    };

    EffectiveProfile {
        // writing 仅作类型契约的占位：base_prompt / tools / budget 全部来自插件。
        // ability_matched=false 确保不会额外注入 writing 的 hints（见模块文档）。
        ability: profiles::ability_or_writing(""),
        ability_matched: false,
        domain,
        base_prompt: format!("{}\n\n{}", domain.base_prompt, p.base_prompt),
        tools,
        // 插件声明的轮数须夹断：第三方不该能把单次会话拖到无上限
        max_rounds: p.max_rounds.min(MAX_PLUGIN_ROUNDS).max(domain.max_rounds),
        timeout_secs: PLUGIN_TIMEOUT_SECS.max(domain.timeout_secs),
        runtime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, tools: Vec<String>, rounds: usize) -> PluginProfile {
        PluginProfile {
            id: id.to_string(),
            label: "L".to_string(),
            description: "D".to_string(),
            icon: "pen-tool".to_string(),
            color: "#fff".to_string(),
            quick_actions: vec!["a".to_string()],
            base_prompt: "PLUGIN PROMPT".to_string(),
            tools,
            max_rounds: rounds,
        }
    }

    #[test]
    fn plugin_prompt_is_appended_after_domain() {
        let p = profile("p1", vec![], 8);
        let eff = to_effective(&p, "novel");
        let domain_prompt = profiles::domain_or_novel("novel").base_prompt;
        assert!(
            eff.base_prompt.starts_with(domain_prompt),
            "领域基准提示应在前"
        );
        assert!(eff.base_prompt.ends_with("PLUGIN PROMPT"), "插件提示应靠后");
    }

    #[test]
    fn plugin_tools_map_back_to_registry() {
        let p = profile(
            "p1",
            vec!["read_chapter".to_string(), "search_world_cards".to_string()],
            8,
        );
        let eff = to_effective(&p, "novel");
        assert!(eff.tools.contains(&"read_chapter"));
        assert!(eff.tools.contains(&"search_world_cards"));
        // 领域工具仍并入
        for t in profiles::domain_or_novel("novel").tools {
            assert!(eff.tools.contains(t), "领域工具 {t} 应并入");
        }
    }

    #[test]
    fn plugin_rounds_are_clamped() {
        // 声明 9999 轮应被 MAX_PLUGIN_ROUNDS 夹断
        let eff = to_effective(&profile("p1", vec![], 9999), "novel");
        assert!(eff.max_rounds <= MAX_PLUGIN_ROUNDS);
    }

    #[test]
    fn plugin_ability_is_not_marked_matched() {
        // 这是「不注入 writing hints」的开关，也是 budget 不套 writing 的依据
        let eff = to_effective(&profile("p1", vec![], 8), "novel");
        assert!(!eff.ability_matched);
    }

    #[test]
    fn plugin_domain_can_override_runtime() {
        // breakdown 领域自带 Pipeline；插件画像跑在拆书作品上时应沿用流水线
        let eff = to_effective(&profile("p1", vec![], 8), "breakdown");
        assert!(matches!(eff.runtime, RuntimeMode::Pipeline(_)));
        // 小说领域则是 ReAct
        let eff2 = to_effective(&profile("p1", vec![], 8), "novel");
        assert!(matches!(eff2.runtime, RuntimeMode::ReAct));
    }
}
