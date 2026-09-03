/** 任务卡状态/优先级展示元数据（无 JSX，纯常量） */
import type { TaskPriority, TaskStatus } from '@/types'

export const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'done']

export const STATUS_META: Record<TaskStatus, { label: string; dot: string; badge: string }> = {
  todo: {
    label: '待办',
    dot: 'bg-zinc-400',
    badge: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/25',
  },
  doing: {
    label: '进行中',
    dot: 'bg-sky-400',
    badge: 'bg-sky-500/15 text-sky-300 border-sky-500/25',
  },
  done: {
    label: '已完成',
    dot: 'bg-emerald-400',
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  },
}

export const PRIORITY_META: Record<TaskPriority, { label: string; badge: string }> = {
  high: { label: '高', badge: 'bg-red-500/15 text-red-300 border-red-500/25' },
  medium: { label: '中', badge: 'bg-amber-500/15 text-amber-300 border-amber-500/25' },
  low: { label: '低', badge: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20' },
}
