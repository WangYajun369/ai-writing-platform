//! L1 画像注册表（ADR-005 阶段二）
//!
//! 把原先散落在 `prompts.rs`（基准提示 + 动态提示）、`tools.rs`（工具子集）、
//! `engine.rs`（执行预算）三处的 Skill 定义收敛为**单一真相源**：新增一个 Skill
//! 只需在下方 `PROFILES` 追加一项。
//!
//! ## 两类画像（阶段四）
//!
//! | 类别 | 回答什么 | 实例 | 来源 |
//! |------|---------|------|------|
//! | `Ability` 能力 | 「做什么动作」 | writing / analysis / research / polish | 用户在 AI 面板选择 |
//! | `Domain` 领域 | 「处理什么作品」 | novel / thesis / breakdown / note | 作品的 `book_type` |
//!
//! 两者正交，运行时由 [`merge`] 合并为 [`EffectiveProfile`]。
//!
//! ⚠️ `extends`（画像继承）**刻意未实现**：四个领域画像彼此平级，没有继承需求；
//! 加入此字段会无人读取而成为死代码，破坏「`cargo check` 零警告」。
//! 将来真出现「某领域继承自另一领域」时再补。

// ── 能力画像：基准提示 ──────────────────────────────────────────────────────

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

// ── 领域画像：基准提示 ──────────────────────────────────────────────────────
//
// 领域画像只定义「世界观」（这是什么样的作品、关注什么），
// **不定义动作**（做什么）——后者由能力画像负责。故下方提示词一律不提工具用法。

/// 小说领域（novel）
pub const NOVEL_PROMPT: &str = r#"## 当前作品类型：小说

### 本领域关注点
1. **情节**：因果链是否闭合、转折是否有铺垫、悬念的埋设与回收
2. **人物**：性格一致性、动机合理性、成长弧线
3. **文风**：叙事视角、语言基调、描写密度

### 本领域约定
- 章节是叙事单位，按时间线或视角推进
- 「设定」指世界观与角色设定卡片
- 讨论情节时优先看因果链是否成立，而非文句优劣"#;

/// 论文领域（thesis）
pub const THESIS_PROMPT: &str = r#"## 当前作品类型：论文

### 本领域关注点
1. **论点**：中心论题是否明确、可证伪、边界清晰
2. **论据**：数据来源、实验设计、推理链条是否完整
3. **引用**：文献标注规范，避免抄袭与过度转述

### 本领域约定
- 章节是论证单位（引言 / 方法 / 结果 / 讨论），按逻辑推进
- 严格区分「作者观点」与「文献观点」，引用处须标明来源
- 避免文学化修辞与主观情绪表达，保持客观陈述"#;

/// 拆书领域（breakdown）
pub const BREAKDOWN_PROMPT: &str = r#"## 当前作品类型：拆书

### 本领域关注点
1. **拆解**：按章节或主题切分，保留原书结构
2. **卡片**：每条要点独立成卡，可脱离原文理解
3. **要点**：提炼核心主张与论据，剔除铺陈与例子

### 本领域约定
- **忠实于原著**：不加入拆解者自己的评价与延伸
- 每条卡片应能独立成立（自带必要的背景说明）
- 优先保留作者的核心论证链，其次才是金句与案例"#;

/// 学科笔记领域（note）
pub const NOTE_PROMPT: &str = r#"## 当前作品类型：学科笔记

### 本领域关注点
1. **概念**：术语定义与概念间关系
2. **公式**：定理、公式及其适用条件
3. **例题**：典型题目与解题步骤
4. **复习**：易错点与自测线索

### 本领域约定
- 笔记条目按学科章节组织，**不是日记或流水账**
- 公式必须标注适用条件与符号含义
- 给一段杂乱的课堂内容时，输出应为「概念定义 + 公式 + 例题」的结构，而非叙事性文字"#;

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

// ── 领域画像：动态场景提示表 ────────────────────────────────────────────────
//
// 与能力 hints **各自独立命中**（同一关键词可同时命中两类，领域提示排在前），
// 因为两者的关键词域虽部分重叠，但关注角度不同：领域谈「这类作品要什么」，
// 能力谈「这个动作怎么做」。

const NOVEL_HINTS: &[(&str, &str)] = &[
    ("情节", "\n\n## 小说·情节指引\n- 检查因果链是否闭合，转折是否有铺垫\n- 标注悬念的埋设与回收位置"),
    ("人物", "\n\n## 小说·人物指引\n- 检查行为是否符合已建立的性格\n- 关注人物关系网的变化"),
    ("文风", "\n\n## 小说·文风指引\n- 保持叙事视角一致（第一/第三人称不混用）\n- 描写密度与情节节奏匹配"),
];

const THESIS_HINTS: &[(&str, &str)] = &[
    ("论点", "\n\n## 论文·论点指引\n- 中心论题应可证伪、边界清晰\n- 检查各章是否都服务于中心论题"),
    ("论据", "\n\n## 论文·论据指引\n- 标注数据来源与采集方法\n- 检查推理链是否存在跳跃"),
    ("引用", "\n\n## 论文·引用指引\n- 引用格式须全文统一（GB/T 7714 或 APA 等）\n- 区分直接引用与间接转述"),
];

const BREAKDOWN_HINTS: &[(&str, &str)] = &[
    ("拆解", "\n\n## 拆书·拆解指引\n- 先列出章节结构再逐章提炼\n- 保留原书的论证顺序，不重排"),
    ("卡片", "\n\n## 拆书·卡片指引\n- 每条卡片自带背景，可脱离原文阅读\n- 卡片标题用原书主张，不用评价性措辞"),
    ("要点", "\n\n## 拆书·要点指引\n- 剔除铺陈、重复与过渡段落\n- 保留作者的核心论证链"),
];

const NOTE_HINTS: &[(&str, &str)] = &[
    ("概念", "\n\n## 笔记·概念指引\n- 给出术语的精确定义与相邻概念区分\n- 标注概念间的依赖与层级关系"),
    ("公式", "\n\n## 笔记·公式指引\n- 公式须标注适用条件与符号含义\n- 补充一个最小可算的代入示例"),
    ("例题", "\n\n## 笔记·例题指引\n- 按「已知 → 思路 → 步骤 → 结论」组织\n- 标注易错步骤与常见误区"),
    ("复习", "\n\n## 笔记·复习指引\n- 提炼易错点与自测线索\n- 给出可自检的判断性问题"),
];

// ── 快捷操作文案（阶段五：由后端下发，前端不再硬编码）────────────────────────
// 原表位于 src/components/ai/panel/constants.ts，随 L3 自动发现一并迁入注册表。

const WRITING_QUICK_ACTIONS: &[&str] = &[
    "为当前章节生成下一章的详细大纲",
    "分析主角的性格，设计一个合理的冲突情节",
    "基于已有世界观，提供3个情节发展方向",
];

const ANALYSIS_QUICK_ACTIONS: &[&str] = &[
    "分析最近5章的叙事节奏",
    "检查当前章节与前面章节的伏笔关联",
    "评估主要角色的性格一致性",
];

const RESEARCH_QUICK_ACTIONS: &[&str] = &[
    "检索当前书籍的所有世界观设定",
    "检查新章节内容是否与已有设定冲突",
    "根据已有设定，扩展魔法体系的细节",
];

const POLISH_QUICK_ACTIONS: &[&str] = &[
    "润色当前章节，保持原文风格",
    "检查并修正语法和标点错误",
    "优化当前章节的句式结构，增强可读性",
];

/// 领域画像不单独承担动作，故无快捷操作
const DOMAIN_QUICK_ACTIONS: &[&str] = &[];

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

/// 创作类领域（小说 / 论文）的专属工具：恒为空。
///
/// 领域只定义世界观、**不定义动作**——动作一律由能力画像给出，故此处不引入工具，
/// 合并时能力工具原样透出。
const DOMAIN_TOOLS: &[&str] = &[];

/// 提炼类领域（拆书 / 学科笔记）的专属工具
///
/// 三者是「读章节 → 提炼要点 → 生成卡片」流水线所需的全部工具：`list_book_chapters`
/// 负责定位目标章节，`split_chapter` 负责看清结构，`create_note_card` 负责把提炼
/// 结果落库。领域只声明「需要这几件工具」，何时调用由执行模式决定；合并时与能力
/// 工具取并集。
///
/// ⚠️ 流水线步骤（[`BREAKDOWN_STEPS`]）声明的工具必须都在此表内——「步骤工具 ⊆
/// 有效工具集」是流水线可达性的前提，由 `pipeline_steps_are_reachable` 单测守住。
const EXTRACTION_TOOLS: &[&str] =
    &["list_book_chapters", "split_chapter", "create_note_card"];

// ── L2 执行模式（阶段六）────────────────────────────────────────────────────
// 与 L1 画像同源：本文件声明「这个画像怎么跑」，engine / pipeline 只负责执行。

/// 流水线中的一个步骤：一个**收窄了工具与轮数**的 ReAct
///
/// 步骤的**顺序由画像固定**，模型只能在步内自由行动，不能跳步或改序——这正是
/// 「固定流程类 Agent」与自由 ReAct 的本质区别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    /// 步骤名（日志与进度展示）
    pub name: &'static str,
    /// 本步指令：拼进该步的 system prompt，取代「一次把整个任务说完」
    pub instruction: &'static str,
    /// 本步可见的工具（须是有效画像工具集的子集，否则工具不可达）
    pub tools: &'static [&'static str],
    /// 本步最多推理轮数
    pub max_rounds: usize,
}

/// 运行时构造的流水线步骤
///
/// [`Step`] 是编译期常量用的静态版本（`&'static str`），本结构是其 owned 形态，
/// 用于「运行时才知道步骤内容」的场景——目前唯一来源是**插件 JS 生成的编排计划**
/// （ADR-006）。两者由 [`OwnedStep::from`] 单向转换，静态常量仍是唯一定义源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedStep {
    /// 步骤名（日志与进度展示）
    pub name: String,
    /// 本步指令
    pub instruction: String,
    /// 本步可见的工具（调用方须先校验其合法性）
    pub tools: Vec<String>,
    /// 本步最多推理轮数
    pub max_rounds: usize,
}

impl From<&Step> for OwnedStep {
    fn from(s: &Step) -> Self {
        Self {
            name: s.name.to_string(),
            instruction: s.instruction.to_string(),
            tools: s.tools.iter().map(|t| t.to_string()).collect(),
            max_rounds: s.max_rounds,
        }
    }
}

/// 画像的执行模式（ADR-005 L2）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeMode {
    /// 自由 ReAct：模型自行决定调什么工具、何时停（现状默认）
    ReAct,
    /// 编译期常量流水线（内置画像声明）
    ///
    /// 保持 `&'static [Step]`：`PROFILES` 是 `static`，其初始化表达式必须
    /// 在编译期可求值——换成 `Vec` 会直接编译失败。
    Pipeline(&'static [Step]),
    /// 运行时流水线（插件 JS 生成的编排计划）
    ///
    /// 插件计划的生命周期不是 `'static`，静态变体容纳不下，故单列一个 owned 变体。
    /// 执行前由调用方统一转成 `Vec<OwnedStep>`（见 `engine` 的模式分发）。
    DynamicPipeline(Vec<OwnedStep>),
    //
    // `SingleShot`（单轮直出）**刻意未实现**：计划中唯一的消费方是「AI 工具箱」，
    // 而该迁移本身标为可选、且需先对齐网络重试能力。在此之前加入只会成为无人
    // 读取的死代码——与 `extends` 同样的取舍（见文件头注释）。
}

/// 拆书流水线：读章节 → 提炼要点 → 生成卡片
///
/// 每步都**收窄工具与轮数**，把「先看清原文、再提炼、最后落库」的顺序固化下来。
/// 自由 ReAct 下模型常会跳过取数直接开写，或把三步挤在一轮里草草了事；拆成步骤
/// 后，模型只能在步内自由行动，顺序与工具边界由本表保证。
const BREAKDOWN_STEPS: &[Step] = &[
    Step {
        name: "拆章节",
        instruction: "先用 list_book_chapters 定位用户所指的章节，再用 split_chapter 切成片段。本步只输出片段清单与结构观察，不要提前提炼要点。",
        tools: &["list_book_chapters", "split_chapter"],
        max_rounds: 4,
    },
    Step {
        name: "提炼要点",
        instruction: "基于上一步的片段逐段提炼要点。每条要点须自带背景、可脱离原文独立理解，并标注出自第几段。本步不调用任何工具，直接输出要点列表。",
        tools: &[],
        max_rounds: 1,
    },
    Step {
        name: "生成卡片",
        instruction: "把上一步的每条要点用 create_note_card 固化成卡片：card_type 一律 misc，章节出处与概念层级写进 tags。写完后简要汇报共建了几张卡片、分别是什么。",
        tools: &["create_note_card"],
        max_rounds: 8,
    },
];

// ── 注册表 ──────────────────────────────────────────────────────────────────

/// 画像类别：能力（做什么）或领域（处理什么）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileKind {
    /// 能力画像：定义「做什么动作」，由用户在 AI 面板选择
    Ability,
    /// 领域画像：定义「处理什么类型的作品」，由作品的 `book_type` 决定
    Domain,
}

/// 单个画像的完整定义：提示词 / 展示元数据 / 场景提示 / 工具集 / 执行预算
///
/// 刻意**不是 `Copy`**：`runtime` 字段含 `Vec`（插件可运行时生成编排计划），
/// 拷贝语义会掩盖这一步的开销。各处一律以 `&'static AgentProfile` 传递。
#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub id: &'static str,
    pub kind: ProfileKind,
    /// 中文名（前端 chips / 徽标展示）
    pub label: &'static str,
    /// 一句话说明（前端 tooltip / 空态描述）
    pub description: &'static str,
    /// 图标名（lucide 的 kebab-case 名，如 `pen-tool`；前端做名→组件映射）
    pub icon: &'static str,
    /// 主题色（十六进制，如 `#6366f1`）
    pub color: &'static str,
    /// 快捷操作文案（渲染在空会话占位区，点击即填入输入框）
    pub quick_actions: &'static [&'static str],
    /// 基准 System Prompt
    pub base_prompt: &'static str,
    /// 动态场景提示（关键词 → 追加提示），按用户消息关键词命中注入
    pub hints: &'static [(&'static str, &'static str)],
    /// 工具子集，引用 L0 注册表中的工具名
    pub tools: &'static [&'static str],
    /// 最大工具推理轮数（领域画像填 0 表示「不约束」，合并时取较大值）
    pub max_rounds: usize,
    /// 整个 Agent 执行总超时（秒）（领域画像填 0 表示「不约束」）
    pub timeout_secs: u64,
    /// 执行模式（L2）：默认 [`RuntimeMode::ReAct`]，固定流程类画象声明 `Pipeline`
    pub runtime: RuntimeMode,
}

/// 全部画像（单一真相源）。新增一个 Skill 或领域只需在此追加一项。
static PROFILES: &[AgentProfile] = &[
    // ── 能力画像 ──
    AgentProfile {
        id: "writing",
        kind: ProfileKind::Ability,
        label: "写作辅助",
        description: "大纲生成、情节建议、角色对话模拟",
        icon: "pen-tool",
        color: "#6366f1",
        quick_actions: WRITING_QUICK_ACTIONS,
        base_prompt: WRITING_PROMPT,
        hints: WRITING_HINTS,
        tools: WRITING_TOOLS,
        max_rounds: 5,
        timeout_secs: 300,
        runtime: RuntimeMode::ReAct,
    },
    AgentProfile {
        id: "analysis",
        kind: ProfileKind::Ability,
        label: "内容分析",
        description: "文风分析、剧情连贯性、伏笔追踪",
        icon: "search",
        color: "#f59e0b",
        quick_actions: ANALYSIS_QUICK_ACTIONS,
        base_prompt: ANALYSIS_PROMPT,
        hints: ANALYSIS_HINTS,
        tools: ANALYSIS_TOOLS,
        max_rounds: 10,
        timeout_secs: 480,
        runtime: RuntimeMode::ReAct,
    },
    AgentProfile {
        id: "research",
        kind: ProfileKind::Ability,
        label: "研究辅助",
        description: "背景资料检索、世界观一致性校验",
        icon: "book-open",
        color: "#10b981",
        quick_actions: RESEARCH_QUICK_ACTIONS,
        base_prompt: RESEARCH_PROMPT,
        hints: RESEARCH_HINTS,
        tools: RESEARCH_TOOLS,
        max_rounds: 20,
        timeout_secs: 600,
        runtime: RuntimeMode::ReAct,
    },
    AgentProfile {
        id: "polish",
        kind: ProfileKind::Ability,
        label: "润色优化",
        description: "语法纠错、文笔润色、风格统一",
        icon: "sparkles",
        color: "#ec4899",
        quick_actions: POLISH_QUICK_ACTIONS,
        base_prompt: POLISH_PROMPT,
        hints: POLISH_HINTS,
        tools: POLISH_TOOLS,
        max_rounds: 3,
        timeout_secs: 240,
        runtime: RuntimeMode::ReAct,
    },
    // ── 领域画像（id 对齐 `books.book_type` 的值域）──
    AgentProfile {
        id: "novel",
        kind: ProfileKind::Domain,
        label: "小说",
        description: "情节 · 人物 · 文风",
        icon: "book-open",
        color: "#6366f1",
        quick_actions: DOMAIN_QUICK_ACTIONS,
        base_prompt: NOVEL_PROMPT,
        hints: NOVEL_HINTS,
        tools: DOMAIN_TOOLS,
        max_rounds: 0,
        timeout_secs: 0,
        runtime: RuntimeMode::ReAct,
    },
    AgentProfile {
        id: "thesis",
        kind: ProfileKind::Domain,
        label: "论文",
        description: "论点 · 论据 · 引用",
        icon: "graduation-cap",
        color: "#0ea5e9",
        quick_actions: DOMAIN_QUICK_ACTIONS,
        base_prompt: THESIS_PROMPT,
        hints: THESIS_HINTS,
        tools: DOMAIN_TOOLS,
        max_rounds: 0,
        timeout_secs: 0,
        runtime: RuntimeMode::ReAct,
    },
    AgentProfile {
        id: "breakdown",
        kind: ProfileKind::Domain,
        label: "拆书",
        description: "拆解 · 卡片 · 要点",
        icon: "scissors",
        color: "#f59e0b",
        quick_actions: DOMAIN_QUICK_ACTIONS,
        base_prompt: BREAKDOWN_PROMPT,
        hints: BREAKDOWN_HINTS,
        tools: EXTRACTION_TOOLS,
        max_rounds: 0,
        timeout_secs: 0,
        // 首个 Pipeline 真实用例（阶段六任务 5）。学科笔记暂留 ReAct：
        // 先用一个用例验证模式有效性，不一次性铺开。
        runtime: RuntimeMode::Pipeline(BREAKDOWN_STEPS),
    },
    AgentProfile {
        id: "note",
        kind: ProfileKind::Domain,
        label: "学科笔记",
        description: "概念 · 公式 · 例题 · 复习",
        icon: "notebook-pen",
        color: "#10b981",
        quick_actions: DOMAIN_QUICK_ACTIONS,
        base_prompt: NOTE_PROMPT,
        hints: NOTE_HINTS,
        tools: EXTRACTION_TOOLS,
        max_rounds: 0,
        timeout_secs: 0,
        // 已具备提炼工具，但流程尚未固化：等拆书用例验证通过后再迁 Pipeline
        runtime: RuntimeMode::ReAct,
    },
];

/// 按 (id, kind) 精确查表（不存在返回 `None`）
fn find_kind(id: &str, kind: ProfileKind) -> Option<&'static AgentProfile> {
    PROFILES.iter().find(|p| p.id == id && p.kind == kind)
}

/// 查能力画像（不存在返回 `None`）。
///
/// 刻意不做「未知 id 回退 writing」的统一兜底：改造前四处的兜底语义**并不一致**
/// ——基准提示回退 writing、动态提示回退空表、工具集回退默认五项、预算回退常量。
/// 统一回退会改变行为，故由各调用点自行选择。
pub fn find_ability(id: &str) -> Option<&'static AgentProfile> {
    find_kind(id, ProfileKind::Ability)
}

/// 查领域画像（不存在返回 `None`）
pub fn find_domain(id: &str) -> Option<&'static AgentProfile> {
    find_kind(id, ProfileKind::Domain)
}

/// 查能力画像 + 回退 writing（供「应当回退」的调用点使用，如基准提示）
pub fn ability_or_writing(id: &str) -> &'static AgentProfile {
    find_ability(id).unwrap_or(&PROFILES[0])
}

/// 领域画像的兜底类型（`book_type` 为空或未知时使用）
pub const DEFAULT_DOMAIN_ID: &str = "novel";

/// 查领域画像 + 回退 novel；`book_type` 为**非空**未知值时记一条告警
///
/// 不引入「通用」画像（ADR-004 决策 5）：多一个画像就多一份维护成本，
/// 且「通用」与「小说」的差异对模型而言不明确。
pub fn domain_or_novel(book_type: &str) -> &'static AgentProfile {
    match find_domain(book_type) {
        Some(p) => p,
        None => {
            // 空串是存量作品的正常状态（阶段三迁移前创建），不告警
            if !book_type.is_empty() {
                crate::app_log_warn!(
                    "[agent] 未知作品类型 `{book_type}`，回退 `{DEFAULT_DOMAIN_ID}` 画像"
                );
            }
            find_domain(DEFAULT_DOMAIN_ID).expect("DEFAULT_DOMAIN_ID 必须在注册表中存在")
        }
    }
}

// ── L3 前端自动发现（阶段五）───────────────────────────────────────────────

/// 下发给前端的画像元数据（不含提示词——那是内部实现，不该暴露）
///
/// 前端据此渲染技能 chips / 领域徽标 / 快捷操作，
/// 因此**新增画像时前端无需改动**（ADR-005 L3 的目标）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
//
// ⚠️ 字段一律是 **owned String**，不是 `&'static str`。
// 阶段七（ADR-006）起这个结构还要承载**插件画像**——它们的字符串来自运行时
// 读取的 `manifest.json`，生命周期不是 `'static`。序列化结果不变，前端无需改动。
pub struct ProfileMeta {
    pub id: String,
    /// `"ability"` 或 `"domain"`
    pub kind: ProfileKind,
    pub label: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub quick_actions: Vec<String>,
}

impl From<&'static AgentProfile> for ProfileMeta {
    fn from(p: &'static AgentProfile) -> Self {
        Self {
            id: p.id.to_string(),
            kind: p.kind,
            label: p.label.to_string(),
            description: p.description.to_string(),
            icon: p.icon.to_string(),
            color: p.color.to_string(),
            quick_actions: p.quick_actions.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// 全部画像的元数据（供 `list_agent_profiles` IPC 下发）
///
/// 能力画像在前、领域画像在后（与 `PROFILES` 注册顺序一致），
/// 前端按 `kind` 分组使用，不依赖顺序。
pub fn profile_metas() -> Vec<ProfileMeta> {
    PROFILES.iter().map(ProfileMeta::from).collect()
}

/// 内置画像 id 全集
///
/// 供插件宿主（ADR-006）校验撞车：插件声明的画像 id 若与内置重名，
/// 内置画像会先被命中，插件那一份将永远选不到——所以在安装时就必须拒绝。
pub fn builtin_profile_ids() -> Vec<&'static str> {
    PROFILES.iter().map(|p| p.id).collect()
}

// ── 领域 × 能力合并 ─────────────────────────────────────────────────────────

/// 合并后的有效画像（阶段四）
///
/// 「领域 × 能力」相遇时的合并规则（ADR-004 / 实施计划阶段四）：
///
/// | 维度 | 规则 | 理由 |
/// |------|------|------|
/// | 基准提示词 | 领域基准 → 能力基准，纯拼接 | 领域定义世界观，能力定义动作，后者更具体应靠后 |
/// | 工具集 | 取并集（能力在前，领域新增在后） | 互补，取交集会导致某一侧工具不可用 |
/// | 执行预算 | 取较大值 | 保守策略，避免领域需要的多轮被能力的小预算截断 |
/// | 执行模式 | 领域优先、能力次之 | 流程形状由「处理什么作品」决定（如拆书的读→提炼→落库），故领域声明优先 |
#[derive(Debug, Clone)]
pub struct EffectiveProfile {
    /// 能力画像（用户选择的动作）
    pub ability: &'static AgentProfile,
    /// 能力 id 是否在注册表中命中（`false` 表示已兜底为 writing）
    ///
    /// 必须保留此标记：未知能力的**预算**兜底是 `(15, 600)` 而**不是** writing 的
    /// `(5, 300)`（改造前即如此）。若只看 `ability.id` 就无法区分「显式选了 writing」
    /// 与「未知 id 兜底成 writing」，会把两者的预算混为一谈。
    pub ability_matched: bool,
    /// 领域画像（作品类型决定）
    pub domain: &'static AgentProfile,
    /// 领域基准 + 能力基准（**不含动态场景提示**，由 `prompts` 层注入）
    pub base_prompt: String,
    /// 合并后的工具集（并集）
    pub tools: Vec<&'static str>,
    /// 合并后的最大推理轮数
    pub max_rounds: usize,
    /// 合并后的总超时（秒）
    pub timeout_secs: u64,
    /// 合并后的执行模式（L2）
    pub runtime: RuntimeMode,
}

/// 合并能力画像与领域画像
///
/// 两侧 id 都会走各自的兜底（能力回退 writing、领域回退 novel），
/// 因此**不会失败**——调用方无需处理「画像不存在」。
pub fn merge(ability_id: &str, domain_id: &str) -> EffectiveProfile {
    let ability = ability_or_writing(ability_id);
    let domain = domain_or_novel(domain_id);

    // 工具并集：能力工具保序在前，领域新增的追加在后（去重）
    let mut tools: Vec<&'static str> = ability.tools.to_vec();
    for t in domain.tools {
        if !tools.contains(t) {
            tools.push(t);
        }
    }

    // 执行模式取领域优先：流程形状由「处理什么作品」决定，能力通常不固定流程，
    // 故仅在领域未声明（ReAct）时才回落到能力的声明。
    //
    // 按引用匹配：`RuntimeMode` 含 owned 变体后不再是 `Copy`，
    // 无法从 `&AgentProfile` 中把字段移动出来。
    let runtime = match &domain.runtime {
        RuntimeMode::ReAct => ability.runtime.clone(),
        RuntimeMode::Pipeline(steps) => RuntimeMode::Pipeline(steps),
        RuntimeMode::DynamicPipeline(steps) => RuntimeMode::DynamicPipeline(steps.clone()),
    };

    EffectiveProfile {
        ability,
        ability_matched: find_ability(ability_id).is_some(),
        domain,
        base_prompt: format!("{}\n\n{}", domain.base_prompt, ability.base_prompt),
        tools,
        max_rounds: ability.max_rounds.max(domain.max_rounds),
        timeout_secs: ability.timeout_secs.max(domain.timeout_secs),
        runtime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 阶段二重构前导出的**能力画像**基线（2026-10-10）。
    /// 任何画像字段的**非预期**变更都会在此失败。
    /// 领域画像是阶段四新增的，无历史基线，故不在此表。
    const ABILITY_BASELINE: &[(&str, usize, usize, usize, u64)] = &[
        // (id, base_prompt 字符数, hints 条数, tools 条数, timeout_secs)
        ("writing", 418, 5, 5, 300),
        ("analysis", 398, 4, 5, 480),
        ("research", 365, 4, 4, 600),
        ("polish", 373, 4, 3, 240),
    ];

    #[test]
    fn ability_profiles_match_pre_refactor_baseline() {
        for (id, prompt_len, hints_len, tools_len, timeout) in ABILITY_BASELINE {
            let p = find_ability(id).unwrap_or_else(|| panic!("能力画像 `{id}` 未注册"));
            assert_eq!(p.base_prompt.chars().count(), *prompt_len, "{id} 提示词长度");
            assert_eq!(p.hints.len(), *hints_len, "{id} hints 条数");
            assert_eq!(p.tools.len(), *tools_len, "{id} 工具数");
            assert_eq!(p.timeout_secs, *timeout, "{id} 总超时");
        }
        // 新増能力画像时必须补基线
        let ability_count = PROFILES
            .iter()
            .filter(|p| p.kind == ProfileKind::Ability)
            .count();
        assert_eq!(ABILITY_BASELINE.len(), ability_count, "新增能力画像须同步补基线");
    }

    #[test]
    fn baseline_rounds_are_explicit() {
        // max_rounds 单独断言，避免与 timeout 混淆
        assert_eq!(find_ability("writing").unwrap().max_rounds, 5);
        assert_eq!(find_ability("analysis").unwrap().max_rounds, 10);
        assert_eq!(find_ability("research").unwrap().max_rounds, 20);
        assert_eq!(find_ability("polish").unwrap().max_rounds, 3);
    }

    /// hint 关键词顺序决定「最多注入 3 条」的截断结果，必须与原表一致
    #[test]
    fn hint_keywords_preserve_order() {
        let cases: &[(&str, &str)] = &[
            ("writing", "大纲,情节,对话,冲突,角色"),
            ("analysis", "文风,连贯,伏笔,节奏"),
            ("research", "设定,世界观,关系,校验"),
            ("polish", "语法,文笔,风格,对话"),
            ("novel", "情节,人物,文风"),
            ("thesis", "论点,论据,引用"),
            ("breakdown", "拆解,卡片,要点"),
            ("note", "概念,公式,例题,复习"),
        ];
        for (id, expected) in cases {
            let keys: Vec<&str> = PROFILES
                .iter()
                .find(|p| p.id == *id)
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
            assert_eq!(&find_ability(id).unwrap().tools.join(","), expected, "{id} 工具集变化");
        }
        // 未知能力回退 writing，故工具集等于 writing 的五项
        assert_eq!(
            &merge("no_such", "novel").tools.join(","),
            "read_chapter_summary,read_chapter_chunk,list_book_chapters,search_world_cards,get_book_context"
        );
    }

    #[test]
    fn unknown_id_lookup_semantics() {
        assert!(find_ability("no_such").is_none(), "精确查表不应回退");
        assert!(find_ability("").is_none());
        // 但 ability_or_writing 回退 writing
        assert_eq!(ability_or_writing("no_such").id, "writing");
        assert_eq!(ability_or_writing("").id, "writing");
    }

    /// 领域画像 id 必须与 `books.book_type` 的值域一一对应
    #[test]
    fn domain_ids_cover_book_type_values() {
        for id in ["novel", "thesis", "breakdown", "note"] {
            let p = find_domain(id).unwrap_or_else(|| panic!("领域画像 `{id}` 未注册"));
            assert_eq!(p.kind, ProfileKind::Domain);
        }
        // 空 / 未知回退 novel
        assert_eq!(domain_or_novel("").id, "novel");
        assert_eq!(domain_or_novel("poetry").id, "novel");
        assert_eq!(domain_or_novel(DEFAULT_DOMAIN_ID).id, "novel");
    }

    /// 按 kind 隔离：能力 id 不会误匹配到领域画像，反之亦然
    #[test]
    fn lookups_are_isolated_by_kind() {
        assert!(find_domain("writing").is_none(), "writing 是能力画像，不该被领域查到");
        assert!(find_ability("novel").is_none(), "novel 是领域画像，不该被能力查到");
    }

    #[test]
    fn registry_is_self_consistent() {
        let mut seen = std::collections::HashSet::new();
        for p in PROFILES {
            assert!(seen.insert(p.id), "重复画像 id: {}", p.id);
            assert!(!p.base_prompt.is_empty(), "{} 缺少基准提示", p.id);
            assert!(!p.hints.is_empty(), "{} hints 为空", p.id);
            match p.kind {
                // 能力画像定义动作，必须有工具与正轮数
                ProfileKind::Ability => {
                    assert!(!p.tools.is_empty(), "{} 工具集为空", p.id);
                    assert!(p.max_rounds > 0, "{} 轮数须为正", p.id);
                    assert!(p.timeout_secs > 0, "{} 超时须为正", p.id);
                }
                // 领域画像定义世界观：可携带领域专属工具（提炼类领域），
                // 但预算恒为 0 表示「不约束」，动作仍由能力画像决定
                ProfileKind::Domain => {
                    assert_eq!(p.max_rounds, 0, "{} 领域画像不应约束轮数", p.id);
                    assert_eq!(p.timeout_secs, 0, "{} 领域画像不应约束超时", p.id);
                }
            }
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

    // ── 合并规则（阶段四）──

    #[test]
    fn merge_prompt_is_domain_then_ability() {
        let eff = merge("polish", "note");
        assert!(eff.base_prompt.starts_with(NOTE_PROMPT));
        assert!(eff.base_prompt.ends_with(POLISH_PROMPT));
        assert_eq!(eff.ability.id, "polish");
        assert_eq!(eff.domain.id, "note");
    }

    /// 工具集取并集：领域当前无工具，故并集 = 能力工具，顺序不变
    #[test]
    fn merge_tools_is_union_with_ability_first() {
        // 创作类领域（小说 / 论文）无专属工具 → 并集即能力工具本身
        assert_eq!(merge("research", "novel").tools, RESEARCH_TOOLS);
        assert_eq!(merge("polish", "thesis").tools, POLISH_TOOLS);

        // 提炼类领域追加专属工具。RESEARCH_TOOLS 本就含 list_book_chapters，
        // 去重后它仍停在能力段的位置——这正是「能力在前、领域新增在后」的含义
        assert_eq!(
            merge("research", "breakdown").tools,
            [
                "read_chapter_summary",
                "list_book_chapters",
                "search_world_cards",
                "get_book_context",
                "split_chapter",
                "create_note_card",
            ]
        );
        // POLISH_TOOLS 与提炼工具无交集 → 三者整体追加在后
        assert_eq!(
            merge("polish", "note").tools,
            [
                "read_chapter",
                "read_chapter_chunk",
                "get_book_context",
                "list_book_chapters",
                "split_chapter",
                "create_note_card",
            ]
        );
    }

    /// 领域工具的开关语义：只有提炼类领域引入专属工具，创作类领域一律不带
    #[test]
    fn only_extraction_domains_add_tools() {
        for id in ["breakdown", "note"] {
            assert_eq!(
                find_domain(id).unwrap().tools,
                EXTRACTION_TOOLS,
                "{id} 应引入提炼工具"
            );
        }
        for id in ["novel", "thesis"] {
            assert!(
                find_domain(id).unwrap().tools.is_empty(),
                "{id} 是创作类领域，不应引入工具"
            );
        }
        // 提炼工具须「读写成对」：既能列章节 / 看清结构，也能把结果落库
        assert!(EXTRACTION_TOOLS.contains(&"list_book_chapters"));
        assert!(EXTRACTION_TOOLS.contains(&"split_chapter"));
        assert!(EXTRACTION_TOOLS.contains(&"create_note_card"));
    }

    /// 执行模式合并：领域优先、能力次之，都未声明则 ReAct
    #[test]
    fn runtime_mode_is_domain_first() {
        // 拆书领域声明 Pipeline → 无论搭哪个能力都走流水线
        for ability in ["writing", "analysis", "research", "polish", "no_such"] {
            assert_eq!(
                merge(ability, "breakdown").runtime,
                RuntimeMode::Pipeline(BREAKDOWN_STEPS),
                "{ability} 下拆书领域应走 Pipeline"
            );
        }
        // 其余领域（含尚未固化流程的学科笔记）与所有能力都是 ReAct
        for domain in ["novel", "thesis", "note"] {
            for ability in ["writing", "research"] {
                assert_eq!(merge(ability, domain).runtime, RuntimeMode::ReAct);
            }
        }
        // 未知领域兜底 novel → 仍是 ReAct
        assert_eq!(merge("writing", "poetry").runtime, RuntimeMode::ReAct);
    }

    /// 拆书流水线的步骤须结构完整：「读 → 提炼 → 落库」三段，工具边界逐段收敛
    #[test]
    fn breakdown_steps_are_well_formed() {
        let RuntimeMode::Pipeline(steps) = find_domain("breakdown").unwrap().runtime else {
            panic!("拆书领域应为 Pipeline 模式");
        };
        assert_eq!(steps.len(), 3, "拆书流水线应为三步");

        for s in steps {
            assert!(!s.name.is_empty(), "步骤名不可为空");
            assert!(!s.instruction.is_empty(), "步骤「{}」缺少指令", s.name);
            assert!(s.max_rounds > 0, "步骤「{}」轮数须为正", s.name);
            // 步骤工具须是领域工具的子集——「步骤 ⊆ 领域 ⊆ 有效工具集」是可达性的前提
            for t in s.tools {
                assert!(
                    EXTRACTION_TOOLS.contains(t),
                    "步骤「{}」的工具 `{t}` 不在领域工具集中",
                    s.name
                );
            }
        }

        // 工具边界：读 → 不调工具 → 只写
        assert!(steps[0].tools.contains(&"split_chapter"), "首步须能拆章节");
        assert!(
            steps[1].tools.is_empty(),
            "提炼要点步不应调工具，否则模型会绕开「先读后写」"
        );
        assert_eq!(steps[2].tools, &["create_note_card"], "末步只应落库");
    }

    /// 流水线可达性：每一步声明的工具，在**任意能力**下都必须在有效工具集内
    ///
    /// 若步骤引用了有效工具集之外的名字，模型会看到一个拿不到的工具，流水线必然
    /// 卡在这一步。领域工具随领域一起进并集，故「步骤 ⊆ 领域工具」即可保证任意
    /// 能力组合下都成立——本测试是把这条推理钉住，防止将来改工具集时悄悄失效。
    #[test]
    fn pipeline_steps_are_reachable() {
        let RuntimeMode::Pipeline(steps) = find_domain("breakdown").unwrap().runtime else {
            panic!("拆书领域应为 Pipeline 模式");
        };
        for ability in ["writing", "analysis", "research", "polish", "no_such"] {
            let eff = merge(ability, "breakdown");
            for step in steps {
                for t in step.tools {
                    assert!(
                        eff.tools.contains(t),
                        "能力 `{ability}` 下步骤「{}」的工具 `{t}` 不可达: {:?}",
                        step.name,
                        eff.tools
                    );
                }
            }
        }
    }

    /// 预算取较大值：领域为 0（不约束），故结果等于能力预算
    #[test]
    fn merge_budget_takes_larger() {
        let eff = merge("research", "novel");
        assert_eq!(eff.max_rounds, 20);
        assert_eq!(eff.timeout_secs, 600);
        let eff2 = merge("polish", "thesis");
        assert_eq!(eff2.max_rounds, 3);
        assert_eq!(eff2.timeout_secs, 240);
    }

    /// 未知两侧 id 都走兜底，不 panic
    #[test]
    fn merge_never_fails() {
        let eff = merge("no_such", "");
        assert_eq!(eff.ability.id, "writing");
        assert_eq!(eff.domain.id, "novel");
    }

    // ── L3 展示元数据（阶段五）──

    /// 前端依赖这些字段渲染 chips / 徽标 / 快捷操作，缺任一即出现空白 UI
    #[test]
    fn every_profile_has_display_metadata() {
        for p in PROFILES {
            assert!(!p.label.is_empty(), "{} 缺 label", p.id);
            assert!(!p.description.is_empty(), "{} 缺 description", p.id);
            assert!(!p.icon.is_empty(), "{} 缺 icon", p.id);
            assert!(p.color.starts_with('#'), "{} 的 color 须为十六进制: {}", p.id, p.color);
        }
    }

    #[test]
    fn ability_quick_actions_match_frontend_baseline() {
        // 原表在 src/components/ai/panel/constants.ts，迁入注册表后逐字比对
        assert_eq!(find_ability("writing").unwrap().quick_actions.len(), 3);
        assert_eq!(find_ability("analysis").unwrap().quick_actions.len(), 3);
        assert_eq!(find_ability("research").unwrap().quick_actions.len(), 3);
        assert_eq!(find_ability("polish").unwrap().quick_actions.len(), 3);
        assert_eq!(
            find_ability("polish").unwrap().quick_actions[0],
            "润色当前章节，保持原文风格"
        );
        // 领域画像不单独承担动作，故无快捷操作
        for d in ["novel", "thesis", "breakdown", "note"] {
            assert!(find_domain(d).unwrap().quick_actions.is_empty());
        }
    }

    #[test]
    fn profile_metas_cover_registry_and_serialize_kind() {
        let metas = profile_metas();
        assert_eq!(metas.len(), PROFILES.len(), "元数据条数须覆盖注册表");
        // kind 必须序列化为小写字符串（前端按此分组）
        let json = serde_json::to_value(&metas).expect("序列化失败");
        assert_eq!(json[0]["kind"], "ability");
        assert_eq!(json[4]["kind"], "domain");
        assert_eq!(json[4]["id"], "novel");
        // camelCase 生效（前端字段名为 quickActions）
        assert!(json[0]["quickActions"].is_array());
        // 提示词属内部实现，不应下发
        assert!(json[0].get("base_prompt").is_none());
        assert!(json[0].get("basePrompt").is_none());
    }

    /// 四种领域在同一能力下必须产出**不同**的基准提示（否则等于领域没生效）
    #[test]
    fn four_domains_produce_distinct_prompts() {
        let mut seen = std::collections::HashSet::new();
        for d in ["novel", "thesis", "breakdown", "note"] {
            assert!(seen.insert(merge("writing", d).base_prompt.clone()), "领域 `{d}` 提示词重复");
        }
    }
}
