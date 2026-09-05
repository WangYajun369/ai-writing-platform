/**
 * Agent Skills 类型定义
 *
 * 与 Rust/Python 侧保持一致的接口定义。
 */

/** 技能类型枚举 */
export type SkillType = 'writing' | 'analysis' | 'research' | 'polish'

/**
 * Agent 运行状态（供 Agent 面板展示）
 *
 * Agent 已迁移为 Rust 原生实现（无外部进程、始终就绪），实际值恒为
 * 'running'；保留联合类型以兼容面板语义，未来如引入引擎状态可扩展。
 */
export type AgentStatus = 'stopped' | 'starting' | 'running' | 'crashed'

/** SSE 流事件 */
export interface AgentStreamEvent {
  event: 'chunk' | 'done' | 'error' | 'cancelled'
  data: string
  requestId: string
}

/** 对话历史项 */
export interface ChatHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

/** Agent 消息（前端展示用） */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  skill?: SkillType
  timestamp: number
  isStreaming?: boolean
  error?: string
}

/** Skill 元数据 */
export interface SkillMeta {
  type: SkillType
  label: string
  description: string
  icon: string
  color: string
}

/** 所有可用技能 */
export const SKILLS: SkillMeta[] = [
  {
    type: 'writing',
    label: '写作辅助',
    description: '大纲生成、情节建议、角色对话模拟',
    icon: 'pen-tool',
    color: '#6366f1',
  },
  {
    type: 'analysis',
    label: '内容分析',
    description: '文风分析、剧情连贯性、伏笔追踪',
    icon: 'search',
    color: '#f59e0b',
  },
  {
    type: 'research',
    label: '研究辅助',
    description: '背景资料检索、世界观一致性校验',
    icon: 'book-open',
    color: '#10b981',
  },
  {
    type: 'polish',
    label: '润色优化',
    description: '语法纠错、文笔润色、风格统一',
    icon: 'sparkles',
    color: '#ec4899',
  },
]

// ─── 记忆管理类型 ───

/** 记忆类型 */
export type MemoryType = 'preference' | 'decision' | 'lesson'

/** 记忆类型中文标签 */
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  preference: '用户偏好',
  decision: '历史决策',
  lesson: '经验教训',
}

/** 记忆条目标题颜色 */
export const MEMORY_TYPE_COLORS: Record<MemoryType, string> = {
  preference: '#6366f1',
  decision: '#f59e0b',
  lesson: '#10b981',
}

/** 单条记忆信息（来自后端） */
export interface MemoryInfo {
  id: number
  book_id: string
  skill_type: string
  memory_type: MemoryType
  content: string
  keywords: string
  relevance_score: number
  created_at: string
  updated_at: string
  /** 最近一次被检索命中并注入的时间（可为空：从未命中） */
  last_hit_at?: string | null
}

/** 记忆列表响应 */
export interface MemoryListResponse {
  memories: MemoryInfo[]
  total: number
}
