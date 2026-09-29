/**
 * 任务卡筛选 / 排序 / 动态展示 公共工具（三视图 + 动态组件共用）
 *
 * 收敛自 AllTasksView / ProjectDetailView / TodayView / ActivityTimeline /
 * ProjectReportModal 中各自重复实现的同名逻辑，统一语义：
 * - week = 今天起至本周日，**不含已逾期**（逾期由 overdue 独立筛选，二者互斥）
 * - 已完成与无截止任务只匹配 all
 */
import type { TaskCard, TaskPriority } from '@/types'

/** 优先级排序权重（high 靠前） */
export const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

/** 无截止时间任务的排序哨兵（排最后） */
export const NO_DUE_SENTINEL = '9999-99-99'

/** 两位补零 */
export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地今天 'YYYY-MM-DD' */
export function todayStr(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** 本地本周日（一周结束）'YYYY-MM-DD' */
export function weekEndStr(): string {
  const now = new Date()
  const end = new Date(now)
  end.setDate(now.getDate() + (6 - now.getDay()))
  return `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`
}

/** 截止范围（month 仅全部任务视图使用） */
export type DueRange = 'all' | 'overdue' | 'today' | 'week' | 'month'

/** 截止范围匹配（统一语义，见文件头注释） */
export function matchDue(task: TaskCard, range: DueRange): boolean {
  if (!task.dueTime) return range === 'all'
  if (task.status === 'done') return range === 'all'
  const d = task.dueTime.slice(0, 10)
  const today = todayStr()
  switch (range) {
    case 'today':
      return d === today
    case 'overdue':
      return d < today
    case 'week':
      return d >= today && d <= weekEndStr()
    case 'month':
      return d.slice(0, 7) === today.slice(0, 7)
    default:
      return true
  }
}

/** 动作 → 动态/时间线圆点颜色（ActivityTimeline 超集，ProjectReportModal 共用） */
export const ACTIVITY_DOT: Record<string, string> = {
  'task.created': 'bg-sky-400',
  'task.completed': 'bg-emerald-400',
  'task.reopened': 'bg-amber-400',
  'task.updated': 'bg-zinc-400',
  'task.deleted': 'bg-rose-400',
  'task.restored': 'bg-teal-400',
  'task.moved': 'bg-indigo-400',
  'task.archived': 'bg-zinc-500',
  'subtask.added': 'bg-lime-400',
  'subtask.done': 'bg-emerald-400',
  'subtask.redone': 'bg-zinc-400',
  'subtask.updated': 'bg-zinc-400',
  'subtask.removed': 'bg-rose-400',
  'attachment.added': 'bg-violet-400',
  'attachment.removed': 'bg-rose-400',
}
