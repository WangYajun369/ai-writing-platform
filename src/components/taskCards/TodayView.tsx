/**
 * 今日任务视图
 *
 * 分区：逾期（红色）/ 进行中（高优先级）/ 今日截止 / 计划今日 / 今日已完成（折叠）
 * 顶部：今日应完成概览（含完成率进度条）+ 快速添加任务
 * 卡片行尾可「顺延到明天」（9.8.2）
 */
import { useMemo, useState } from 'react'
import {
  AlertCircleIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  PlusIcon,
  SunIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import { isOverdue, isToday } from '@/lib/taskCardsTime'
import type { TaskCard } from '@/types'
import TaskCardView from './TaskCardView'
import TaskModal from './TaskModal'

type GroupKey = 'overdue' | 'doing' | 'dueToday' | 'planned' | 'done'

const GROUP_META: Record<GroupKey, { label: string; hint: string; accent: string }> = {
  overdue: { label: '逾期未完成', hint: '已过期，请尽快处理或重设截止时间', accent: 'text-red-300' },
  doing: { label: '进行中', hint: '进行中的高优先级任务，建议优先完成', accent: 'text-sky-300' },
  dueToday: { label: '今日截止', hint: '今天到期的任务', accent: 'text-amber-300' },
  planned: { label: '计划今日', hint: '今天想完成的事', accent: 'text-rose-300' },
  done: { label: '今日已完成', hint: '今天办结的事项', accent: 'text-emerald-300' },
}

/** 时间输入值格式 YYYY-MM-DDTHH:MM */
function fmtInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 顺延到明天：截止时间改为明天（保留原时刻，无截止则 09:00），移出今日（9.8.2） */
function tomorrowDue(task: TaskCard): string {
  const now = new Date()
  let h = 9
  let m = 0
  if (task.dueTime && task.dueTime.length >= 16) {
    const hh = Number(task.dueTime.slice(11, 13))
    const mm = Number(task.dueTime.slice(14, 16))
    if (!Number.isNaN(hh) && !Number.isNaN(mm)) {
      h = hh
      m = mm
    }
  }
  return fmtInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m))
}

export default function TodayView({
  onOpenTaskCreate,
  onOpenProjectCreate,
}: {
  onOpenTaskCreate: () => void
  onOpenProjectCreate: () => void
}) {
  const projects = useTaskCardsStore((s) => s.projects)
  const tasksByProject = useTaskCardsStore((s) => s.tasksByProject)
  const overview = useTaskCardsStore((s) => s.overview)
  const loaded = useTaskCardsStore((s) => s.loaded)
  const setStatus = useTaskCardsStore((s) => s.setStatus)
  const updateTask = useTaskCardsStore((s) => s.updateTask)

  const [openTask, setOpenTask] = useState<TaskCard | null>(null)
  const [collapsedDone, setCollapsedDone] = useState(true)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickProjectId, setQuickProjectId] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  // 快速添加可选的项目（排除已归档）
  const addableProjects = useMemo(() => projects.filter((p) => p.status !== 'archived'), [projects])
  // 默认选中"最活跃"项目（未完成任务最多的；无则第一个）
  const defaultQuickProject = useMemo(() => {
    if (addableProjects.length === 0) return ''
    let best = addableProjects[0]
    let bestOpen = -1
    for (const p of addableProjects) {
      const s = p.stats
      const open = s.todo + s.doing
      if (open > bestOpen) {
        bestOpen = open
        best = p
      }
    }
    return best.id
  }, [addableProjects])
  const quickSelProject = quickProjectId || defaultQuickProject

  // 按组归类（同一任务仅归入优先级最高的组）
  const groups = useMemo(() => {
    const result: Record<GroupKey, TaskCard[]> = {
      overdue: [],
      doing: [],
      dueToday: [],
      planned: [],
      done: [],
    }
    for (const list of Object.values(tasksByProject)) {
      for (const task of list) {
        if (task.status === 'done') {
          if (isToday(task.completedTime)) result.done.push(task)
          continue
        }
        if (isOverdue(task.dueTime)) {
          result.overdue.push(task)
        } else if (task.status === 'doing' && task.priority === 'high') {
          // 7.4：进行中的高优先级任务默认展示在今日页
          result.doing.push(task)
        } else if (task.dueTime && isToday(task.dueTime)) {
          result.dueToday.push(task)
        } else if (task.plannedToday) {
          result.planned.push(task)
        }
      }
    }
    const sortBy = (a: TaskCard, b: TaskCard) => {
      const p = { high: 0, medium: 1, low: 2 }
      if (p[a.priority] !== p[b.priority]) return p[a.priority] - p[b.priority]
      return (a.dueTime ?? '9999').localeCompare(b.dueTime ?? '9999')
    }
    for (const key of Object.keys(result) as GroupKey[]) result[key].sort(sortBy)
    return result
  }, [tasksByProject])

  const openCount =
    groups.overdue.length + groups.doing.length + groups.dueToday.length + groups.planned.length
  const doneCount = overview?.doneToday ?? groups.done.length
  // 今日应完成 = 未完成欠账（badge 或 openCount）+ 今日已完成
  const shouldTotal = (overview?.badge ?? openCount) + doneCount
  const rate = shouldTotal > 0 ? Math.round((doneCount / shouldTotal) * 100) : 0

  const now = new Date()
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 · ${weekdays[now.getDay()]}`

  async function toggleDone(task: TaskCard) {
    await setStatus(task.id, task.status === 'done' ? 'todo' : 'done').catch(() => {})
  }

  async function postpone(task: TaskCard) {
    try {
      await updateTask(task.id, { dueTime: tomorrowDue(task), plannedToday: false })
      toast.success('已顺延到明天')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '顺延失败')
    }
  }

  /** 行内快速添加（9.8.1）：默认计划今日 */
  async function quickCreate() {
    const t = quickTitle.trim()
    if (!t || quickBusy) return
    if (!quickSelProject) {
      toast.error('请先创建项目')
      return
    }
    setQuickBusy(true)
    try {
      await useTaskCardsStore.getState().createTask({
        projectId: quickSelProject,
        title: t.slice(0, 100),
        plannedToday: true,
        priority: 'medium',
      })
      toast.success('已加入「计划今日」')
      setQuickTitle('')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '创建失败')
    } finally {
      setQuickBusy(false)
    }
  }

  function renderGroup(key: GroupKey) {
    const list = groups[key]
    if (list.length === 0) return null
    const meta = GROUP_META[key]
    const isDoneGroup = key === 'done'
    const show = !isDoneGroup || !collapsedDone
    return (
      <section key={key} className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          {isDoneGroup ? (
            <button
              onClick={() => setCollapsedDone(!collapsedDone)}
              className="flex items-center gap-1 text-[12px] font-semibold text-zinc-400 hover:text-zinc-200"
            >
              {collapsedDone ? <ChevronRightIcon className="h-3.5 w-3.5" /> : <ChevronDownIcon className="h-3.5 w-3.5" />}
              <span className={meta.accent}>{meta.label}</span>
              <span className="text-zinc-500">· {list.length}</span>
            </button>
          ) : (
            <>
              <h3 className={cn('text-[12px] font-semibold tracking-wide', meta.accent)}>{meta.label}</h3>
              <span className="text-[11px] text-zinc-500">· {list.length}</span>
            </>
          )}
          <span className="hidden sm:block text-[11px] text-zinc-600">{meta.hint}</span>
        </div>
        {show && (
          <div className="space-y-1.5">
            {list.map((task) => (
              <TaskCardView
                key={task.id}
                task={task}
                project={projectMap.get(task.projectId)}
                onOpen={() => setOpenTask(task)}
                onToggleDone={() => void toggleDone(task)}
                onPostpone={key === 'done' ? undefined : () => void postpone(task)}
              />
            ))}
          </div>
        )}
      </section>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <header className="flex items-center gap-3 border-b border-white/8 px-6 h-14 shrink-0">
        <div className="flex items-center gap-2">
          <SunIcon className="h-5 w-5 text-amber-300" />
          <div className="leading-tight">
            <h2 className="text-[15px] font-semibold">今日任务</h2>
            <p className="text-[10.5px] text-zinc-500">{dateLabel} · 有始有终，今日事今日毕</p>
          </div>
        </div>
        {/* 摘要 */}
        <div className="hidden md:flex items-center gap-2 ml-4">
          <span className="flex items-center gap-1 rounded-lg border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
            <AlertCircleIcon className="h-3 w-3" />
            待办 {overview?.badge ?? openCount}
          </span>
          <span className="flex items-center gap-1 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
            <CheckCircle2Icon className="h-3 w-3" />
            已完成 {doneCount}
          </span>
          {(overview?.overdue ?? groups.overdue.length) > 0 && (
            <span className="flex items-center gap-1 rounded-lg border border-red-500/35 bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-300">
              <AlertCircleIcon className="h-3 w-3" />
              逾期 {overview?.overdue ?? groups.overdue.length}
            </span>
          )}
        </div>
        <div className="flex-1" />
        <button
          onClick={onOpenTaskCreate}
          disabled={projects.length === 0}
          title={projects.length === 0 ? '请先创建项目' : '新建今日任务'}
          className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-3.5 py-2 text-[13px] font-medium text-white shadow-lg shadow-rose-900/30 transition disabled:opacity-40"
        >
          <PlusIcon className="h-4 w-4" />
          新建任务
        </button>
      </header>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto px-6 py-5 ">
        {!loaded ? (
          <div className="flex h-full items-center justify-center text-[13px] text-zinc-500">加载中…</div>
        ) : projects.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-zinc-500">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5">
              <FolderPlusIcon className="h-7 w-7 text-zinc-600" />
            </div>
            <div className="text-center">
              <div className="text-[15px] text-zinc-300">还没有项目</div>
              <div className="mt-1 text-[12.5px]">先创建你的第一个项目，再往里面添加任务吧</div>
            </div>
            <button
              onClick={onOpenProjectCreate}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-200 transition hover:bg-rose-500/20"
            >
              <FolderPlusIcon className="h-4 w-4" />
              新建项目
            </button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 pb-8">
            {/* 今日账本：应完成 / 已完成 / 完成率（9.8.1） */}
            <div className="rounded-xl border border-white/8 bg-white/3 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-[12.5px] text-zinc-300">
                  今日应完成 <b className="tabular-nums text-zinc-100">{shouldTotal}</b>
                </span>
                <span className="text-[12.5px] text-zinc-300">
                  已完成 <b className="tabular-nums text-emerald-300">{doneCount}</b>
                </span>
                {(overview?.overdue ?? 0) > 0 && (
                  <span className="text-[12.5px] text-red-300">
                    逾期 <b className="tabular-nums">{overview?.overdue}</b>
                  </span>
                )}
                <div className="flex min-w-[120px] flex-1 items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/6">
                    <div
                      className="h-full rounded-full bg-linear-to-r from-rose-500 to-orange-400 transition-all duration-500"
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                  <span className="text-[11px] tabular-nums text-zinc-400">{rate}%</span>
                </div>
              </div>
            </div>

            {/* 行内快速添加（9.8.1）：默认加入「计划今日」 */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void quickCreate()
              }}
              className="flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-500/5 px-3 py-2 transition focus-within:border-rose-400/50"
            >
              <PlusIcon className="h-4 w-4 shrink-0 text-rose-400" />
              <input
                value={quickTitle}
                onChange={(e) => setQuickTitle(e.target.value)}
                placeholder="快速添加任务，回车加入「计划今日」…"
                className="w-full min-w-0 bg-transparent text-[13px] outline-none placeholder:text-zinc-600"
              />
              <select
                value={quickSelProject}
                onChange={(e) => setQuickProjectId(e.target.value)}
                title="添加到的项目"
                className="max-w-[150px] shrink-0 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[11.5px] text-zinc-300 outline-none scheme-dark"
              >
                {addableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.icon} {p.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={quickBusy || !quickTitle.trim() || addableProjects.length === 0}
                title="回车或点击添加"
                className="shrink-0 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-3 py-1.5 text-[12px] font-medium text-white transition disabled:opacity-40"
              >
                添加
              </button>
            </form>

            {/* 分组 */}
            {openCount === 0 && doneCount === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/8 py-10 text-zinc-500">
                <SunIcon className="h-9 w-9 text-amber-400/50" />
                <div className="text-[14px] text-zinc-300">今日暂无任务</div>
                <div className="text-[12px]">在上方快速添加，或点击右上角新建任务</div>
                <button
                  onClick={onOpenTaskCreate}
                  className="mt-2 flex items-center gap-1.5 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-4 py-2 text-[13px] font-medium text-white"
                >
                  <CalendarDaysIcon className="h-4 w-4" />
                  打开新建任务窗口
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                {renderGroup('overdue')}
                {renderGroup('doing')}
                {renderGroup('dueToday')}
                {renderGroup('planned')}
                {renderGroup('done')}
              </div>
            )}
          </div>
        )}
      </div>

      {openTask && <TaskModal task={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  )
}
