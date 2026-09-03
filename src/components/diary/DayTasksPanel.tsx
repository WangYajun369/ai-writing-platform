/**
 * DayTasksPanel — 首页右侧「当日任务」面板
 *
 * 方案 A：以任务卡数据取代旧「个人日程」的当日展示。
 * 展示选中日期的任务卡任务（当日截止 + 若为今天则并入「计划今日」），
 * 支持快速勾选完成 / 重新打开；编辑、删除等完整操作引导至任务卡独立窗口。
 *
 * 数据由父级 DiaryPanel 注入（已按选中日期过滤），本组件只做展示与勾选交互。
 */
import { useMemo } from 'react'
import { CheckIcon, ClipboardListIcon, ExternalLinkIcon, Loader2Icon, RepeatIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dayOf, fmtDateTime, isOverdue, localToday } from '@/lib/taskCardsTime'
import { describeRule } from '@/lib/recurrence'
import type { TaskCard, TaskProject } from '@/types'

interface Props {
  /** 当前选中日期 YYYY-MM-DD */
  date: string
  /** 该日期下的任务（父级已过滤；为今天时含「计划今日」未完成） */
  tasks: TaskCard[]
  /** 项目 id → 项目（渲染归属） */
  projectMap: Map<string, TaskProject>
  /** 数据是否仍在加载 */
  loading?: boolean
  /** 勾选完成 / 重新打开后通知父级刷新 */
  onToggleDone: (task: TaskCard) => void
  /** 打开任务卡独立窗口（新建 / 编辑等完整操作） */
  onOpenTasks: () => void
}

/** 截止时间配色（对齐首页浅色 token） */
function dueCls(dueTime?: string, done = false): { text: string; cls: string } {
  if (!dueTime) return { text: '无截止', cls: 'text-muted-foreground/60' }
  if (done) return { text: fmtDateTime(dueTime), cls: 'text-muted-foreground/50' }
  if (isOverdue(dueTime, done ? 'done' : 'todo')) return { text: `已逾期 · ${fmtDateTime(dueTime)}`, cls: 'text-destructive' }
  if (dayOf(dueTime) === localToday()) return { text: fmtDateTime(dueTime), cls: 'text-primary' }
  return { text: fmtDateTime(dueTime), cls: 'text-muted-foreground' }
}

/** 优先级排序权重（高 > 中 > 低） */
const PRIORITY_W: Record<string, number> = { high: 0, medium: 1, low: 2 }

export default function DayTasksPanel({ date, tasks, projectMap, loading, onToggleDone, onOpenTasks }: Props) {
  const doneCount = useMemo(() => tasks.filter((t) => t.status === 'done').length, [tasks])
  const isToday = date === localToday()

  // 排序：未完成在前（逾期 > 当日截止 > 其余），已完成沉底；同级按优先级与创建时间
  const sorted = useMemo(() => {
    const diff = (t: TaskCard) => (isOverdue(t.dueTime, t.status) ? 0 : dayOf(t.dueTime) === localToday() ? 1 : 2)
    return [...tasks].sort((a, b) => {
      const aDone = a.status === 'done' ? 1 : 0
      const bDone = b.status === 'done' ? 1 : 0
      if (aDone !== bDone) return aDone - bDone
      if (!aDone) {
        const d = diff(a) - diff(b)
        if (d !== 0) return d
      }
      const p = (PRIORITY_W[a.priority] ?? 1) - (PRIORITY_W[b.priority] ?? 1)
      if (p !== 0) return p
      return a.createdAt.localeCompare(b.createdAt)
    })
  }, [tasks])

  return (
    <section className="border-t">
      {/* ─── 标题栏 ─── */}
      <div className="px-4 py-2.5 flex items-center gap-2">
        <ClipboardListIcon className="w-3.5 h-3.5 text-rose-500" />
        <h3 className="text-xs font-semibold text-muted-foreground">当日任务</h3>
        <span
          className={cn(
            'text-[11px] px-1.5 py-px rounded tabular-nums',
            isToday ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium' : 'bg-muted text-muted-foreground',
          )}
        >
          {isToday ? '今天' : date.slice(5).replace('-', '/')}
        </span>
        <div className="flex-1" />
        {loading ? (
          <Loader2Icon className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
        ) : (
          tasks.length > 0 && (
            <span className="text-[11px] text-muted-foreground/70 tabular-nums">
              {doneCount}/{tasks.length} 完成
            </span>
          )
        )}
      </div>

      <div className="px-4 pb-3">
        {loading ? (
          <p className="text-xs text-muted-foreground/60 py-3 text-center">加载中…</p>
        ) : sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed p-4 text-center">
            <p className="text-xs text-muted-foreground/70">这一天没有安排任务</p>
            <button
              onClick={onOpenTasks}
              className="mt-2.5 inline-flex items-center gap-1.5 text-xs text-rose-500 hover:bg-rose-500/10 px-3 py-1.5 rounded-lg transition-colors"
            >
              <ExternalLinkIcon className="w-3.5 h-3.5" />
              去任务卡新建任务
            </button>
          </div>
        ) : (
          <ul className="space-y-1">
            {sorted.map((task) => {
              const project = projectMap.get(task.projectId)
              const done = task.status === 'done'
              const due = dueCls(task.dueTime, done)
              const overdue = !done && isOverdue(task.dueTime, task.status)
              const isPlanned = !done && task.plannedToday && isToday
              const recurDesc = task.recurrence ? describeRule(task.recurrence) : ''
              return (
                <li key={task.id} className="group flex items-start gap-2 py-1.5 px-1.5 -mx-1.5 rounded-lg transition-colors hover:bg-muted/60">
                  <button
                    onClick={() => onToggleDone(task)}
                    title={done ? '重新打开（标记未完成）' : '标记完成'}
                    className={cn(
                      'shrink-0 mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center transition-colors',
                      done
                        ? 'bg-emerald-500 border-emerald-500 text-white'
                        : 'border-muted-foreground/30 hover:border-emerald-500 hover:text-emerald-500',
                    )}
                  >
                    {done && <CheckIcon className="w-2.5 h-2.5" strokeWidth={3} />}
                  </button>

                  <button
                    onClick={onOpenTasks}
                    title={done ? task.title : `${task.title}（在任务卡窗口中管理）`}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span
                        className={cn(
                          'text-xs break-all line-clamp-2',
                          done ? 'text-muted-foreground line-through' : overdue ? 'text-destructive font-medium' : 'text-foreground',
                        )}
                      >
                        {task.title}
                      </span>
                      {isPlanned && (
                        <span className="inline-flex items-center px-1 py-px rounded text-[9.5px] font-medium bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                          计划今日
                        </span>
                      )}
                      {task.recurrence && (
                        <span
                          title={recurDesc ? `重复任务 · ${recurDesc}` : '重复任务'}
                          className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[9.5px] font-medium bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20"
                        >
                          <RepeatIcon className="h-2.5 w-2.5" />
                          重复
                        </span>
                      )}
                    </div>
                    {(project || task.dueTime) && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {project && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/70">
                            <span className="leading-none">{project.icon || '📁'}</span>
                            <span className="max-w-28 truncate">{project.name}</span>
                          </span>
                        )}
                        {task.dueTime && (
                          <span className={cn('text-[10px] tabular-nums', due.cls)}>{due.text}</span>
                        )}
                      </div>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {!loading && sorted.length > 0 && (
          <button
            onClick={onOpenTasks}
            className="mt-1.5 w-full flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/70 hover:text-rose-500 py-1.5 rounded-lg hover:bg-muted/60 transition-colors"
          >
            <ExternalLinkIcon className="w-3 h-3" />
            在任务卡窗口新建 / 管理任务
          </button>
        )}
      </div>
    </section>
  )
}
