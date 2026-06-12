/**
 * AiSidePanel 共享常量
 */
import type { SkillType, AgentStatus } from '@/components/agent/types'
import {
  CircleIcon,
  CircleCheckIcon,
  CircleAlertIcon,
  Loader2Icon,
} from 'lucide-react'

/** Agent 连接状态配置 */
export const STATUS_CONFIG = {
  idle:     { icon: CircleIcon,       color: 'text-muted-foreground/50',             label: '未检测' },
  testing:  { icon: Loader2Icon,      color: 'text-blue-500 animate-spin',           label: '检测中…' },
  connected:{ icon: CircleCheckIcon,  color: 'text-green-500',                       label: '已连接' },
  error:    { icon: CircleAlertIcon,  color: 'text-red-500',                         label: '连接失败' },
} as const

export type StatusKey = keyof typeof STATUS_CONFIG

/** 将 Rust Agent 状态映射到显示状态 key */
export function mapAgentStatus(status: AgentStatus): StatusKey {
  switch (status) {
    case 'running':  return 'connected'
    case 'starting': return 'testing'
    case 'crashed':  return 'error'
    default:         return 'idle'
  }
}

/** 获取 Agent 状态对应的显示文本 */
export function getStatusLabel(status: AgentStatus): string {
  switch (status) {
    case 'running':  return 'Agent 已连接'
    case 'starting': return 'Agent 启动中…'
    case 'crashed':  return 'Agent 异常'
    default:         return 'Agent 未启动'
  }
}

/**
 * Agent 快捷操作（各技能通用）
 *
 * 在 AiSidePanel 和 AgentPanel 中共享，避免重复定义。
 */
export function getAgentQuickActions(skill: SkillType): string[] {
  switch (skill) {
    case 'writing':
      return [
        '为当前章节生成下一章的详细大纲',
        '分析主角的性格，设计一个合理的冲突情节',
        '基于已有世界观，提供3个情节发展方向',
      ]
    case 'analysis':
      return [
        '分析最近5章的叙事节奏',
        '检查当前章节与前面章节的伏笔关联',
        '评估主要角色的性格一致性',
      ]
    case 'research':
      return [
        '检索当前书籍的所有世界观设定',
        '检查新章节内容是否与已有设定冲突',
        '根据已有设定，扩展魔法体系的细节',
      ]
    case 'polish':
      return [
        '润色当前章节，保持原文风格',
        '检查并修正语法和标点错误',
        '优化当前章节的句式结构，增强可读性',
      ]
  }
}
