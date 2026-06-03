// 核心类型定义 —— 幻境水墨 MirageInk

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
}

/** 卷信息 */
export interface Volume {
  id: string
  bookId: string
  title: string
  sortOrder: number
  createdAt: string
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

/** AI 配置 */
export interface AiConfig {
  provider: 'ollama' | 'openai' | 'custom'
  endpoint: string
  model: string
  embeddingModel: string
  temperature: number
  maxTokens: number
  apiKey?: string
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

/** Diff 对比视图模式 */
export type DiffViewMode = 'side-by-side' | 'inline'

/** 导入导出格式 */
export type ExportFormat = 'txt' | 'md' | 'html' | 'epub' | 'pdf'
