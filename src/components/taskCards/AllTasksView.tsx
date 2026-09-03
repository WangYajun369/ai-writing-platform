/**
 * 全部任务 — 全局搜索 / 筛选 / 排序的扁平列表（9.7.2 / 9.9）
 *
 * 数据全部来自 useTaskCardsStore（已按项目全量加载），本地过滤即时生效：
 * - 关键词匹配 标题/备注/描述/标签名/项目名，命中词以 <mark> 高亮（含描述命中片段）；
 * - 筛选：状态（单选）· 标签（多选任一）· 优先级 · 截止范围（已逾期/今天/本周/本月）；
 * - 排序策略：截止时间（默认）/ 优先级 / 创建时间 / 更新时间。
 */
import { useMemo, useState } from 'react'
import {
  CheckIcon,
  Clock3Icon,
  FlagIcon,
  ListFilterIcon,
  Loader2Icon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import type { TaskCard, TaskPriority } from '@/types'
import { STATUS_META } from '@/lib/taskCardsMeta'
import { fmtDueText } from '@/lib/taskCardsTime'
import TaskModal from './TaskModal'

type StatusFilter = 'all' | TaskCard['status']
type PriorityFilter = 'all' | TaskPriority
type DueRange = 'all' | 'overdue' | 'today' | 'week' | 'month'
type SortKey = 'due' | 'priority' | 'created' | 'updated'

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'todo', label: '待办' },
  { key: 'doing', label: '进行中' },
  { key: 'done', label: '已完成' },
]

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

/** 截止范围匹配（已完成任务不参与逾期/截止筛选） */
function matchDue(task: TaskCard, range: DueRange): boolean {
  if (!task.dueTime) return range === 'all'
  if (task.status === 'done') return range === 'all'
  const d = task.dueTime.slice(0, 10)
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  switch (range) {
    case 'today':
      return d === todayStr
    case 'overdue':
      return d < todayStr
    case 'week': {
      const end = new Date(now)
      end.setDate(now.getDate() + (6 - now.getDay()))
      const endStr = `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`
      return d >= todayStr && d <= endStr
    }
    case 'month':
      return d.slice(0, 7) === todayStr.slice(0, 7)
    default:
      return true
  }
}

function sortList(
  list: { task: TaskCard; projectName: string }[],
  key: SortKey,
): { task: TaskCard; projectName: string }[] {
  const arr = [...list]
  switch (key) {
    case 'priority':
      arr.sort(
        (a, b) =>
          PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority] ||
          (a.task.dueTime ?? '9999-99-99').localeCompare(b.task.dueTime ?? '9999-99-99'),
      )
      break
    case 'created':
      arr.sort((a, b) => a.task.createdAt.localeCompare(b.task.createdAt))
      break
    case 'updated':
      arr.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt))
      break
    default:
      arr.sort((a, b) =>
        (a.task.dueTime ?? '9999-99-99').localeCompare(b.task.dueTime ?? '9999-99-99'),
      )
  }
  return arr
}

/** 命中词高亮 */
function mark(text: string, q: string): React.ReactNode {
  if (!q) return text
  const lower = text.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx === -1) return text
  const parts: React.ReactNode[] = []
  let i = 0
  while (i < text.length) {
    const hit = lower.indexOf(q, i)
    if (hit === -1) {
      parts.push(text.slice(i))
      break
    }
    if (hit > i) parts.push(text.slice(i, hit))
    parts.push(
      <mark key={hit} className="rounded bg-amber-400/25 px-0.5 text-amber-200">
        {text.slice(hit, hit + q.length)}
      </mark>,
    )
    i = hit + q.length
  }
  return <>{parts}</>
}

/** 命中描述时截取前后片段 */
function descSnippet(text: string, q: string): string {
  const lower = text.toLowerCase()
  const i = lower.indexOf(q)
  if (i === -1) return text.length > 60 ? text.slice(0, 60) + '…' : text
  const start = Math.max(0, i - 14)
  const end = Math.min(text.length, i + q.length + 30)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

export default function AllTasksView() {
  const projects = useTaskCardsStore((s) => s.projects)
  const tasksByProject = useTaskCardsStore((s) => s.tasksByProject)
  const tags = useTaskCardsStore((s) => s.tags)
  const setStatus = useTaskCardsStore((s) => s.setStatus)
  const loaded = useTaskCardsStore((s) => s.loaded)

  const [keyword, setKeyword] = useState('')
  const [status, setStatusFilter] = useState<StatusFilter>('all')
  const [selTags, setSelTags] = useState<Set<string>>(new Set())
  const [priority, setPriority] = useState<PriorityFilter>('all')
  const [dueRange, setDueRange] = useState<DueRange>('all')
  const [sortKey, setSortKey] = useState<SortKey>('due')
  const [openTask, setOpenTask] = useState<TaskCard | null>(null)

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const enabledTags = useMemo(() => tags.filter((t) => t.status === 'enabled'), [tags])

  const q = keyword.trim().toLowerCase()

  const results = useMemo(() => {
    const list: { task: TaskCard; projectName: string }[] = []
    for (const [pid, arr] of Object.entries(tasksByProject)) {
      const pn = projectMap.get(pid)?.name ?? '未分类'
      for (const task of arr) {
        if (status !== 'all' && task.status !== status) continue
        if (selTags.size > 0 && !task.tags.some((t) => selTags.has(t.id))) continue
        if (priority !== 'all' && task.priority !== priority) continue
        if (dueRange !== 'all' && !matchDue(task, dueRange)) continue
        if (q) {
          const tagNames = task.tags.map((t) => t.name).join(' ')
          const hay = `${task.title} ${task.note ?? ''} ${task.description ?? ''} ${tagNames} ${pn}`.toLowerCase()
          if (!hay.includes(q)) continue
        }
        list.push({ task, projectName: pn })
      }
    }
    return sortList(list, sortKey)
  }, [tasksByProject, projectMap, keyword, status, selTags, priority, dueRange, sortKey])

  function toggleTag(id: string) {
    const next = new Set(selTags)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelTags(next)
  }

  function clearAll() {
    setKeyword('')
    setStatusFilter('all')
    setSelTags(new Set())
    setPriority('all')
    setDueRange('all')
  }

  const activeFilter =
    keyword.trim() !== '' ||
    status !== 'all' ||
    selTags.size > 0 ||
    priority !== 'all' ||
    dueRange !== 'all'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：搜索 + 筛选 + 排序 */}
      <header className="shrink-0 border-b border-white/8 px-6 pt-5 pb-4 space-y-3">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-[15px] font-semibold flex items-center gap-2">
              <ListFilterIcon className="h-4.5 w-4.5 text-rose-400" />
              全部任务
            </h2>
            <p className="text-[10.5px] text-zinc-500">跨项目搜索（标题/备注/描述/标签/项目）与筛选，实时过滤</p>
          </div>
          <div className="flex-1" />
          {activeFilter && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11.5px] text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100"
            >
              <XIcon className="h-3.5 w-3.5" />
              清除筛选
            </button>
          )}
          <span className="text-[12px] tabular-nums text-zinc-500">{results.length} 项</span>
        </div>

        {/* 搜索框 */}
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2 transition focus-within:border-rose-400/50">
          <SearchIcon className="h-4 w-4 text-zinc-500" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索任务标题、备注、描述、标签或项目名…"
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-zinc-600"
          />
          {keyword && (
            <button onClick={() => setKeyword('')} className="text-zinc-500 hover:text-zinc-300">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* 状态 / 标签 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setStatusFilter(s.key)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11.5px] transition',
                status === s.key
                  ? 'border-rose-400/40 bg-rose-500/15 text-rose-200'
                  : 'border-white/8 bg-white/3 text-zinc-400 hover:text-zinc-200',
              )}
            >
              {s.label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-white/10" />
          {enabledTags.length > 0 ? (
            enabledTags.map((t) => {
              const on = selTags.has(t.id)
              return (
                <button
                  key={t.id}
                  onClick={() => toggleTag(t.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition',
                    on ? 'border-transparent' : 'border-white/8 bg-white/3 text-zinc-400 hover:text-zinc-200',
                  )}
                  style={on ? { background: `${t.color}33`, color: t.color } : undefined}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: on ? t.color : t.color + '88' }} />
                  {t.name}
                  {on && <XIcon className="h-3 w-3 opacity-70" />}
                </button>
              )
            })
          ) : (
            <span className="text-[11px] text-zinc-600">标签为空，可在「标签与设置」中创建</span>
          )}
        </div>

        {/* 排序 / 优先级 / 截止范围（9.7.2 二次筛选） */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            title="排序策略"
            className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11.5px] text-zinc-300 outline-none scheme-dark"
          >
            <option value="due">按截止时间</option>
            <option value="priority">按优先级</option>
            <option value="created">按创建时间</option>
            <option value="updated">按更新时间</option>
          </select>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as PriorityFilter)}
            title="优先级筛选"
            className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11.5px] text-zinc-300 outline-none scheme-dark"
          >
            <option value="all">全部优先级</option>
            <option value="high">高优先级</option>
            <option value="medium">中优先级</option>
            <option value="low">低优先级</option>
          </select>
          <select
            value={dueRange}
            onChange={(e) => setDueRange(e.target.value as DueRange)}
            title="截止时间筛选"
            className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11.5px] text-zinc-300 outline-none scheme-dark"
          >
            <option value="all">全部截止时间</option>
            <option value="today">今天截止</option>
            <option value="week">本周截止</option>
            <option value="month">本月截止</option>
            <option value="overdue">已逾期</option>
          </select>
          <span className="text-[11px] text-zinc-600">
            未完成任务优先；已逾期自动显示红色截止
          </span>
        </div>
      </header>

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {!loaded ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            <Loader2Icon className="h-5 w-5 animate-spin" />
          </div>
        ) : results.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
            <SearchIcon className="h-10 w-10" />
            <div className="text-[13px]">{activeFilter ? '没有符合筛选条件的任务' : '还没有任务'}</div>
            <div className="text-[11.5px]">
              {activeFilter ? '换个关键词或清除筛选试试' : '去今日或项目里新建第一个任务吧'}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-1">
            {results.map(({ task, projectName }) => {
              const p = projectMap.get(task.projectId)
              const due = fmtDueText(task.dueTime, task.status === 'done')
              const descHit = q && task.description && task.description.toLowerCase().includes(q)
              const noteHit = q && task.note && task.note.toLowerCase().includes(q)
              return (
                <div
                  key={task.id}
                  className={cn(
                    'group flex items-center gap-2.5 rounded-xl border border-white/8 bg-white/3 px-3 py-2.5 transition hover:border-white/15 hover:bg-white/6',
                    task.status === 'done' && 'opacity-55',
                  )}
                >
                  {/* 完成勾选 */}
                  <button
                    onClick={() => void setStatus(task.id, task.status === 'done' ? 'todo' : 'done')}
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition',
                      task.status === 'done'
                        ? 'border-emerald-400 bg-emerald-400 text-emerald-950'
                        : 'border-zinc-600 text-transparent hover:border-emerald-400/70',
                    )}
                  >
                    <CheckIcon className="h-3 w-3" strokeWidth={3} />
                  </button>

                  {/* 正文 */}
                  <button onClick={() => setOpenTask(task)} className="flex-1 min-w-0 text-left">
                    <div
                      className={cn(
                        'truncate text-[13.5px] text-zinc-100',
                        task.status === 'done' && 'line-through text-zinc-500',
                      )}
                    >
                      {mark(task.title, q)}
                      {task.note && !noteHit ? (
                        <span className="ml-2 text-[11.5px] font-normal text-zinc-500">· {task.note}</span>
                      ) : null}
                      {task.note && noteHit ? (
                        <span className="ml-2 text-[11.5px] font-normal text-zinc-400">
                          · {mark(task.note, q)}
                        </span>
                      ) : null}
                    </div>
                    {/* 描述命中时展示命中片段 */}
                    {descHit && (
                      <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                        描述：{mark(descSnippet(task.description ?? '', q), q)}
                      </div>
                    )}
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
                      <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-zinc-400">
                        {p?.icon ?? '📁'} {mark(projectName, q)}
                      </span>
                      <span className={cn('flex items-center gap-1', due.cls)}>
                        {task.dueTime ? <Clock3Icon className="h-3 w-3" /> : null}
                        {due.text}
                      </span>
                    </div>
                  </button>

                  {/* 标签点 */}
                  {task.tags.length > 0 && (
                    <div className="hidden items-center gap-1 sm:flex">
                      {task.tags.slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          title={t.name}
                          className="h-2 w-2 rounded-full"
                          style={{ background: t.color }}
                        />
                      ))}
                    </div>
                  )}

                  {/* 优先级 */}
                  {task.priority !== 'medium' && (
                    <span
                      className={cn(
                        'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]',
                        task.priority === 'high'
                          ? 'border-red-500/30 bg-red-500/10 text-red-300'
                          : 'border-zinc-500/30 bg-white/5 text-zinc-500',
                      )}
                    >
                      <FlagIcon className="h-2.5 w-2.5" />
                      {task.priority === 'high' ? '高' : '低'}
                    </span>
                  )}

                  {/* 状态徽章 */}
                  <span
                    className={cn(
                      'w-11 shrink-0 rounded-md border px-1.5 py-0.5 text-right text-[10px]',
                      STATUS_META[task.status].badge,
                    )}
                  >
                    {STATUS_META[task.status].label}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {openTask && <TaskModal task={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  )
}
