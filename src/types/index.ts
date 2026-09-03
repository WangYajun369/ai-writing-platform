// 核心类型定义 —— 智写时光 TimeWrite

/** 章节状态枚举 */
export type ChapterStatus = 'outline' | 'draft' | 'polishing' | 'finished'

/** 书籍基础信息 */
export interface Book {
  id: string
  title: string
  author: string
  description: string
  coverImage?: string
  /** 总字数 */
  wordCount: number
  /** 创建时间 ISO */
  createdAt: string
  /** 最后修改时间 ISO */
  updatedAt: string
  /** 日更目标字数 */
  dailyTarget: number
  /** 今日已写字数 */
  todayCount: number
  /** db 文件路径 */
  dbPath: string
  tags: string[]
  /** 软删除时间（放入回收站的时间） */
  deletedAt?: string
  /** 作品大纲 */
  outline?: string
}

/** 卷信息 */
export interface Volume {
  id: string
  bookId: string
  title: string
  sortOrder: number
  createdAt: string
  /** 软删除时间 */
  deletedAt?: string
}

/** 章节信息 */
export interface Chapter {
  id: string
  bookId: string
  volumeId?: string
  title: string
  content?: string
  /** HTML 富文本内容 */
  contentHtml?: string
  wordCount: number
  status: ChapterStatus
  sortOrder: number
  createdAt: string
  updatedAt: string
  /** 软删除 */
  deletedAt?: string
  /** AI 章节总结内容 */
  summary?: string
  /** 上次总结时间 ISO */
  summaryAt?: string
  /** 章节大纲 */
  outline?: string
}

/** 版本快照 */
export interface Snapshot {
  id: string
  chapterId: string
  content: string
  contentHtml: string
  wordCount: number
  /** 'auto' | 'milestone' */
  type: 'auto' | 'milestone'
  label?: string
  createdAt: string
}

/** 日记 — 每天一篇，diaryDate 格式 YYYY-MM-DD */
export interface Diary {
  id: string
  /** 日记日期 YYYY-MM-DD */
  diaryDate: string
  /** HTML 富文本内容 */
  contentHtml: string
  wordCount: number
  /** 关键字列表 */
  keywords: string[]
  createdAt: string
  updatedAt: string
}

/** 日记摘要 — 日历/列表场景，不含正文 */
export interface DiaryMeta {
  id: string
  /** 日记日期 YYYY-MM-DD */
  diaryDate: string
  wordCount: number
  /** 关键字列表 */
  keywords: string[]
  createdAt: string
  updatedAt: string
}

/** 保存日记参数（对齐 Rust SaveDiaryParams） */
export interface SaveDiaryParams {
  diaryDate: string
  contentHtml: string
  wordCount: number
  keywords: string[]
}

/** 日程 — 对应 schedules 表，某天可有多条 */
export interface Schedule {
  id: string
  /** 日程日期 YYYY-MM-DD */
  scheduleDate: string
  content: string
  done: boolean
  createdAt: string
  updatedAt: string
}

/** 保存日程参数（对齐 Rust SaveScheduleParams） */
export interface SaveScheduleParams {
  id?: string
  scheduleDate: string
  content: string
  done: boolean
}

/** 世界观卡片类型 */
export type WorldCardType = 'character' | 'location' | 'timeline' | 'faction' | 'item' | 'misc'

/** 世界观卡片 */
export interface WorldCard {
  id: string
  bookId: string
  type: WorldCardType
  title: string
  content: string
  contentHtml: string
  tags: string[]
  /** 向量 embedding 是否已生成 */
  vectorized: boolean
  createdAt: string
  updatedAt: string
}

/** AI 对话配置（当前仅使用 DeepSeek，后期扩展更多服务商） */
export interface AiChatConfig {
  provider: 'bigmodel' | 'deepseek'
  endpoint: string
  model: string
  temperature: number
  maxTokens: number
  /** 智谱 API Key（后期扩展使用） */
  bigmodelApiKey?: string
  /** DeepSeek API Key */
  deepseekApiKey?: string
  /** DeepSeek 思考模式开关 */
  thinkingEnabled: boolean
  /** 滑动窗口大小（保留最近 N 个轮次，每个轮次 = user + assistant 一对消息），默认 10 */
  contextWindowSize: number
}

/** 获取当前选中服务商的 API Key */
export function getChatApiKey(config: AiChatConfig): string | undefined {
  return config.provider === 'bigmodel' ? config.bigmodelApiKey : config.deepseekApiKey
}

/**
 * RAG / Embedding 检索服务商（智谱 BigModel）
 *
 * 预留能力：向量索引/语义检索尚未接入对话（当前对话由 Agent 引擎通过内置
 * 工具检索章节与世界观资料）。保留配置用于连接测试与未来接入。
 */
export type RagProvider = 'bigmodel'

/** RAG / Embedding 检索配置（预留能力，不影响当前对话） */
export interface RagConfig {
  provider: RagProvider
  endpoint: string
  embeddingModel: string
  /** 智谱 API Key */
  bigmodelApiKey?: string
}

/** 获取当前 RAG 服务商的 API Key */
export function getRagApiKey(config: RagConfig): string | undefined {
  return config.bigmodelApiKey
}

/** AI 总配置（对话与 RAG 解耦） */
export interface AiConfig {
  chat: AiChatConfig
  rag: RagConfig
}

/** AI 工具箱中的单个提示词 */
export interface AiToolPrompt {
  id: string
  /** 工具名称，如"章节总结""小说大纲"等 */
  name: string
  /** 工具简短描述，说明该工具的用途 */
  description: string
  /** 自定义 System Prompt，留空则使用后端默认提示词 */
  systemPrompt: string
}

/** AI 工具箱提示词分类 */
export interface AiToolCategory {
  id: string
  /** 分类名称，如"常用工具""描写辅助""世界设定"等 */
  name: string
  /** 分类主题色（CSS 渐变字符串），用于卡片头部背景 */
  color: string
  /** 该分类下的提示词列表 */
  tools: AiToolPrompt[]
}

/** RAG 检索结果 */
export interface RagResult {
  snippet: string
  sourceType: 'chapter' | 'world_card'
  sourceId: string
  sourceTitle: string
  distance: number
}

/** 写作目标 */
export interface WritingGoal {
  bookId: string
  dailyTarget: number
  totalTarget: number
  startDate: string
  endDate?: string
}

/** 提交给 AI 大模型的请求载荷（用于详情展示） */
export interface ChatRequestPayload {
  provider: string
  model: string
  temperature: number
  maxTokens: number
  thinkingEnabled?: boolean
  messages: { role: string; content: string }[]
  /** RAG 检索上下文片段（启用时） */
  ragContext?: { snippet: string; sourceType?: string; sourceTitle?: string; score?: number }[]
  /** 章节总结信息（字数超过阈值时） */
  chapterSummary?: {
    summary: string
    originalChars: number
    summaryChars: number
    thinking: string
  }
}

/** 对话历史摘要（滑动窗口溢出后的压缩上下文） */
export interface ConversationSummary {
  /** 压缩后的摘要文本 */
  summary: string
  /** 摘要覆盖的最早消息 ID（标记滑动窗口已推进到的位置） */
  coveredUpToId: string
  /** 摘要字数 */
  summaryChars: number
  /** 上次更新摘要的时间 */
  updatedAt: string
}

/** AI 对话消息 */
export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 深度思考过程（智谱/DeepSeek 推理模型） */
  thinking: string
  /** 当前生成阶段 */
  phase: 'thinking' | 'answering' | 'done' | 'summarizing' | 'retrying'
  /** 是否处于章节总结阶段 */
  isSummarizing?: boolean
  loading?: boolean
  usage?: {
    inputTokens: number
    outputTokens: number
    inputChars: number
    outputChars: number
  } | null
  /** 提交给 AI 的原始请求载荷（仅助手消息，供详情查看） */
  requestPayload?: ChatRequestPayload
  /** 消息附带的前置操作（如校验失败时引导用户打开特定面板） */
  action?: 'open-world-outline'
}

/** Diff 对比视图模式 */
export type DiffViewMode = 'side-by-side' | 'inline'

/** 导入导出格式（当前仅支持 txt/md/html） */
export type ExportFormat = 'txt' | 'md' | 'html'

// ==================== 后端 DTO 对齐 ====================

/** 创建书籍参数（对齐 Rust CreateBookParams） */
export interface CreateBookParams {
  title: string
  author: string
  description: string
  dailyTarget: number
  tags: string[]
}

/** 更新书籍参数（对齐 Rust UpdateBookParams，仅允许更新这些字段） */
export interface UpdateBookParams {
  title?: string
  author?: string
  description?: string
  coverImage?: string
  outline?: string
  dailyTarget?: number
  tags?: string[]
}

// ==================== 英语生词本（艾宾浩斯 / SM-2）====================

/** 单条释义 {pos: 词性, def: 释义}（对齐 Rust VocabMeaning） */
export interface VocabMeaning {
  pos: string
  def: string
}

/** 词根词缀分析项（kind: prefix / root / suffix） */
export interface VocabMorphItem {
  kind: 'prefix' | 'root' | 'suffix' | string
  /** 词缀片段，如 un- / -able / -ion */
  part: string
  /** 中文含义说明 */
  meaning: string
}

/** 常用词组短语 {phrase: 英文词组, meaning: 中文含义} */
export interface VocabPhrase {
  phrase: string
  meaning: string
}

/** 词性例句 {pos: 词性, sentence: 英文例句, translation: 中文译文} */
export interface VocabSentence {
  pos: string
  sentence: string
  translation: string
}

/** 生词学习知识集合（DeepSeek AI 翻译生成，对齐 Rust VocabKnowledge） */
export interface VocabKnowledge {
  /** 词根词缀（前缀 prefix / 词根 root / 后缀 suffix） */
  morphology: VocabMorphItem[]
  /** 近义词（条目可含中文小注，如 "happy（高兴的）"） */
  synonyms: string[]
  /** 反义词 */
  antonyms: string[]
  /** 常用词组短语 */
  phrases: VocabPhrase[]
  /** 动词变形（仅动词词条），如 "第三人称单数: works" */
  verbForms: string[]
  /** 按词性区分的例句 */
  examples: VocabSentence[]
}

/** 生词状态 */
export type VocabStatus = 'learning' | 'mastered' | 'suspended'

/** 复习自评档位：0 忘记 / 1 模糊 / 2 记得 / 3 轻松 */
export type VocabRating = 0 | 1 | 2 | 3

/** 生词（对齐 Rust VocabWord） */
export interface VocabWord {
  id: string
  word: string
  phonetic: string
  meanings: VocabMeaning[]
  example: string
  /** 例句中文翻译 */
  exampleZh: string
  /** SM-2 连续答对次数 */
  repetition: number
  /** 当前复习间隔（天） */
  intervalDays: number
  /** SM-2 难度系数 EF（1.3 ~ 2.5+） */
  easeFactor: number
  status: VocabStatus
  /** 下次复习日期 YYYY-MM-DD */
  nextReviewAt: string | null
  lastReviewAt: string | null
  reviewCount: number
  correctCount: number
  source: string
  createdAt: string
  updatedAt: string
  /** DeepSeek 翻译附带的学习知识（词根词缀/近反义词/词组/动词变形/词性例句），无则为 null */
  knowledge: VocabKnowledge | null
}

/** 复习记录（对齐 Rust VocabReviewLog） */
export interface VocabReviewLog {
  id: string
  wordId: string
  reviewDate: string
  rating: VocabRating
  repetition: number
  intervalDays: number
  easeFactor: number
  reviewedAt: string
}

/** 每日复习计数（折线图） */
export interface StatsDay {
  date: string
  count: number
}

/** 生词本统计（对齐 Rust VocabStats） */
export interface VocabStats {
  total: number
  learning: number
  mastered: number
  suspended: number
  dueToday: number
  reviewedToday: number
  newThisWeek: number
  reviewHistory: StatsDay[]
}

/** 收录生词参数 */
export interface AddVocabWordArgs {
  word: string
  phonetic?: string
  meanings?: VocabMeaning[]
  example?: string
  /** 例句中文翻译 */
  exampleZh?: string
  /** DeepSeek 翻译附带的学习知识 */
  knowledge?: VocabKnowledge | null
  source?: string
}

/** 编辑生词参数 */
export interface UpdateVocabWordArgs {
  id: string
  phonetic?: string
  meanings?: VocabMeaning[]
  example?: string
  /** 例句中文翻译 */
  exampleZh?: string
  /** DeepSeek 翻译附带的学习知识；缺省清空 */
  knowledge?: VocabKnowledge | null
}

/** 离线词典词条（ECDICT stardict） */
export interface DictHit {
  word: string
  phonetic: string
  translation: string
  definition: string
  exchange: string
}

/** 离线词典状态 */
export interface DictStatus {
  installed: boolean
  wordCount: number
  dbPath: string
}

/** 词典查询结果 */
export interface DictLookupResult {
  hit: DictHit | null
  suggestions: DictHit[]
}

/** AI 兜底释义结果（DeepSeek 生成） */
export interface AiWordExplain {
  phonetic: string
  meanings: VocabMeaning[]
  example: string
  /** 例句中文翻译 */
  exampleZh: string
  /** AI 翻译附带的学习知识 */
  knowledge: VocabKnowledge
}

/** AI 释义请求参数（复用设置的 AI 配置） */
export interface ExplainWordArgs {
  word: string
  endpoint: string
  model: string
  apiKey?: string
  temperature?: number
  /** 释义语言：zh（默认）/ en */
  lang?: string
}

/** AI 单词形态检查结果类型 */
export type WordCheckKind = 'word' | 'inflected' | 'abbreviation' | 'acronym' | 'not_a_word'

/** AI 单词形态检查结果（DeepSeek flash 等轻量模型判定） */
export interface WordCheckResult {
  kind: WordCheckKind
  /** 完整形式（简写/缩写时给出，如 lab → laboratory；其余为空） */
  canonical: string
  /** 简短中文说明 */
  note: string
}

// ==================== TTS 朗读（豆包语音合成 seed-tts） ====================

/** 朗读配置（前端 localStorage 存储，调用时逐项传给后端） */
export interface TtsConfig {
  /** 豆包语音控制台 API Key（UUID，鉴权头 X-Api-Key） */
  apiKey: string
  /** 音色 ID（seed-tts 大模型音色，如 zh_female_vv_uranus_bigtts），空则用后端默认 */
  speaker: string
}

/** 朗读结果 */
export interface TtsSpeakResult {
  /** 音频文件绝对路径（前端 convertFileSrc 后播放） */
  audioPath: string
  /** 是否命中本地缓存 */
  cached: boolean
}

// ==================== 任务卡 · 个人项目管理 ====================

/** 项目状态 */
export type ProjectStatus = 'active' | 'completed' | 'archived'

/** 任务状态（三态） */
export type TaskStatus = 'todo' | 'doing' | 'done'

/** 任务优先级 */
export type TaskPriority = 'high' | 'medium' | 'low'

/** 项目 */
export interface TaskProject {
  id: string
  name: string
  description: string
  color: string
  icon: string
  status: ProjectStatus
  /** 计划开始日期 YYYY-MM-DD */
  planStartDate?: string
  /** 计划结束日期 YYYY-MM-DD */
  planEndDate?: string
  pinned: boolean
  sortOrder: number
  deletedAt?: string
  createdAt: string
  updatedAt: string
}

/** 项目实时统计 */
export interface ProjectStats {
  total: number
  todo: number
  doing: number
  done: number
  overdue: number
}

/** 项目 + 统计（列表/详情返回形态） */
export interface ProjectView extends TaskProject {
  stats: ProjectStats
}

/** 任务标签 */
export interface TaskTag {
  id: string
  name: string
  color: string
  status: 'enabled' | 'disabled'
  createdAt: string
  updatedAt: string
}

/** 任务卡 */
export interface TaskCard {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  /** 计划开始时间（本地时间字符串） */
  planStartTime?: string
  /** 截止时间（本地时间字符串） */
  dueTime?: string
  /** 计划今日 */
  plannedToday: boolean
  /** 完成时间（本地时间字符串，重新打开时清空） */
  completedTime?: string
  /** 个人备注 */
  note: string
  /** 下次提醒时间（未启用提醒为空） */
  remindAt?: string
  /** 提醒类型：due_before / due_day / overdue / daily（空=未启用） */
  remindType: string
  sortOrder: number
  deletedAt?: string
  createdAt: string
  updatedAt: string
  /** 聚合标签 */
  tags: TaskTag[]
}

/** 今日任务概览 */
export interface TodayOverview {
  /** 今日应完成（未完成欠账 + 今日已完成） */
  dueToday: number
  /** 今日已完成 */
  doneToday: number
  /** 逾期未完成任务数 */
  overdue: number
  /** 角标（今日到期 + 计划今日 + 逾期 的未完成数） */
  badge: number
}

/** 日程迁移结果 */
export interface MigrateResult {
  migrated: number
  completed: number
  projectId: string
  already: boolean
}

/** 回收站任务条目（含所属项目名） */
export interface DeletedTaskItem extends TaskCard {
  projectName?: string
}

/** 创建项目参数 */
export interface CreateProjectArgs {
  name: string
  description?: string
  color?: string
  icon?: string
  status?: ProjectStatus
  planStartDate?: string
  planEndDate?: string
  pinned?: boolean
}

/** 更新项目参数（部分更新；可空字段传空串清除） */
export interface UpdateProjectArgs {
  name?: string
  description?: string
  color?: string
  icon?: string
  status?: ProjectStatus
  planStartDate?: string
  planEndDate?: string
  pinned?: boolean
}

/** 创建任务参数 */
export interface CreateTaskArgs {
  projectId: string
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  planStartTime?: string
  dueTime?: string
  plannedToday?: boolean
  note?: string
  /** 标签 id 列表 */
  tagIds?: string[]
}

/** 更新任务参数（部分更新） */
export interface UpdateTaskArgs {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  planStartTime?: string
  dueTime?: string
  plannedToday?: boolean
  note?: string
  /** 传数组则整体替换标签 */
  tagIds?: string[]
  /** 任务级提醒类型：''=跟随全局 / 'off'=不提醒 / 'due_before'|'due_day'|'overdue'=指定类别 / 'custom'=自定义（配合 remindAt） */
  remindType?: string
  /** 自定义提醒时间（YYYY-MM-DDTHH:MM），仅 remindType='custom' 时生效 */
  remindAt?: string
}

/** 更新标签参数 */
export interface UpdateTagArgs {
  name?: string
  color?: string
  status?: 'enabled' | 'disabled'
}

/** 提醒偏好（任务卡设置） */
export interface ReminderPrefs {
  /** 全局开关 */
  enabled: boolean
  /** 截止前一天 09:00 提醒 */
  dueBeforeDay: boolean
  /** 截止当天 09:00 提醒 */
  dueDay: boolean
  /** 逾期后每日 09:00 提醒 */
  overdueDaily: boolean
  /** 每日待办提醒（默认关，9.11.1-4） */
  dailyEnabled: boolean
  /** 每日待办提醒时间 HH:MM（默认 09:00） */
  dailyTime: string
}

/** 站内提醒记录（铃铛中心，后端任务卡提醒写入 taskcard:remind_log） */
export interface RemindLogEntry {
  id: string
  kind: 'before' | 'due' | 'overdue' | 'custom' | 'daily' | string
  title: string
  taskId?: string | null
  projectId?: string | null
  /** 本地时间 YYYY-MM-DDTHH:MM:SS */
  time: string
}

