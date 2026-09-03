/**
 * 任务卡片（看板 / 今日列表共用）
 * 左侧完成勾选，中部标题+标签+时间提示，点击卡片打开详情。
 */
import { ArrowRightIcon, CheckIcon, Clock3Icon, FlagIcon, GitBranchIcon, LayersIcon, MessageSquareIcon, NotebookPenIcon, RepeatIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskCard, TaskProject } from '@/types'
import { fmtDateTime, isOverdue } from '@/lib/taskCardsTime'
import { PRIORITY_META } from '@/lib/taskCardsMeta'
import { describeRule } from '@/lib/recurrence'
import { useTaskCardsStore } from '@/stores/taskCardsStore'

export default function TaskCardView({
  task,
  project,
  onOpen,
  onToggleDone,
  draggable = false,
  onDragStart,
  onPostpone,
}: {
  task: TaskCard
  project?: TaskProject
  onOpen: () => void
  onToggleDone: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  /** 顺延到明天（今日页操作，9.8.2） */
  onPostpone?: () => void
}) {
  const done = task.status === 'done'
  const overdue = isOverdue(task.dueTime, task.status)
  const priority = PRIORITY_META[task.priority]
  const accent = project?.color || '#e11d48'
  // 重复规则文案（如「每周 一、三」；无规则时为空串）
  const recurDesc = task.recurrence ? describeRule(task.recurrence) : ''

  // 层级徽标（同项目内自查，父任务标题 / 直接子任务数）
  const siblings = useTaskCardsStore((s) => s.tasksByProject[task.projectId]) ?? []
  const parent = task.parentId ? siblings.find((t) => t.id === task.parentId) : undefined
  const childCount = siblings.filter((t) => t.parentId === task.id).length

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cn(
        'group rounded-xl border bg-white/[0.035] transition hover:bg-white/[0.07] cursor-pointer',
        done ? 'border-white/6 opacity-70' : 'border-white/10',
        draggable && 'active:cursor-grabbing',
      )}
    >
      <div className="flex items-start gap-2.5 p-2.5">
        {/* 完成勾选 */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleDone()
          }}
          title={done ? '重新打开' : '标记完成'}
          className={cn(
            'mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition',
            done
              ? 'border-emerald-400 bg-emerald-400 text-emerald-950'
              : 'border-zinc-500/60 hover:border-rose-400 hover:bg-rose-500/10 group-hover:border-zinc-400',
          )}
        >
          {done && <CheckIcon className="h-3 w-3" strokeWidth={3} />}
        </button>

        <div className="flex-1 min-w-0">
          {/* 标题 + 顺延 */}
          <div className="flex items-start gap-1">
            <div
              className={cn(
                'flex-1 min-w-0 text-[13px] leading-snug wrap-break-word',
                done ? 'text-zinc-500 line-through' : 'text-zinc-200',
              )}
            >
              {task.title}
            </div>
            {onPostpone && !done && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onPostpone()
                }}
                title="顺延到明天（改截止时间为明天）"
                className="mt-0.5 hidden shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-[10.5px] text-zinc-500 transition hover:bg-amber-500/15 hover:text-amber-300 group-hover:flex"
              >
                <ArrowRightIcon className="h-3 w-3" />
                明天
              </button>
            )}
          </div>

          {/* 元信息行 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {parent && (
              <span
                title={`父任务：${parent.title}`}
                className="inline-flex max-w-[11rem] items-center gap-1 truncate rounded border border-cyan-500/25 bg-cyan-500/12 px-1.5 py-0.5 text-[10.5px] text-cyan-300/90"
              >
                <GitBranchIcon className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{parent.title}</span>
              </span>
            )}
            {childCount > 0 && (
              <span
                title={`包含 ${childCount} 个子任务`}
                className="inline-flex items-center gap-1 rounded border border-violet-500/25 bg-violet-500/12 px-1.5 py-0.5 text-[10.5px] text-violet-300/90"
              >
                <LayersIcon className="h-2.5 w-2.5" />
                {childCount}
              </span>
            )}
            {project && (
              <span className="inline-flex items-center gap-1 rounded border border-white/8 bg-white/4 px-1.5 py-0.5 text-[10.5px] text-zinc-400">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
                {project.name}
              </span>
            )}
            {task.priority !== 'medium' && (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10.5px]',
                  priority.badge,
                )}
              >
                <FlagIcon className="h-2.5 w-2.5" />
                {priority.label}
              </span>
            )}
            {task.status === 'doing' && (
              <span className="inline-flex items-center gap-1 rounded border border-sky-500/25 bg-sky-500/15 px-1.5 py-0.5 text-[10.5px] text-sky-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
                进行中
              </span>
            )}
            {task.recurrence ? (
              <span
                title={recurDesc ? `重复任务 · ${recurDesc}` : '重复任务'}
                className="inline-flex items-center gap-1 rounded border border-sky-500/25 bg-sky-500/12 px-1.5 py-0.5 text-[10.5px] text-sky-300/90"
              >
                <RepeatIcon className="h-2.5 w-2.5" />
                重复
              </span>
            ) : null}
            {task.dueTime && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px]',
                  done
                    ? 'border-white/8 bg-white/4 text-zinc-500'
                    : overdue
                      ? 'border-red-500/30 bg-red-500/15 text-red-300 font-medium'
                      : 'border-white/8 bg-white/4 text-zinc-400',
                )}
              >
                <Clock3Icon className="h-2.5 w-2.5" />
                {fmtDateTime(task.dueTime)}
                {overdue && ' · 逾期'}
              </span>
            )}
            {task.tags.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className="rounded border px-1.5 py-0.5 text-[10.5px]"
                style={{
                  color: t.color,
                  borderColor: t.color + '44',
                  background: t.color + '14',
                }}
              >
                {t.name}
              </span>
            ))}
            {task.tags.length > 3 && (
              <span className="rounded border border-white/8 bg-white/4 px-1.5 py-0.5 text-[10.5px] text-zinc-500">
                +{task.tags.length - 3}
              </span>
            )}
            {task.note ? (
              <MessageSquareIcon className="h-3 w-3 text-zinc-500" />
            ) : null}
            {done && task.completionSummary && !/^\s*$/.test(task.completionSummary.replace(/<[^>]*>/g, '')) && (
              <span
                title="点击查看本次完成总结（在详情中展示）"
                className="inline-flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/8 px-1.5 py-0.5 text-[10.5px] text-emerald-300/80"
              >
                <NotebookPenIcon className="h-2.5 w-2.5" />
                总结
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
