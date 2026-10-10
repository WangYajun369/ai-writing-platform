/**
 * Agent Skills 类型定义
 *
 * 与 Rust/Python 侧保持一致的接口定义。
 */

import type { AgentMemoryInfo, AgentMemoryListResponse, AgentMemoryType } from '@/lib/tauri-bridge'

/**
 * 技能（能力画像）id
 *
 * 阶段五 L3 自动发现后**不再是字面量联合类型**：画像由后端 `list_agent_profiles`
 * 下发，前端无法在编译期穷举。保留为 `string` 的别名只为标注语义。
 *
 * ⚠️ 取值合法性由后端兜底（未知 id 回退 writing），前端不做校验。
 */
export type SkillType = string

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

// ─── 记忆管理类型 ───
// 后端契约类型已统一收敛至 tauri-bridge（单一 IPC 契约源），此处 re-export 保持旧引用兼容

/** 记忆类型 */
export type MemoryType = AgentMemoryType

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
export type MemoryInfo = AgentMemoryInfo

/** 记忆列表响应 */
export type MemoryListResponse = AgentMemoryListResponse
