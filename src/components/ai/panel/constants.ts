/**
 * AiSidePanel 共享常量
 */
import type { SkillType } from '@/components/agent/types'
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

/**
 * Agent 快捷操作（各技能通用）
 *
 * 在 AiSidePanel 和 AgentPanel 中共享，避免重复定义。
 */
/**
 * 各技能的快捷操作文案（渲染在空会话占位区，点击即填入输入框触发）
 *
 * 数据驱动而非穷举 switch：新增技能漏改此处只会回退空数组，不会编译失败。
 * 阶段五落地 L3 自动发现后，本表将由后端 IPC 下发取代。
 */
const QUICK_ACTIONS: Record<string, string[]> = {
  writing: [
    '为当前章节生成下一章的详细大纲',
    '分析主角的性格，设计一个合理的冲突情节',
    '基于已有世界观，提供3个情节发展方向',
  ],
  analysis: [
    '分析最近5章的叙事节奏',
    '检查当前章节与前面章节的伏笔关联',
    '评估主要角色的性格一致性',
  ],
  research: [
    '检索当前书籍的所有世界观设定',
    '检查新章节内容是否与已有设定冲突',
    '根据已有设定，扩展魔法体系的细节',
  ],
  polish: [
    '润色当前章节，保持原文风格',
    '检查并修正语法和标点错误',
    '优化当前章节的句式结构，增强可读性',
  ],
}

export function getAgentQuickActions(skill: SkillType): string[] {
  return QUICK_ACTIONS[skill] ?? []
}
