/**
 * 任务卡 · 项目管理 — 独立窗口
 *
 * 左侧导航：今日 / 项目 / 回收站 / 设置
 * 右侧内容：根据导航渲染 今日视图 / 项目看板 / 回收站
 * 数据：useTaskCardsStore 全量管理；滚动清理「计划今日」、刷新概览在挂载时执行。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  BellIcon,
  CalendarRange as CalendarRangeIcon,
  CheckCheckIcon,
  ClipboardListIcon,
  ListFilterIcon,
  PlusIcon,
  Settings2Icon,
  SunIcon,
  Trash2Icon,
  FolderKanbanIcon,
  Loader2Icon,
} from 'lucide-react'
import { detectTasksWindow } from '@/components/app/windowDetection'
import { taskCardApi } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import { setTasksWindowOpen } from '@/plugins/taskCards/windowState'
import type { ProjectView, RemindLogEntry, TaskCard } from '@/types'
import TodayView from './TodayView'
import AllTasksView from './AllTasksView'
import ProjectDetailView from './ProjectDetailView'
import TrashView from './TrashView'
import SettingsDrawer from './SettingsDrawer'
import ProjectFormModal from './ProjectFormModal'
import TaskModal from './TaskModal'

export type ViewState =
  | { type: 'today' }
  | { type: 'all' }
  | { type: 'project'; projectId: string }
  | { type: 'trash' }

export default function TaskCardsWindow() {
  // 命令面板深链：?taskswin=1&section=all 直达全部任务视图
  const [view, setView] = useState<ViewState>(() =>
    detectTasksWindow().section === 'all' ? { type: 'all' } : { type: 'today' },
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectModal, setProjectModal] = useState<null | { editId?: string }>(null)
  const [createFor, setCreateFor] = useState<null | { projectId?: string; plannedToday?: boolean }>(null)
  const [pendingNav, setPendingNav] = useState<string | null>(null)
  /** 项目导航过滤页签（9.1：全部 / 进行中 / 已完成 / 已归档） */
  const [projectTab, setProjectTab] = useState<'all' | 'active' | 'completed' | 'archived'>('all')
  /** 站内铃铛中心（9.11.3） */
  const [bellOpen, setBellOpen] = useState(false)
  const [bellLogs, setBellLogs] = useState<RemindLogEntry[]>([])
  const [bellReadTs, setBellReadTs] = useState<string | null>(null)
  /** 铃铛/通知点击直达任务详情 */
  const [globalTask, setGlobalTask] = useState<TaskCard | null>(null)

  const projects = useTaskCardsStore((s) => s.projects)
  const overview = useTaskCardsStore((s) => s.overview)
  const loaded = useTaskCardsStore((s) => s.loaded)
  const refreshAll = useTaskCardsStore((s) => s.refreshAll)

  // 站内提醒日志（Rust 每发一条即追加；铃铛中心读取展示 + 未读判定）
  const refreshBell = useCallback(async () => {
    try {
      const [rawLog, rawRead] = await Promise.all([
        taskCardApi.getMeta(BELL_LOG_KEY),
        taskCardApi.getMeta(BELL_READ_KEY),
      ])
      let logs: RemindLogEntry[] = []
      if (rawLog) {
        try {
          logs = JSON.parse(rawLog) as RemindLogEntry[]
          if (!Array.isArray(logs)) logs = []
        } catch {
          logs = []
        }
      }
      setBellLogs(logs)
      setBellReadTs(rawRead ?? null)
    } catch {
      /* 读取失败静默 */
    }
  }, [])
  useEffect(() => {
    void refreshBell()
  }, [refreshBell])
  const bellUnread = useMemo(() => {
    if (!bellReadTs) return bellLogs.length
    return bellLogs.filter((l) => l.time > bellReadTs).length
  }, [bellLogs, bellReadTs])

  // 项目导航过滤：全部（排除已归档）/ 进行中 / 已完成 / 已归档
  const filteredProjects = useMemo(() => {
    if (projectTab === 'archived') return projects.filter((p) => p.status === 'archived')
    if (projectTab === 'completed') return projects.filter((p) => p.status === 'completed')
    if (projectTab === 'active') return projects.filter((p) => p.status !== 'completed' && p.status !== 'archived')
    return projects.filter((p) => p.status !== 'archived')
  }, [projects, projectTab])

  // 进入窗口：激活态 + 全量加载 + 「计划今日」滚动清理（自然日切换时自动）
  useEffect(() => {
    setTasksWindowOpen(true)
    void (async () => {
      try {
        await taskCardApi.rollPlannedToday()
      } catch {
        /* 无碍 */
      }
      await refreshAll()
    })()
    return () => setTasksWindowOpen(false)
  }, [refreshAll])

  // 每 60s 静默刷新概览（今日卡片跨夜后仍准确）
  useEffect(() => {
    const timer = window.setInterval(() => {
      void useTaskCardsStore.getState().fetchOverview().catch(() => {})
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // 命令面板导航事件：窗口已打开时收到 tasks-nav → 切换视图（today / all）
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<string>('tasks-nav', (e) => {
      const s = e.payload
      if (s === 'all') setView({ type: 'all' })
      else if (s === 'today') setView({ type: 'today' })
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {
        /* 忽略 */
      })
    return () => unlisten?.()
  }, [])

  const activeProject = view.type === 'project' ? projects.find((p) => p.id === view.projectId) : undefined

  const goProject = useCallback(
    async (projectId: string) => {
      setView({ type: 'project', projectId })
      setPendingNav(projectId)
      try {
        await useTaskCardsStore.getState().fetchProjectTasks(projectId)
      } finally {
        setPendingNav(null)
      }
    },
    [],
  )

  // ── 铃铛：已读 / 点击直达任务 ──
  async function markBellRead(ts: string) {
    try {
      await taskCardApi.setMeta(BELL_READ_KEY, ts)
      setBellReadTs((prev) => (prev && prev >= ts ? prev : ts))
    } catch {
      /* 忽略 */
    }
  }

  const openFromBell = useCallback(
    async (entry: RemindLogEntry) => {
      if (!entry.taskId || !entry.projectId) return
      setBellOpen(false)
      const store = useTaskCardsStore.getState()
      const pid = entry.projectId
      if (!store.projects.some((p) => p.id === pid)) {
        toast.info('该任务所属项目已删除')
        return
      }
      let task = store.tasksByProject[pid]?.find((t) => t.id === entry.taskId)
      if (!task) {
        try {
          await store.fetchProjectTasks(pid)
        } catch {
          /* 忽略 */
        }
        task = store.tasksByProject[pid]?.find((t) => t.id === entry.taskId)
      }
      if (!task) {
        toast.info('任务已不存在')
        return
      }
      await goProject(pid)
      setGlobalTask(task)
      if (!bellReadTs || entry.time > bellReadTs) void markBellRead(entry.time)
    },
    [bellReadTs, goProject],
  )

  return (
    <div className="h-full flex overflow-hidden bg-[linear-gradient(160deg,#0b1220_0%,#0f172a_55%,#131c31_100%)] text-zinc-100">
      {/* ── 左侧导航 ── */}
      <aside className="w-57 shrink-0 flex flex-col border-r border-white/8 bg-white/2">
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-white/8">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-rose-500 to-orange-500 shadow-lg shadow-rose-900/40">
            <ClipboardListIcon className="h-4.5 w-4.5 text-white" />
          </div>
          <div className="leading-tight min-w-0">
            <div className="text-[15px] font-semibold tracking-wide">任务卡</div>
            <div className="text-[10.5px] text-zinc-400 truncate">项目管理 · 今日办结</div>
          </div>
          {/* 铃铛：站内提醒中心（9.11.3） */}
          <div className="relative ml-auto">
            <button
              onClick={() => {
                if (!bellOpen) void refreshBell()
                setBellOpen(!bellOpen)
              }}
              className={cn(
                'relative flex h-8 w-8 items-center justify-center rounded-lg transition',
                bellOpen || bellUnread > 0
                  ? 'text-amber-300'
                  : 'text-zinc-400 hover:bg-white/8 hover:text-zinc-100',
              )}
              title="提醒中心"
            >
              <BellIcon className="h-4.5 w-4.5" />
              {bellUnread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9.5px] font-bold text-white">
                  {Math.min(bellUnread, 99)}
                </span>
              )}
            </button>
            {bellOpen && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setBellOpen(false)} />
                <BellPanel
                  logs={bellLogs}
                  readTs={bellReadTs}
                  onMarkAll={() => void markBellRead(localTimeStr())}
                  onOpen={openFromBell}
                />
              </>
            )}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-5 ">
          {/* 今日 */}
          <button
            onClick={() => setView({ type: 'today' })}
            className={cn(
              'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition',
              view.type === 'today'
                ? 'bg-linear-to-r from-rose-500/25 to-orange-500/15 text-rose-200 font-medium border border-rose-400/20'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
            )}
          >
            <SunIcon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">今日</span>
            {!loaded ? (
              <Loader2Icon className="h-3.5 w-3.5 animate-spin text-zinc-500" />
            ) : (overview?.badge ?? 0) > 0 ? (
              <span className="flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">
                {Math.min(overview?.badge ?? 0, 99)}
              </span>
            ) : null}
          </button>

          {/* 全部任务 */}
          <button
            onClick={() => setView({ type: 'all' })}
            className={cn(
              'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition',
              view.type === 'all'
                ? 'bg-linear-to-r from-rose-500/25 to-orange-500/15 text-rose-200 font-medium border border-rose-400/20'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
            )}
          >
            <ListFilterIcon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">全部任务</span>
            <span className="text-[10px] tabular-nums text-zinc-600">搜索/标签</span>
          </button>

          {/* 项目 */}
          <div>
            <div className="flex items-center justify-between px-3 mb-1.5">
              <span className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">项目</span>
              <button
                onClick={() => setProjectModal({})}
                title="新建项目"
                className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-rose-500/15 hover:text-rose-300"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            </div>
            {/* 状态页签（9.1：全部 / 进行中 / 已完成 / 已归档） */}
            <div className="mb-1 flex items-center gap-0.5 rounded-lg border border-white/6 bg-black/20 px-0.5 py-0.5 mx-1">
              {PROJECT_TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setProjectTab(tab.key)}
                  className={cn(
                    'flex-1 rounded-md px-1 py-1 text-[10.5px] transition',
                    projectTab === tab.key
                      ? 'bg-white/10 font-medium text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-300',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="space-y-0.5">
              {filteredProjects.map((p) => (
                <ProjectNavRow
                  key={p.id}
                  project={p}
                  active={view.type === 'project' && view.projectId === p.id}
                  pending={pendingNav === p.id}
                  onOpen={() => void goProject(p.id)}
                />
              ))}
              {filteredProjects.length === 0 && (
                <div className="px-3 py-2 text-[11.5px] text-zinc-600">
                  {projects.length === 0 ? (
                    <>
                      还没有项目，
                      <button
                        className="text-rose-400/90 hover:underline"
                        onClick={() => setProjectModal({})}
                      >
                        去创建一个
                      </button>
                    </>
                  ) : projectTab === 'archived' ? (
                    '没有已归档的项目'
                  ) : (
                    '没有进行中的项目'
                  )}
                </div>
              )}
            </div>
          </div>
        </nav>

        <div className="px-2.5 pb-3 pt-1 border-t border-white/8 space-y-0.5">
          <button
            onClick={() => setView({ type: 'trash' })}
            className={cn(
              'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition',
              view.type === 'trash'
                ? 'bg-white/8 text-zinc-100 font-medium'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
            )}
          >
            <Trash2Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">回收站</span>
            <FolderKanbanIcon className="h-3.5 w-3.5 text-zinc-600" />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <Settings2Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">标签与设置</span>
          </button>
        </div>
      </aside>

      {/* ── 右侧内容 ── */}
      <main className="flex-1 min-w-0 flex flex-col">
        {view.type === 'project' && activeProject && (
          <ProjectDetailView
            key={activeProject.id}
            project={activeProject}
            onOpenTaskCreate={() => setCreateFor({ projectId: activeProject.id })}
            onDeleted={() => setView({ type: 'today' })}
          />
        )}
        {view.type === 'project' && !activeProject && (
          <EmptyPlaceholder
            icon={<FolderKanbanIcon className="h-6 w-6" />}
            text="项目已被移除"
            action={
              <button
                onClick={() => setView({ type: 'today' })}
                className="rounded-lg bg-rose-500/15 px-4 py-2 text-[13px] text-rose-200 hover:bg-rose-500/25"
              >
                回到今日
              </button>
            }
          />
        )}
        {view.type === 'today' && (
          <TodayView
            onOpenTaskCreate={() => setCreateFor({ plannedToday: true })}
            onOpenProjectCreate={() => setProjectModal({})}
          />
        )}
        {view.type === 'all' && <AllTasksView />}
        {view.type === 'trash' && <TrashView onBack={() => setView({ type: 'today' })} />}
      </main>

      {/* ── 弹层 ── */}
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      {projectModal && (
        <ProjectFormModal
          editId={projectModal.editId}
          onClose={() => setProjectModal(null)}
          onSaved={async (projectId) => {
            setProjectModal(null)
            await goProject(projectId)
          }}
        />
      )}
      {createFor && (
        <TaskModal
          projectId={createFor.projectId}
          defaultPlannedToday={createFor.plannedToday}
          onClose={() => setCreateFor(null)}
        />
      )}
      {/* 铃铛直达任务详情 */}
      {globalTask && <TaskModal task={globalTask} onClose={() => setGlobalTask(null)} />}
    </div>
  )
}

/** 项目导航行：图标 / 置顶 / 待办数 / 迷你进度条 / 状态徽标（9.1） */
function ProjectNavRow({
  project,
  active,
  pending,
  onOpen,
}: {
  project: ProjectView
  active: boolean
  pending: boolean
  onOpen: () => void
}) {
  const total = project.stats.total
  const done = project.stats.done
  const open = project.stats.todo + project.stats.doing
  const rate = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <button
      onClick={onOpen}
      title={project.description || project.name}
      className={cn(
        'group w-full rounded-lg px-3 py-1.8 text-left transition',
        active ? 'bg-white/8' : 'hover:bg-white/5',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[15px] leading-none shrink-0">{project.icon || '📁'}</span>
        <span
          className={cn(
            'flex-1 truncate text-[13px]',
            active ? 'font-medium text-zinc-100' : 'text-zinc-400 group-hover:text-zinc-200',
          )}
        >
          {project.name}
        </span>
        {project.pinned && (
          <span title="置顶" className="text-[10px] leading-none text-amber-300/90">
            📌
          </span>
        )}
        {project.status === 'completed' && (
          <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1 text-[9px] text-emerald-300">
            完成
          </span>
        )}
        {project.status === 'archived' && (
          <span className="rounded border border-zinc-500/25 bg-zinc-500/10 px-1 text-[9px] text-zinc-400">
            归档
          </span>
        )}
        {open > 0 ? (
          <span className="text-[10px] font-semibold tabular-nums text-rose-400/90">{open}</span>
        ) : (
          <span className="text-[10px] tabular-nums text-zinc-600">{open}</span>
        )}
        {pending && <Loader2Icon className="h-3 w-3 animate-spin text-zinc-500" />}
      </div>
      {/* 计划周期：开始 ~ 结束；无结束日期显示「永久」 */}
      {(project.planStartDate || project.planEndDate) && (
        <div className="mt-1 flex items-center gap-1.5 pl-7 text-[10px] text-zinc-500">
          <CalendarRangeIcon className="h-3 w-3 shrink-0 text-zinc-600" />
          <span className="truncate">
            {project.planStartDate ?? '…'} ~ {project.planEndDate ?? '永久'}
          </span>
        </div>
      )}
      {total > 0 && (
        <div className="mt-1 flex items-center gap-1.5 pl-7">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/6">
            <div
              className="h-full rounded-full bg-linear-to-r from-rose-500 to-orange-400 transition-all duration-500"
              style={{ width: `${rate}%` }}
            />
          </div>
          <span className="text-[9.5px] tabular-nums text-zinc-600">
            {done}/{total}
          </span>
        </div>
      )}
    </button>
  )
}

/** 铃铛下拉面板 */
function BellPanel({
  logs,
  readTs,
  onMarkAll,
  onOpen,
}: {
  logs: RemindLogEntry[]
  readTs: string | null
  onMarkAll: () => void
  onOpen: (entry: RemindLogEntry) => void
}) {
  const unread = readTs ? logs.filter((l) => l.time > readTs).length : logs.length
  return (
    <div className="absolute right-0 top-full z-40 mt-2 w-[360px] overflow-hidden rounded-xl border border-white/10 bg-[#111b31] shadow-2xl shadow-black/50">
      <div className="flex items-center justify-between border-b border-white/8 px-3.5 py-2.5">
        <div className="text-[13px] font-semibold">
          提醒中心
          {unread > 0 && <span className="ml-1.5 text-[11px] font-normal text-rose-300">{unread} 条未读</span>}
        </div>
        {unread > 0 && (
          <button
            onClick={onMarkAll}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 transition hover:bg-white/8 hover:text-zinc-200"
          >
            <CheckCheckIcon className="h-3.5 w-3.5" />
            全部已读
          </button>
        )}
      </div>
      <div className="max-h-[58vh] overflow-y-auto">
        {logs.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-[12px] text-zinc-500">
            暂无提醒记录
            <div className="mt-1 text-[11px] text-zinc-600">截止 / 逾期 / 自定义提醒会出现在这里</div>
          </div>
        ) : (
          logs.map((entry) => {
            const isUnread = !readTs || entry.time > readTs
            return (
              <button
                key={entry.id}
                disabled={!entry.taskId || !entry.projectId}
                onClick={() => onOpen(entry)}
                title={entry.taskId ? '点击定位到任务' : undefined}
                className={cn(
                  'flex w-full items-start gap-2.5 border-b border-white/4 px-3.5 py-2.5 text-left transition',
                  entry.taskId && entry.projectId ? 'hover:bg-white/5' : 'cursor-default',
                )}
              >
                <span
                  className={cn(
                    'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                    isUnread ? 'bg-rose-500' : 'bg-transparent',
                  )}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] leading-snug text-zinc-200">{entry.title}</span>
                  <span className="mt-0.5 block text-[10.5px] text-zinc-500">
                    {entry.time.replace('T', ' ').slice(0, 16)}
                    {entry.taskId ? ' · 点击定位' : ''}
                  </span>
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px]',
                    BELL_KIND_CLS[entry.kind] ?? 'border-zinc-500/25 bg-zinc-500/10 text-zinc-400',
                  )}
                >
                  {BELL_KIND_TEXT[entry.kind] ?? '提醒'}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 铃铛 / 已读时间戳存储键（Rust reminder_service 同款） */
const BELL_LOG_KEY = 'taskcard:remind_log'
const BELL_READ_KEY = 'taskcard:remind_read_ts'

/** 提醒类型展示 */
const BELL_KIND_TEXT: Record<string, string> = {
  before: '截止前',
  due: '今日截止',
  overdue: '逾期',
  custom: '单次提醒',
  daily: '每日待办',
}
const BELL_KIND_CLS: Record<string, string> = {
  before: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  due: 'border-orange-400/25 bg-orange-400/10 text-orange-300',
  overdue: 'border-red-400/25 bg-red-400/10 text-red-300',
  custom: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  daily: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
}

/** 本地时间字符串（与后端 local_now 一致：YYYY-MM-DDTHH:MM:SS） */
function localTimeStr(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const PROJECT_TABS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'archived', label: '已归档' },
] as const

function EmptyPlaceholder({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-500">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-zinc-600">{icon}</div>
      <div className="text-[13px]">{text}</div>
      {action}
    </div>
  )
}
