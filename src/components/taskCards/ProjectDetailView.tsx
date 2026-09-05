/**
 * 项目详情 — 看板 / 列表 双视图
 *
 * 看板：待办 / 进行中 / 完成 三列，跨列拖拽改状态，同列拖拽手动排序（手动模式下），
 *       逾期任务红色角标强调；规则排序模式下禁用同列手动拖拽。
 * 列表：分组平铺展示，聚焦快速浏览与批量勾选。
 * 筛选：关键词 / 优先级 / 标签 / 截止（今天·本周·已逾期）。
 * 排序：手动（列内拖拽）/ 截止时间 / 优先级 / 创建时间 / 更新时间（本地记忆）。
 */
import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import {
  CalendarRangeIcon,
  Columns2Icon,
  ListIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  BarChart3 as BarChart3Icon,
  XIcon,
} from 'lucide-react'
import { cn, htmlToPlainText } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import type { ProjectView, TaskCard, TaskPriority, TaskStatus } from '@/types'
import { STATUS_META, STATUS_ORDER } from '@/lib/taskCardsMeta'
import { isOverdue, isToday } from '@/lib/taskCardsTime'
import TaskCardView from './TaskCardView'
import TaskModal from './TaskModal'
import ProjectReportModal from './ProjectReportModal'
import ProjectFormModal from './ProjectFormModal'
import { useCompleteFlow } from './useCompleteFlow'

const COLUMN_HINT: Record<TaskStatus, string> = {
  todo: '待开始的任务',
  doing: '正在推进的任务',
  done: '已办结的任务',
}

/** 排序策略（9.4.4-3 / 9.7.2）：手动为默认；规则排序时禁用同列手动拖拽 */
export type SortMode = 'manual' | 'due' | 'priority' | 'created' | 'updated'

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: 'manual', label: '手动排序（可拖拽）' },
  { key: 'due', label: '按截止时间' },
  { key: 'priority', label: '按优先级' },
  { key: 'created', label: '按创建时间' },
  { key: 'updated', label: '按更新时间' },
]

const SORT_STORAGE_KEY = 'taskcard:sortMode'

function loadSortMode(): SortMode {
  const v = localStorage.getItem(SORT_STORAGE_KEY) as SortMode | null
  return v && SORT_OPTIONS.some((o) => o.key === v) ? v : 'manual'
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

/** 按排序策略对单列任务排序 */
function sortColumn(list: TaskCard[], mode: SortMode): TaskCard[] {
  const arr = [...list]
  switch (mode) {
    case 'due':
      arr.sort(
        (a, b) =>
          (a.dueTime ?? '9999-99-99').localeCompare(b.dueTime ?? '9999-99-99') ||
          a.sortOrder - b.sortOrder,
      )
      break
    case 'priority':
      arr.sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          (a.dueTime ?? '9999-99-99').localeCompare(b.dueTime ?? '9999-99-99') ||
          a.sortOrder - b.sortOrder,
      )
      break
    case 'created':
      arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sortOrder - b.sortOrder)
      break
    case 'updated':
      arr.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sortOrder - b.sortOrder)
      break
    default:
      arr.sort((a, b) => a.sortOrder - b.sortOrder)
  }
  return arr
}

type DueFilter = 'all' | 'today' | 'week' | 'overdue'

function matchDue(task: TaskCard, due: DueFilter): boolean {
  if (!task.dueTime || task.status === 'done') return due === 'all'
  switch (due) {
    case 'today':
      return isToday(task.dueTime)
    case 'overdue':
      return isOverdue(task.dueTime, task.status)
    case 'week': {
      const d = new Date(task.dueTime.slice(0, 10) + 'T00:00:00')
      const t = new Date()
      const weekEnd = new Date(t)
      weekEnd.setDate(t.getDate() + (6 - t.getDay()))
      weekEnd.setHours(23, 59, 59, 999)
      return d <= weekEnd
    }
    default:
      return true
  }
}

export default function ProjectDetailView({
  project,
  onOpenTaskCreate,
  onDeleted,
}: {
  project: ProjectView
  onOpenTaskCreate: () => void
  onDeleted: () => void
}) {
  // 注意：zustand v5 无 selector 结果缓存，取派生值（如 ?? []）会生成新引用，
  // useSyncExternalStore 判定快照持续变化 → 无限重渲染崩溃。
  // 因此先取 store 内稳定引用（tasksByProject 整表），再在组件内取项目任务。
  const tasksByProject = useTaskCardsStore((s) => s.tasksByProject)
  const tasks = tasksByProject[project.id] ?? []
  const tags = useTaskCardsStore((s) => s.tags)
  const dragTask = useTaskCardsStore((s) => s.dragTask)
  const deleteProject = useTaskCardsStore((s) => s.deleteProject)
  const createTask = useTaskCardsStore((s) => s.createTask)
  const { toggleDone, completeModal } = useCompleteFlow()

  const [openTask, setOpenTask] = useState<TaskCard | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [activeDragTask, setActiveDragTask] = useState<TaskCard | null>(null)
  const [editing, setEditing] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [viewMode, setViewMode] = useState<'board' | 'list'>('board')
  const [sortMode, setSortMode] = useState<SortMode>(loadSortMode)
  // 筛选：标签单选 / 关键词 / 优先级 / 截止范围
  const [selTag, setSelTag] = useState<string>('')
  const [keyword, setKeyword] = useState('')
  const [selPriority, setSelPriority] = useState<'all' | TaskPriority>('all')
  const [dueFilter, setDueFilter] = useState<DueFilter>('all')
  // 列底快速新建
  const [quickBusy, setQuickBusy] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const stats = project.stats
  const doneRate = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0

  const enabledTags = useMemo(() => tags.filter((t) => t.status === 'enabled'), [tags])

  /** 是否有激活筛选（筛选时看板拖拽禁用，避免重排错位） */
  const filtering = selTag !== '' || keyword.trim() !== '' || selPriority !== 'all' || dueFilter !== 'all'

  // 组合筛选后的任务
  const filteredTasks = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return tasks.filter((t) => {
      if (selTag && !t.tags.some((x) => x.id === selTag)) return false
      if (selPriority !== 'all' && t.priority !== selPriority) return false
      if (dueFilter !== 'all' && !matchDue(t, dueFilter)) return false
      if (q && !`${t.title} ${t.note ?? ''} ${htmlToPlainText(t.description ?? '')}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [tasks, selTag, selPriority, dueFilter, keyword])

  const columnTasks = useMemo(() => {
    const map: Record<TaskStatus, TaskCard[]> = { todo: [], doing: [], done: [] }
    for (const t of filteredTasks) map[t.status].push(t)
    for (const key of STATUS_ORDER) map[key] = sortColumn(map[key], sortMode)
    return map
  }, [filteredTasks, sortMode])

  function changeSort(mode: SortMode) {
    setSortMode(mode)
    localStorage.setItem(SORT_STORAGE_KEY, mode)
  }

  function clearFilters() {
    setSelTag('')
    setKeyword('')
    setSelPriority('all')
    setDueFilter('all')
  }

  /** 列内全量 id（按当前 sort_order 的存储顺序，供拖拽落点计算） */
  function columnOrderIds(status: TaskStatus): string[] {
    return tasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => t.id)
  }

  function handleDragStart(e: DragStartEvent) {
    const taskId = String(e.active.id)
    setActiveDragId(taskId)
    setActiveDragTask(tasks.find((t) => t.id === taskId) ?? null)
  }

  async function handleDragEnd(e: DragEndEvent) {
    const taskId = String(e.active.id)
    setActiveDragId(null)
    setActiveDragTask(null)
    const overId = e.over ? String(e.over.id) : ''
    const dragged = tasks.find((t) => t.id === taskId)
    if (!dragged) return

    // 落在某卡片上：插到该卡前（同列=手动重排；异列=跨列+定位）
    if (overId.startsWith('card-')) {
      const overTaskId = overId.slice(5)
      if (overTaskId === taskId) return
      const overTask = tasks.find((t) => t.id === overTaskId)
      if (!overTask) return
      const targetStatus = overTask.status as TaskStatus
      // 规则排序下同列拖拽不生效（9.4.4-3 互斥）
      if (targetStatus === dragged.status && sortMode !== 'manual') return
      const order = columnOrderIds(targetStatus).filter((id) => id !== taskId)
      const idx = order.indexOf(overTaskId)
      const insertAt = idx === -1 ? order.length : idx
      order.splice(insertAt, 0, taskId)
      await dragTask(taskId, targetStatus, order).catch((err) => {
        toast.error(errText(err, '拖拽失败'))
      })
      return
    }

    // 落在列空白：跨列放入列尾（同列无效）
    if (overId.startsWith('col-')) {
      const targetStatus = overId.slice(4) as TaskStatus
      if (dragged.status === targetStatus) return
      const order = columnOrderIds(targetStatus).filter((id) => id !== taskId)
      order.push(taskId)
      await dragTask(taskId, targetStatus, order).catch((err) => {
        toast.error(errText(err, '拖拽失败'))
      })
    }
  }

  /** 列底快速新建（看板 todo/doing 列） */
  async function quickCreate(status: TaskStatus, title: string) {
    const t = title.trim()
    if (!t) return
    setQuickBusy(true)
    try {
      const created = await createTask({
        projectId: project.id,
        title: t.slice(0, 100),
        status,
        priority: 'medium',
      })
      toast.success('任务已创建')
      void useTaskCardsStore.getState().fetchProjectTasks(created.projectId)
    } catch (err) {
      toast.error(errText(err, '创建失败'))
    } finally {
      setQuickBusy(false)
    }
  }

  async function handleDeleteProject() {
    if (!window.confirm(`删除项目「${project.name}」？其所有任务将一并移入回收站，可恢复。`)) return
    try {
      await deleteProject(project.id)
      toast.success('项目已移入回收站')
      onDeleted()
    } catch (err) {
      toast.error(errText(err, '删除失败'))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <header className="shrink-0 border-b border-white/8 px-6 py-3.5">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[22px] shadow-lg"
            style={{ background: project.color + '26', border: `1px solid ${project.color}44` }}
          >
            {project.icon || '📁'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[16px] font-semibold">{project.name}</h2>
              {project.pinned && <span className="text-[11px] text-amber-300/90">📌 置顶</span>}
              {project.status === 'completed' && (
                <span className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] text-emerald-300">
                  已完成
                </span>
              )}
              {project.status === 'archived' && (
                <span className="rounded-md border border-zinc-500/25 bg-zinc-500/10 px-1.5 py-0.5 text-[10.5px] text-zinc-400">
                  已归档
                </span>
              )}
            </div>
            {project.description && (
              <p className="truncate text-[12px] text-zinc-500">{project.description}</p>
            )}
          </div>
          {/* 日期 */}
          <div className="hidden lg:flex items-center gap-3 text-[11.5px] text-zinc-400">
            {project.planStartDate || project.planEndDate ? (
              <span className="flex items-center gap-1">
                <CalendarRangeIcon className="h-3.5 w-3.5" />
                {project.planStartDate ?? '…'}
                {project.planEndDate ? ` ~ ${project.planEndDate}` : project.planStartDate ? ' ~ 永久' : ''}
              </span>
            ) : null}
          </div>
          <button
            onClick={() => setShowReport(true)}
            title="项目周报 / 动态"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100"
          >
            <BarChart3Icon className="h-4 w-4" />
          </button>
          <button
            onClick={() => setEditing(true)}
            title="编辑项目"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100"
          >
            <PencilIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => void handleDeleteProject()}
            title="删除项目（移入回收站）"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-red-500/15 hover:text-red-300"
          >
            <Trash2Icon className="h-4 w-4" />
          </button>
          <button
            onClick={onOpenTaskCreate}
            className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-3.5 py-2 text-[13px] font-medium text-white shadow-lg shadow-rose-900/30"
          >
            <PlusIcon className="h-4 w-4" />
            新建任务
          </button>
        </div>

        {/* 进度条 + 排序策略 + 视图切换 */}
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 w-36 overflow-hidden rounded-full bg-white/6">
            <div
              className="h-full rounded-full bg-linear-to-r from-rose-500 to-orange-400 transition-all duration-500"
              style={{ width: `${doneRate}%` }}
            />
          </div>
          <span className="text-[11px] tabular-nums text-zinc-400">
            {doneRate}% · {stats.done}/{stats.total}
          </span>
          <div className="flex-1" />
          {filtering && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200"
            >
              <XIcon className="h-3 w-3" />
              清除筛选
            </button>
          )}
          <span className="text-[11px] text-zinc-600">显示 {filteredTasks.length} / {tasks.length}</span>
          {/* 排序策略选择 */}
          <select
            value={sortMode}
            onChange={(e) => changeSort(e.target.value as SortMode)}
            title="排序策略"
            className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11.5px] text-zinc-300 outline-none scheme-dark"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="flex items-center rounded-lg border border-white/10 p-0.5">
            <button
              onClick={() => setViewMode('board')}
              title="看板视图"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition',
                viewMode === 'board' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              <Columns2Icon className="h-3.5 w-3.5" />
              看板
            </button>
            <button
              onClick={() => setViewMode('list')}
              title="列表视图"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition',
                viewMode === 'list' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              <ListIcon className="h-3.5 w-3.5" />
              列表
            </button>
          </div>
        </div>

        {/* 项目内筛选：关键词 / 优先级 / 截止范围 / 标签 */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex w-52 items-center gap-1.5 rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 transition focus-within:border-rose-400/50">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索本项目的任务…"
              className="w-full min-w-0 bg-transparent text-[12px] outline-none placeholder:text-zinc-600"
            />
            {keyword && (
              <button onClick={() => setKeyword('')} className="shrink-0 text-zinc-500 hover:text-zinc-300">
                <XIcon className="h-3 w-3" />
              </button>
            )}
          </div>
          <select
            value={selPriority}
            onChange={(e) => setSelPriority(e.target.value as 'all' | TaskPriority)}
            title="优先级筛选"
            className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11.5px] text-zinc-300 outline-none scheme-dark"
          >
            <option value="all">全部优先级</option>
            <option value="high">高优先级</option>
            <option value="medium">中优先级</option>
            <option value="low">低优先级</option>
          </select>
          <select
            value={dueFilter}
            onChange={(e) => setDueFilter(e.target.value as DueFilter)}
            title="截止时间筛选"
            className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11.5px] text-zinc-300 outline-none scheme-dark"
          >
            <option value="all">全部截止时间</option>
            <option value="today">今天截止</option>
            <option value="week">本周截止</option>
            <option value="overdue">已逾期</option>
          </select>
          {enabledTags.length > 0 && (
            <div className="ml-auto flex max-w-full flex-wrap items-center gap-1.5">
              <button
                onClick={() => setSelTag('')}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11px] transition',
                  !selTag
                    ? 'border-rose-400/40 bg-rose-500/15 text-rose-200'
                    : 'border-white/8 text-zinc-500 hover:text-zinc-300',
                )}
              >
                全部标签
              </button>
              {enabledTags.map((t) => {
                const on = selTag === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelTag(on ? '' : t.id)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition',
                      on ? 'border-transparent' : 'border-white/8 text-zinc-500 hover:text-zinc-300',
                    )}
                    style={on ? { background: `${t.color}33`, color: t.color } : undefined}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
                    {t.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </header>

      {/* 看板视图 */}
      {viewMode === 'board' && (
        <div className="flex-1 min-h-0 overflow-x-auto px-5 py-4 ">
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="grid h-full min-h-0 min-w-[760px] grid-cols-3 gap-3.5">
              {STATUS_ORDER.map((status) => {
                const list = columnTasks[status]
                const canAdd = status !== 'done'
                return (
                  <BoardColumn
                    key={status}
                    status={status}
                    count={list.length}
                    empty={list.length === 0 && !activeDragId}
                    dragDisabled={filtering}
                  >
                    {list.map((task) => (
                      <BoardCard
                        key={task.id}
                        task={task}
                        project={project}
                        manual={sortMode === 'manual'}
                        dragDisabled={filtering}
                        onOpen={() => setOpenTask(task)}
                        onToggleDone={() => void toggleDone(task)}
                      />
                    ))}
                    {canAdd && (
                      <QuickAddRow status={status} busy={quickBusy} onCreate={(title) => void quickCreate(status, title)} />
                    )}
                  </BoardColumn>
                )
              })}
            </div>
            {/* 拖拽影子：跟随指针，原卡半透明占位 */}
            <DragOverlay dropAnimation={null}>
              {activeDragTask ? (
                <div className="rotate-2 scale-[1.02] cursor-grabbing shadow-2xl shadow-black/50 ring-1 ring-white/10">
                  <TaskCardView
                    task={activeDragTask}
                    project={project}
                    onOpen={() => {}}
                    onToggleDone={() => {}}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {/* 列表视图 */}
      {viewMode === 'list' && (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          <div className="mx-auto max-w-3xl space-y-7">
            {STATUS_ORDER.map((status) => {
              const list = columnTasks[status]
              return (
                <section key={status}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <span className={cn('h-2 w-2 rounded-full', STATUS_META[status].dot)} />
                    <h3 className="text-[12px] font-semibold tracking-wide text-zinc-300">
                      {STATUS_META[status].label}
                    </h3>
                    <span className="text-[11px] tabular-nums text-zinc-500">{list.length}</span>
                    <span className="text-[10.5px] text-zinc-600">{COLUMN_HINT[status]}</span>
                  </div>
                  {list.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-white/8 px-3 py-4 text-center text-[11.5px] text-zinc-600">
                      暂无{STATUS_META[status].label}任务
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {list.map((task) => (
                        <TaskCardView
                          key={task.id}
                          task={task}
                          project={project}
                          onOpen={() => setOpenTask(task)}
                          onToggleDone={() => void toggleDone(task)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      )}

      {/* 弹层 */}
      {openTask && <TaskModal task={openTask} onClose={() => setOpenTask(null)} />}
      {completeModal}
      {editing && (
        <ProjectFormModal
          editId={project.id}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
      {showReport && <ProjectReportModal project={project} onClose={() => setShowReport(false)} />}
    </div>
  )
}

/* ── 看板拖拽（dnd-kit；大纲拖拽同款方案，Tauri WebView 下可靠）── */

/** 看板列：droppable，悬停高亮；底部提供快速新建输入 */
function BoardColumn({
  status,
  count,
  empty,
  dragDisabled,
  children,
}: {
  status: TaskStatus
  count: number
  empty: boolean
  dragDisabled: boolean
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${status}`, disabled: dragDisabled })
  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex flex-col min-h-0 rounded-xl border bg-white/2.5 transition',
        isOver ? 'border-rose-400/50 bg-rose-500/8 ring-1 ring-rose-400/30' : 'border-white/8',
      )}
    >
      {/* 列头 */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className={cn('h-2 w-2 rounded-full', STATUS_META[status].dot)} />
        <h3 className="text-[13px] font-semibold">{STATUS_META[status].label}</h3>
        <span className="text-[11px] tabular-nums text-zinc-500">{count}</span>
        <span className="hidden xl:block flex-1 truncate pl-1 text-[10.5px] text-zinc-600">
          {COLUMN_HINT[status]}
        </span>
      </div>

      {/* 列内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
        {empty && (
          <div className="rounded-lg border border-dashed border-white/8 px-3 py-6 text-center text-[11.5px] text-zinc-600">
            暂无{STATUS_META[status].label}任务
          </div>
        )}
        {children}
      </div>
    </section>
  )
}

/** 看板列底：快速新建输入（当前列直接创建，不弹窗） */
function QuickAddRow({
  status,
  busy,
  onCreate,
}: {
  status: TaskStatus
  busy: boolean
  onCreate: (title: string) => void
}) {
  const [title, setTitle] = useState('')
  const [focused, setFocused] = useState(false)
  const submit = () => {
    if (!title.trim() || busy) return
    onCreate(title)
    setTitle('')
  }
  return (
    <div className="px-2 pb-2 pt-0.5">
      {focused || title ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="rounded-lg border border-white/12 bg-black/30 px-2 py-1.5"
        >
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setTitle('')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            onBlur={() => {
              if (!title.trim()) setFocused(false)
            }}
            maxLength={100}
            placeholder="回车快速新建…"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-zinc-600"
          />
        </form>
      ) : (
        <button
          onClick={() => setFocused(true)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-lg border border-dashed px-2 py-1.5 text-[11.5px] transition',
            'border-white/8 text-zinc-600 hover:border-rose-400/30 hover:bg-rose-500/5 hover:text-zinc-400',
          )}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          添加任务到「{STATUS_META[status].label}」列
        </button>
      )}
    </div>
  )
}

/** 看板任务卡：draggable + droppable（同列排序落点），整卡可拖 */
function BoardCard({
  task,
  project,
  manual,
  dragDisabled,
  onOpen,
  onToggleDone,
}: {
  task: TaskCard
  project: ProjectView
  manual: boolean
  dragDisabled: boolean
  onOpen: () => void
  onToggleDone: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { status: task.status },
    disabled: dragDisabled,
  })
  // 卡片本身作为同列/跨列落点（manual 拖拽时可用）
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `card-${task.id}`,
    disabled: dragDisabled || !manual,
  })
  return (
    <div
      ref={(n) => {
        setNodeRef(n)
        setDropRef(n)
      }}
      {...attributes}
      {...listeners}
      style={{ touchAction: 'none' }}
      className={cn(
        'relative cursor-grab rounded-xl transition active:cursor-grabbing',
        isDragging && 'opacity-40',
        isOver && 'ring-2 ring-rose-400/80 ring-inset rounded-xl',
      )}
    >
      <TaskCardView task={task} project={project} onOpen={onOpen} onToggleDone={onToggleDone} />
    </div>
  )
}
