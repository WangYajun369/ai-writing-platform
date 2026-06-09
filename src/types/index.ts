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

/** AI 对话配置 */
export interface AiChatConfig {
  provider: 'bigmodel' | 'deepseek'
  endpoint: string
  model: string
  temperature: number
  maxTokens: number
  /** 智谱 API Key */
  bigmodelApiKey?: string
  /** DeepSeek API Key */
  deepseekApiKey?: string
  /** DeepSeek 思考模式开关 */
  thinkingEnabled: boolean
}

/** 获取当前选中服务商的 API Key */
export function getChatApiKey(config: AiChatConfig): string | undefined {
  return config.provider === 'bigmodel' ? config.bigmodelApiKey : config.deepseekApiKey
}

/** RAG / Embedding 检索服务商（目前仅支持智谱，DeepSeek 不提供 Embeddings API） */
export type RagProvider = 'bigmodel'

/** RAG / Embedding 检索配置 */
export interface RagConfig {
  enabled: boolean
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

/** AI 对话消息 */
export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 深度思考过程（智谱/DeepSeek 推理模型） */
  thinking: string
  /** 当前生成阶段 */
  phase: 'thinking' | 'answering' | 'done' | 'summarizing'
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
}

/** Diff 对比视图模式 */
export type DiffViewMode = 'side-by-side' | 'inline'

/** 导入导出格式（当前仅支持 txt/md/html） */
export type ExportFormat = 'txt' | 'md' | 'html'
