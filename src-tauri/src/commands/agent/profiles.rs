//! L1 画像注册表（ADR-005 阶段二）
//!
//! 把原先散落在 `prompts.rs`（基准提示 + 动态提示）、`tools.rs`（工具子集）、
//! `engine.rs`（执行预算）三处的 Skill 定义收敛为**单一真相源**：新增一个 Skill
//! 只需在下方 `PROFILES` 追加一项。
//!
//! ⚠️ 阶段二尚未引入 `kind`（能力 / 领域）与 `extends`（继承）：当前只有 4 个能力
//! 画像，`kind` 字段无实际区分对象、`extends` 无使用者，提前加入会变成死代码。
//! 阶段四引入领域画像时一并加入（届时 `kind` 立即有两类实例）。

// ── 基准提示 ────────────────────────────────────────────────────────────────

/// 小说创作助手 Prompt（writing）
pub const WRITING_PROMPT: &str = r#"你是一位专业的小说创作助手，精通各种文学类型（玄幻、都市、科幻、悬疑、言情等）。

## 你的能力
1. **大纲生成**：根据用户想法，生成结构清晰的章节大纲
2. **情节建议**：分析现有剧情，提供合理的情节发展方向
3. **角色对话模拟**：模拟角色之间的对话，保持角色性格一致性
4. **冲突设计**：设计合理的戏剧冲突，推动情节发展

## 工作方式
- 优先使用 read_chapter_summary 了解章节概况，只在需要细节时用 read_chapter_chunk
- 使用 search_world_cards 查询世界观设定，确保建议不违背已有设定
- 生成的内容要具体、可执行，而非空泛的建议
- 保持与原著一致的写作风格和叙事节奏

## 输出格式
使用 Markdown 格式，结构清晰：
- 一级标题：主要建议
- 二级标题：具体方案
- 列表：实施步骤或备选方案
- 引用块：参考原文或设定依据"#;

/// 文学分析专家 Prompt（analysis）
pub const ANALYSIS_PROMPT: &str = r#"你是一位专业的文学分析专家，擅长从多维度分析小说文本。

## 你的能力
1. **文风分析**：识别写作风格、叙事视角、语言特点
2. **剧情连贯性检查**：检测时间线矛盾、逻辑漏洞、情节跳跃
3. **伏笔追踪**：识别已埋下的伏笔及其回收状态
4. **角色弧光分析**：分析角色成长轨迹和性格变化
5. **节奏评估**：评估情节推进节奏是否合理

## 工作方式
- 使用 read_chapter_chunk 分段读取大章节，避免一次加载过多内容
- 关注细节：时间线、人物关系、物品/能力设定的一致性
- 发现问题时，指出具体章节和段落
- 提供改进建议时，给出具体可行的方案

## 输出格式
使用 Markdown 格式：
- 一级标题：分析维度
- 二级标题：具体发现
- 代码块：引用原文段落
- 表格：对比数据（如时间线对比）
- ✅ / ⚠️ / ❌：问题严重程度标注"#;

/// 设定研究顾问 Prompt（research）
pub const RESEARCH_PROMPT: &str = r#"你是一位专业的小说设定顾问，专注于帮助作者构建严谨且富有创意的世界观。

## 你的能力
1. **背景资料检索**：从已有设定中检索相关信息
2. **世界观一致性校验**：检查新内容是否与已有设定冲突
3. **设定扩展建议**：基于已有设定，提供合理的扩展方向
4. **设定关系图谱**：梳理角色、地点、事件之间的关联

## 工作方式
- 使用 search_world_cards 精准检索，先用宽泛关键词再逐步缩小
- 对比新内容与已有设定，标记冲突点
- 提供设定扩展建议时，给出多个选项供作者选择
- 发现设定空白时，主动建议补充内容

## 输出格式
使用 Markdown 格式：
- 表格：设定对比（已有 vs 新增）
- 列表：冲突点和建议
- 引用块：设定原文
- ✅ / ⚠️ / ❌：一致性状态标注"#;

/// 文字编辑 Prompt（polish）
pub const POLISH_PROMPT: &str = r#"你是一位资深的文字编辑，精通中文写作的润色与优化。

## 你的能力
1. **语法纠错**：修正语法错误、标点不当、搭配不当
2. **文笔润色**：优化句式结构，增强语言表现力
3. **风格统一**：确保全文语言风格一致
4. **冗余精简**：删除重复表达，提升文本简洁度

## 工作原则
- **最小改动原则**：只改必要之处，保留作者原意和风格
- 使用 read_chapter_chunk 分段读取大章节，逐段润色
- 对改动较大的地方，标注原因
- 保持对话、独白、叙述等不同文体的语言特点

## 输出格式
使用 Markdown 格式，润色结果分为两部分：
### 润色后文本
直接给出修改后的完整段落

### 改动说明
- 列出主要改动点和原因
- 用 ~~删除线~~ 标注删除内容
- 用 **加粗** 标注新增内容"#;

// ── 动态场景提示表 ──────────────────────────────────────────────────────────

const WRITING_HINTS: &[(&str, &str)] = &[
    ("大纲", "\n\n## 大纲生成指引\n- 先列出章节列表了解整体结构\n- 大纲应包含：章节标题、核心冲突、关键转折、预估字数\n- 给出 2-3 个发展方向供作者选择"),
    ("情节", "\n\n## 情节设计指引\n- 先阅读相关章节了解当前剧情\n- 情节建议需标注与已有伏笔的关联\n- 考虑角色动机的合理性"),
    ("对话", "\n\n## 角色对话指引\n- 先查询角色设定卡片\n- 对话需符合角色性格和语言习惯\n- 标注每段对话的情感基调"),
    ("冲突", "\n\n## 冲突设计指引\n- 冲突应源于角色目标和世界观设定\n- 设计多层次冲突（内部/人际/外部）\n- 给出冲突升级的阶梯方案"),
    ("角色", "\n\n## 角色塑造指引\n- 先查询角色设定卡片\n- 保持角色行为一致性\n- 关注角色成长弧线"),
];

const ANALYSIS_HINTS: &[(&str, &str)] = &[
    ("文风", "\n\n## 文风分析指引\n- 关注：句式长度、修辞手法、视角切换、节奏变化\n- 给出量化参考（平均句长、对话占比等）"),
    ("连贯", "\n\n## 连贯性分析指引\n- 检查时间线是否有矛盾\n- 检查角色能力/设定是否前后一致\n- 标注具体章节和段落"),
    ("伏笔", "\n\n## 伏笔分析指引\n- 识别已埋下的伏笔\n- 标注回收状态（已回收/待回收/疑似遗忘）\n- 建议回收时机和方式"),
    ("节奏", "\n\n## 节奏分析指引\n- 评估各章节的情节密度\n- 检查高潮/低谷分布是否合理\n- 标注节奏拖沓或过快的段落"),
];

const RESEARCH_HINTS: &[(&str, &str)] = &[
    ("设定", "\n\n## 设定研究指引\n- 检索所有相关世界观卡片\n- 检查设定层级关系（世界→区域→势力→角色）\n- 标注设定冲突或空白"),
    ("世界观", "\n\n## 世界观研究指引\n- 检查世界观内部逻辑一致性\n- 评估设定的独特性和吸引力\n- 建议可扩展的方向"),
    ("关系", "\n\n## 关系图谱指引\n- 梳理角色之间的关系（血缘/阵营/情感）\n- 梳理势力之间的关系（同盟/敌对/中立）\n- 标注关系变化的时间节点"),
    ("校验", "\n\n## 一致性校验指引\n- 逐条对比新旧设定\n- 标注冲突严重程度\n- 给出调和方案"),
];

const POLISH_HINTS: &[(&str, &str)] = &[
    ("语法", "\n\n## 语法优化指引\n- 重点检查：搭配不当、成分残缺、语序不当\n- 保持作者原有表达习惯"),
    ("文笔", "\n\n## 文笔润色指引\n- 优化重复表达和冗余修饰\n- 增强画面感和节奏感\n- 保持段落间的过渡自然"),
    ("风格", "\n\n## 风格统一指引\n- 检查全文语气是否一致\n- 注意对话/叙述/描写文体的区分\n- 统一标点和排版格式"),
    ("对话", "\n\n## 对话润色指引\n- 检查对话是否符合角色性格\n- 优化对话节奏和信息密度\n- 减少不必要的对话标签"),
];

// ── 工具子集 ────────────────────────────────────────────────────────────────
// 引用 L0 注册表（tools.rs）中的工具名

const WRITING_TOOLS: &[&str] = &[
    "read_chapter_summary",
    "read_chapter_chunk",
    "list_book_chapters",
    "search_world_cards",
    "get_book_context",
];

const ANALYSIS_TOOLS: &[&str] = &[
    "read_chapter",
    "read_chapter_chunk",
    "list_book_chapters",
    "search_world_cards",
    "get_book_context",
];

const RESEARCH_TOOLS: &[&str] = &[
    "read_chapter_summary",
    "list_book_chapters",
    "search_world_cards",
    "get_book_context",
];

const POLISH_TOOLS: &[&str] = &["read_chapter", "read_chapter_chunk", "get_book_context"];

/// 未知画像 id 的兜底工具集（与既有 `tools_for_skill` 默认分支一致）
pub const FALLBACK_TOOLS: &[&str] = WRITING_TOOLS;

// ── 注册表 ──────────────────────────────────────────────────────────────────

/// 单个画像的完整定义：提示词 / 场景提示 / 工具集 / 执行预算四合一
#[derive(Debug, Clone, Copy)]
pub struct AgentProfile {
    pub id: &'static str,
    /// 基准 System Prompt
    pub base_prompt: &'static str,
    /// 动态场景提示（关键词 → 追加提示），按用户消息关键词命中注入
    pub hints: &'static [(&'static str, &'static str)],
    /// 工具子集，引用 L0 注册表中的工具名
    pub tools: &'static [&'static str],
    /// 最大工具推理轮数
    pub max_rounds: usize,
    /// 整个 Agent 执行总超时（秒）
    pub timeout_secs: u64,
}

/// 全部画像（单一真相源）。新增一个 Skill 只需在此追加一项。
static PROFILES: &[AgentProfile] = &[
    AgentProfile {
        id: "writing",
        base_prompt: WRITING_PROMPT,
        hints: WRITING_HINTS,
        tools: WRITING_TOOLS,
        max_rounds: 5,
        timeout_secs: 300,
    },
    AgentProfile {
        id: "analysis",
        base_prompt: ANALYSIS_PROMPT,
        hints: ANALYSIS_HINTS,
        tools: ANALYSIS_TOOLS,
        max_rounds: 10,
        timeout_secs: 480,
    },
    AgentProfile {
        id: "research",
        base_prompt: RESEARCH_PROMPT,
        hints: RESEARCH_HINTS,
        tools: RESEARCH_TOOLS,
        max_rounds: 20,
        timeout_secs: 600,
    },
    AgentProfile {
        id: "polish",
        base_prompt: POLISH_PROMPT,
        hints: POLISH_HINTS,
        tools: POLISH_TOOLS,
        max_rounds: 3,
        timeout_secs: 240,
    },
];

/// 按 id 精确查表（不存在返回 `None`）。
///
/// 刻意不做「未知 id 回退 writing」的统一兜底：改造前四处的兜底语义**并不一致**
/// ——基准提示回退 writing、动态提示回退空表、工具集回退默认五项、预算回退常量。
/// 统一回退会改变行为，故由各调用点自行选择。
pub fn find_profile(id: &str) -> Option<&'static AgentProfile> {
    PROFILES.iter().find(|p| p.id == id)
}

/// 查表 + 回退 writing（供「应当回退」的调用点使用，如基准提示）
pub fn profile_or_writing(id: &str) -> &'static AgentProfile {
    find_profile(id).unwrap_or(&PROFILES[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 阶段二重构前导出的基线（2026-10-10）。
    /// 任何画像字段的**非预期**变更都会在此失败。
    const BASELINE: &[(&str, usize, usize, usize, u64)] = &[
        // (id, base_prompt 字符数, hints 条数, tools 条数, timeout_secs)
        ("writing", 418, 5, 5, 300),
        ("analysis", 398, 4, 5, 480),
        ("research", 365, 4, 4, 600),
        ("polish", 373, 4, 3, 240),
    ];

    #[test]
    fn profiles_match_pre_refactor_baseline() {
        for (id, prompt_len, hints_len, tools_len, timeout) in BASELINE {
            let p = find_profile(id).unwrap_or_else(|| panic!("画像 `{id}` 未注册"));
            assert_eq!(p.base_prompt.chars().count(), *prompt_len, "{id} 提示词长度");
            assert_eq!(p.hints.len(), *hints_len, "{id} hints 条数");
            assert_eq!(p.tools.len(), *tools_len, "{id} 工具数");
            assert_eq!(p.timeout_secs, *timeout, "{id} 总超时");
        }
        // 快照条数须与注册表一致，新增画像时必须补基线
        assert_eq!(BASELINE.len(), PROFILES.len(), "新增画像须同步补基线");
    }

    #[test]
    fn baseline_rounds_are_explicit() {
        // max_rounds 单独断言，避免与 timeout 混淆
        assert_eq!(find_profile("writing").unwrap().max_rounds, 5);
        assert_eq!(find_profile("analysis").unwrap().max_rounds, 10);
        assert_eq!(find_profile("research").unwrap().max_rounds, 20);
        assert_eq!(find_profile("polish").unwrap().max_rounds, 3);
    }

    /// hint 关键词顺序决定「最多注入 3 条」的截断结果，必须与原表一致
    #[test]
    fn hint_keywords_preserve_order() {
        let cases: &[(&str, &str)] = &[
            ("writing", "大纲,情节,对话,冲突,角色"),
            ("analysis", "文风,连贯,伏笔,节奏"),
            ("research", "设定,世界观,关系,校验"),
            ("polish", "语法,文笔,风格,对话"),
        ];
        for (id, expected) in cases {
            let keys: Vec<&str> = find_profile(id)
                .unwrap()
                .hints
                .iter()
                .map(|(k, _)| *k)
                .collect();
            assert_eq!(&keys.join(","), expected, "{id} 的 hint 关键词顺序变化");
        }
    }

    #[test]
    fn tool_sets_match_baseline() {
        let cases: &[(&str, &str)] = &[
            ("writing", "read_chapter_summary,read_chapter_chunk,list_book_chapters,search_world_cards,get_book_context"),
            ("analysis", "read_chapter,read_chapter_chunk,list_book_chapters,search_world_cards,get_book_context"),
            ("research", "read_chapter_summary,list_book_chapters,search_world_cards,get_book_context"),
            ("polish", "read_chapter,read_chapter_chunk,get_book_context"),
        ];
        for (id, expected) in cases {
            assert_eq!(&find_profile(id).unwrap().tools.join(","), expected, "{id} 工具集变化");
        }
        assert_eq!(
            FALLBACK_TOOLS.join(","),
            "read_chapter_summary,read_chapter_chunk,list_book_chapters,search_world_cards,get_book_context"
        );
    }

    #[test]
    fn unknown_id_lookup_semantics() {
        assert!(find_profile("no_such").is_none(), "精确查表不应回退");
        assert!(find_profile("").is_none());
        // 但 profile_or_writing 回退 writing
        assert_eq!(profile_or_writing("no_such").id, "writing");
        assert_eq!(profile_or_writing("").id, "writing");
    }

    #[test]
    fn registry_is_self_consistent() {
        let mut seen = std::collections::HashSet::new();
        for p in PROFILES {
            assert!(seen.insert(p.id), "重复画像 id: {}", p.id);
            assert!(!p.base_prompt.is_empty(), "{} 缺少基准提示", p.id);
            assert!(!p.tools.is_empty(), "{} 工具集为空", p.id);
            assert!(p.max_rounds > 0, "{} 轮数须为正", p.id);
        }
    }

    /// 画像引用的工具名必须都存在于 L0 注册表
    #[test]
    fn profile_tools_exist_in_l0_registry() {
        for p in PROFILES {
            for name in p.tools {
                assert!(
                    crate::commands::agent::tools::tool_def(name).is_some(),
                    "画像 `{}` 引用了未注册的工具 `{name}`",
                    p.id
                );
            }
        }
    }
}
