/**
 * DiaryPanel — 首页右侧「日记 + 当日任务」模块（任务卡数据驱动）
 *
 * 布局（自上而下）：
 * - 模块标题栏 + 「今日日记」快捷入口
 * - 按月日历（点击某天：仅将下方切换到该日的日记与任务，不自动弹窗）
 * - 第一行「日记」：所选日期的日记卡片（无日记则显示空态写日记入口，
 *   点击「写日记 / 编辑日记」才打开 DiaryDialog）
 * - 第二行「当日任务」：所选日期的任务卡任务（截止落在该日的任务；为今天时
 *   并入「计划今日」），支持快速勾选完成 / 重新打开，完整操作跳转任务卡窗口
 *
 * 点击任意日期后，下方两行内容同步切换到那一天。
 * 日历下的状态点由任务卡数据驱动（逾期红 / 今日绿 / 未来蓝 / 已完成灰）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  NotebookPenIcon,
  PenLineIcon,
} from 'lucide-react'
import { emit, listen } from '@tauri-apps/api/event'
import { diaryApi, taskCardApi, windowApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  buildMonthCells,
  formatDiaryTime,
  formatMonthTitle,
  formatShortDate,
  formatWeekdaySuffix,
  parseDateKey,
  toDateKey,
  WEEKDAY_LABELS,
} from '@/lib/diary-utils'
import { dayOf, localToday } from '@/lib/taskCardsTime'
import type { Diary, DiaryMeta, TaskCard, TaskProject } from '@/types'
import DiaryDialog from './DiaryDialog'
import DayTasksPanel from './DayTasksPanel'
import CompleteSummaryModal from '@/components/taskCards/CompleteSummaryModal'
import { countUnfinishedSubtasks } from '@/lib/subtaskGuard'

/** 今日日期键（页面挂载时计算一次） */
const todayKey = toDateKey(new Date())

/** HTML → 纯文本（用于日记卡片正文预览） */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.innerText || doc.body.textContent || '').replace(/\s+/g, ' ').trim()
}

export default function DiaryPanel() {
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth() + 1)
  /** 本月日记摘要（用于日历上的已写标记点） */
  const [entries, setEntries] = useState<DiaryMeta[]>([])
  const [loading, setLoading] = useState(false)
  /** 全量未删除任务（当日任务 / 日历状态点的数据源；null=尚未加载） */
  const [allTasks, setAllTasks] = useState<TaskCard[] | null>(null)
  /** 全部未删除项目（渲染任务归属） */
  const [projects, setProjects] = useState<TaskProject[]>([])
  /** 当前选中的日期（驱动下方日记与任务两行联动切换） */
  const [selectedDate, setSelectedDate] = useState<string>(todayKey)
  /** 选中日期当天的日记全文（无则为 null） */
  const [selectedDiary, setSelectedDiary] = useState<Diary | null>(null)
  const [selLoading, setSelLoading] = useState(false)
  /** 正在编辑的日期（控制 DiaryDialog 开关） */
  const [editingDate, setEditingDate] = useState<string | null>(null)
  /** 正在填写完成总结的任务（非 null 时弹出总结对话框） */
  const [completingTask, setCompletingTask] = useState<TaskCard | null>(null)
  /** 请求序号：避免快速切换日期时旧请求覆盖新结果 */
  const selectedReqRef = useRef(0)

  const loadEntries = useCallback(async (year: number, month: number) => {
    setLoading(true)
    try {
      const list = await diaryApi.listMonth(year, month)
      setEntries(list)
    } catch (err) {
      console.error('加载日记列表失败', err)
      toast.error(`加载日记列表失败：${errText(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  /** 加载全量任务与项目（当日任务面板与日历状态点共用，数据量小、直接全量） */
  const loadTaskData = useCallback(async () => {
    try {
      const [tasks, projs] = await Promise.all([
        taskCardApi.listAllTasks(),
        taskCardApi.listProjects().catch(() => []),
      ])
      setAllTasks(tasks)
      setProjects(projs)
    } catch (err) {
      console.error('加载任务卡数据失败', err)
      toast.error(`加载当日任务失败：${errText(err)}`)
    }
  }, [])

  /** 加载选中日期当天的日记全文 */
  const loadSelected = useCallback(async (date: string) => {
    const seq = ++selectedReqRef.current
    setSelLoading(true)
    try {
      const diary = await diaryApi.get(date)
      if (seq === selectedReqRef.current) {
        setSelectedDiary(diary)
        setSelLoading(false)
      }
    } catch (err) {
      if (seq === selectedReqRef.current) {
        setSelLoading(false)
        console.error('加载日记失败', err)
        toast.error(`加载日记失败：${errText(err)}`)
      }
    }
  }, [])

  // 切换年月后自动重新加载该月日记
  useEffect(() => {
    void loadEntries(viewYear, viewMonth)
  }, [viewYear, viewMonth, loadEntries])

  // 挂载加载任务数据 + 监听任务卡数据变更 / 窗口关闭（跨窗口操作后日历与当日任务同步）
  useEffect(() => {
    void loadTaskData()
    const unTasksData = listen('tasks-data-updated', () => void loadTaskData())
    const unTasksClosed = listen('tasks-window-closed', () => void loadTaskData())
    return () => {
      void unTasksData.then((fn) => fn())
      void unTasksClosed.then((fn) => fn())
    }
  }, [loadTaskData])

  // 选中日期变化后加载该日日记
  useEffect(() => {
    void loadSelected(selectedDate)
  }, [selectedDate, loadSelected])

  // 翻页后若选中日期不在当前视图月，自动落到「今天（若在本月）否则当月 1 日」，
  // 保证日历高亮与下方两行内容始终处于同一月份
  useEffect(() => {
    const { year, month } = parseDateKey(selectedDate)
    if (year !== viewYear || month !== viewMonth) {
      const now = new Date()
      const fallback =
        now.getFullYear() === viewYear && now.getMonth() + 1 === viewMonth
          ? toDateKey(now)
          : `${viewYear}-${String(viewMonth).padStart(2, '0')}-01`
      setSelectedDate(fallback)
    }
  }, [viewYear, viewMonth, selectedDate])

  // 保存 / 删除 / 清空删除后刷新：重新拉本月摘要，若改动的是选中日则一并刷新当日卡片
  const handleDiaryChanged = useCallback(
    (savedDate?: string) => {
      void loadEntries(viewYear, viewMonth)
      if (!savedDate || savedDate === selectedDate) void loadSelected(selectedDate)
    },
    [viewYear, viewMonth, selectedDate, loadEntries, loadSelected],
  )

  /** 勾选完成 → 弹出总结对话框；已完成任务 → 直接重新打开（不弹总结） */
  const handleToggleTask = useCallback(
    (task: TaskCard) => {
      if (task.status === 'done') {
        void taskCardApi
          .setTaskStatus(task.id, 'todo')
          .then(async () => {
            await loadTaskData()
            void emit('tasks-data-updated')
          })
          .catch((err) => {
            console.error('重新打开任务失败', err)
            toast.error(`重新打开任务失败：${errText(err)}`)
          })
      } else {
        // 未完成 → 先校验子任务是否全部完成；有未完成项则不允许完成
        void (async () => {
          const pending = await countUnfinishedSubtasks(task.id)
          if (pending > 0) {
            toast.error(`还有 ${pending} 项子任务未完成，请先完成全部子任务后再勾选完成`)
            return
          }
          setCompletingTask(task)
        })()
      }
    },
    [loadTaskData],
  )

  /** 总结对话框保存完成后：重拉数据 + 广播（角标/任务卡窗口同步） */
  const handleTaskCompleted = useCallback(() => {
    void loadTaskData()
    void emit('tasks-data-updated')
  }, [loadTaskData])

  const goPrevMonth = () => {
    if (viewMonth === 1) {
      setViewYear((v) => v - 1)
      setViewMonth(12)
    } else {
      setViewMonth((m) => m - 1)
    }
  }
  const goNextMonth = () => {
    if (viewMonth === 12) {
      setViewYear((v) => v + 1)
      setViewMonth(1)
    } else {
      setViewMonth((m) => m + 1)
    }
  }
  const goToday = () => {
    const now = new Date()
    setViewYear(now.getFullYear())
    setViewMonth(now.getMonth() + 1)
    setSelectedDate(todayKey)
  }
  /** 本月已写日记的日期集合（日历圆点） */
  const writtenSet = useMemo(() => new Set(entries.map((e) => e.diaryDate)), [entries])
  /** 任务卡任务按截止日期分组（日历状态点数据源；无截止日期的任务不落日历） */
  const taskDayMap = useMemo(() => {
    const map = new Map<string, TaskCard[]>()
    if (!allTasks) return map
    for (const t of allTasks) {
      const d = dayOf(t.dueTime)
      if (!d) continue
      const arr = map.get(d)
      if (arr) arr.push(t)
      else map.set(d, [t])
    }
    return map
  }, [allTasks])
  /** 项目 id → 项目 */
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  /** 今天存在「计划今日」的未完成任务（截止不在今天，日期 map 未覆盖） */
  const todayPlannedOpen = useMemo(() => {
    if (!allTasks) return false
    const today = localToday()
    return allTasks.some((t) => t.plannedToday && t.status !== 'done' && dayOf(t.dueTime) !== today)
  }, [allTasks])

  /**
   * 某日期“数字下方”的任务状态点颜色（该日有任务才显示）：
   * 过去仍有未完成（已逾期）=红 / 该日任务全部完成=灰 / 今天有待办=绿 / 未来有待办=蓝
   */
  const taskDotClassFor = (key: string): string | null => {
    const list = taskDayMap.get(key)
    const exists = (!!list && list.length > 0) || (key === todayKey && todayPlannedOpen)
    if (!exists) return null
    const hasOpen = (!!list && list.some((t) => t.status !== 'done')) || (key === todayKey && todayPlannedOpen)
    if (!hasOpen) return 'bg-muted-foreground/40'
    if (key < todayKey) return 'bg-destructive'
    if (key === todayKey) return 'bg-green-500'
    return 'bg-blue-500'
  }
  /** 选中日任务：截止落在该日；若为今天再并入「计划今日」的未完成任务（按 id 去重） */
  const dayTasks = useMemo(() => {
    if (!allTasks) return []
    const today = localToday()
    const out: TaskCard[] = []
    const seen = new Set<string>()
    for (const t of allTasks) {
      const inDay = dayOf(t.dueTime) === selectedDate
      const plannedNow = selectedDate === today && t.plannedToday && t.status !== 'done'
      if ((inDay || plannedNow) && !seen.has(t.id)) {
        seen.add(t.id)
        out.push(t)
      }
    }
    return out
  }, [allTasks, selectedDate])
  /** 选中日是否为今天 */
  const isTodayKey = selectedDate === todayKey
  /** 当日正文纯文本预览 */
  const previewText = selectedDiary ? htmlToText(selectedDiary.contentHtml) : ''
  /** 视图是否在本月 */
  const isCurrentMonth =
    viewYear === new Date().getFullYear() && viewMonth === new Date().getMonth() + 1

  const monthCells = useMemo(() => buildMonthCells(viewYear, viewMonth), [viewYear, viewMonth])
  const cellKey = (day: number) => toDateKey(new Date(viewYear, viewMonth - 1, day))

  const openSelectedEditor = () => setEditingDate(selectedDate)

  return (
    <aside className="w-[360px] shrink-0 border-l bg-card flex flex-col h-full min-h-0 overflow-hidden">
      {/* ─── 模块标题栏 ─── */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-2 shrink-0">
        <NotebookPenIcon className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold tracking-wide">日记</h2>
        <div className="flex-1" />
        {loading && <Loader2Icon className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => void windowApi.openDiaryBook()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
            title="在独立窗口中像翻书一样翻阅全部日记（仅展示）"
          >
            <BookOpenIcon className="w-3.5 h-3.5" />
            看日记
          </button>
        </div>
      </div>

      {/* ─── 按月日历 ─── */}
      <div className="px-3 shrink-0">
        {/* 月份导航 */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1">
            <button
              onClick={goPrevMonth}
              className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="上个月"
            >
              <ChevronLeftIcon className="w-4 h-4" />
            </button>
            <span className="text-sm font-bold tabular-nums min-w-24 text-center">
              {formatMonthTitle(viewYear, viewMonth)}
            </span>
            <button
              onClick={goNextMonth}
              className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="下个月"
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={goToday}
            className={cn(
              'px-2 py-0.5 rounded-md text-xs transition-colors shrink-0',
              isCurrentMonth
                ? 'text-muted-foreground/40 cursor-default'
                : 'text-primary hover:bg-primary/10',
            )}
            disabled={isCurrentMonth}
            title="回到今天"
          >
            今天
          </button>
        </div>

        {/* 星期表头 */}
        <div className="grid grid-cols-7 mt-2">
          {WEEKDAY_LABELS.map((w, i) => (
            <div
              key={w}
              className={cn(
                'h-7 flex items-center justify-center text-[11px]',
                i >= 5 ? 'text-destructive/70' : 'text-muted-foreground',
              )}
            >
              {w}
            </div>
          ))}
        </div>

        {/* 日期网格：点击仅切换选中日期（下方日记与任务联动），不弹窗 */}
        <div className="grid grid-cols-7 pb-2">
          {monthCells.map((day, i) => {
            if (day === 0) return <div key={`empty-${i}`} className="h-8" />
            const key = cellKey(day)
            const hasDiary = writtenSet.has(key)
            const today = key === todayKey
            const selected = key === selectedDate
            const taskDotClass = taskDotClassFor(key)
            const taskList = taskDayMap.get(key)
            const hasTasks = (!!taskList && taskList.length > 0) || (key === todayKey && todayPlannedOpen)
            const dayOpen =
              (!!taskList && taskList.some((t) => t.status !== 'done')) || (key === todayKey && todayPlannedOpen)
            const taskHint = hasTasks
              ? dayOpen
                ? key < todayKey
                  ? '有逾期未完成的任务'
                  : key === todayKey
                    ? '有今日待办任务'
                    : '有任务安排'
                : '该日任务已全部完成'
              : null
            const hint =
              [taskHint, hasDiary ? '已写日记' : null].filter(Boolean).join(' · ') ||
              '查看当日日记与任务'
            return (
              <div key={key} className="flex justify-center">
                <button
                  onClick={() => setSelectedDate(key)}
                  title={`${formatShortDate(key)} ${formatWeekdaySuffix(key)} · ${hint}`}
                  className={cn(
                    'relative w-8 h-8 rounded-lg text-[13px] tabular-nums transition-colors',
                    today
                      ? 'font-bold text-primary ring-1 ring-primary/60 ring-inset'
                      : selected
                        ? 'text-foreground bg-primary/10 ring-1 ring-primary ring-inset'
                        : hasDiary
                          ? 'text-foreground font-medium hover:bg-primary/10'
                          : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {day}
                  {/* 日记点：数字上方 */}
                  {hasDiary && (
                    <span
                      className={cn(
                        'absolute top-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full',
                        today ? 'bg-primary' : 'bg-primary/70',
                      )}
                    />
                  )}
                  {/* 任务状态点：数字下方 */}
                  {taskDotClass && (
                    <span
                      className={cn(
                        'absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full',
                        taskDotClass,
                      )}
                    />
                  )}
                </button>
              </div>
            )
          })}
        </div>

        {/* 状态点图例 */}
        <div className="px-1 pb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/70">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-destructive" />
            逾期
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
            今日
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
            未来
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
            已完成
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary/70" />
            日记
          </span>
        </div>
      </div>

      {/* ─── 滚动内容区：第一行当日日记 + 第二行当日日程 ─── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* ─── 第一行：当日日记 ─── */}
        <section className="border-t">
          <div className="px-4 py-2.5 flex items-center gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">日记</h3>
            <span
              className={cn(
                'text-[11px] px-1.5 py-px rounded tabular-nums',
                isTodayKey ? 'bg-primary/10 text-primary font-medium' : 'bg-muted text-muted-foreground',
              )}
            >
              {formatShortDate(selectedDate)} · {formatWeekdaySuffix(selectedDate)}
            </span>
            <div className="flex-1" />
            {selLoading && !selectedDiary && (
              <Loader2Icon className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
            )}
          </div>

          <div className="px-4 pb-4">
            {selLoading && !selectedDiary ? (
              <p className="text-xs text-muted-foreground/60 py-6 text-center">加载中…</p>
            ) : selectedDiary ? (
              /* 该日已有日记：关键词 + 正文预览 + 字数/时间 + 编辑入口 */
              <div className="rounded-xl border bg-background p-3">
                {selectedDiary.keywords.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {selectedDiary.keywords.map((kw) => (
                      <span
                        key={kw}
                        className="px-1.5 py-px text-[10px] rounded bg-primary/10 text-primary/80 border border-primary/15 max-w-full truncate"
                      >
                        {kw}
                      </span>
                    ))}
                  </div>
                )}

                <p
                  className={cn(
                    'text-xs text-muted-foreground leading-relaxed wrap-break-word line-clamp-3',
                    selectedDiary.keywords.length > 0 && 'mt-2',
                  )}
                >
                  {previewText || '（这篇日记没有文字内容）'}
                </p>

                <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground/60 tabular-nums">
                  <span>更新于 {formatDiaryTime(selectedDiary.updatedAt)}</span>
                  <span>{selectedDiary.wordCount.toLocaleString()} 字</span>
                </div>

                <button
                  onClick={openSelectedEditor}
                  className="mt-2.5 w-full flex items-center justify-center gap-1.5 text-xs rounded-lg border py-1.5 text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  <PenLineIcon className="w-3.5 h-3.5" />
                  编辑日记
                </button>
              </div>
            ) : (
              /* 该日尚无日记：空态 + 写日记入口 */
              <div className="rounded-xl border border-dashed p-4 text-center">
                <NotebookPenIcon className="w-5 h-5 mx-auto text-muted-foreground/40" />
                <p className="mt-2 text-xs text-muted-foreground/70">
                  {formatShortDate(selectedDate)} 还没有写日记
                </p>
                <button
                  onClick={openSelectedEditor}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary hover:bg-primary/10 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <PenLineIcon className="w-3.5 h-3.5" />
                  写这一天的日记
                </button>
              </div>
            )}
          </div>
        </section>

        {/* ─── 第二行：当日任务（任务卡数据，快速勾选完成/重开，完整操作去任务卡窗口） ─── */}
        <DayTasksPanel
          date={selectedDate}
          tasks={dayTasks}
          projectMap={projectMap}
          loading={allTasks === null}
          onToggleDone={(task) => void handleToggleTask(task)}
          onOpenTasks={() => void windowApi.openTasks()}
        />
      </div>

      {/* ─── 日记撰写 / 编辑弹窗（仅在显式点击写 / 编辑时打开） ─── */}
      {editingDate && (
        <DiaryDialog
          diaryDate={editingDate}
          onClose={() => setEditingDate(null)}
          onChanged={(savedDate) => handleDiaryChanged(savedDate)}
        />
      )}

      {/* ─── 任务完成总结弹窗（日记页快速勾选完成时） ─── */}
      {completingTask && (
        <CompleteSummaryModal
          task={completingTask}
          onCompleted={handleTaskCompleted}
          onClose={() => setCompletingTask(null)}
        />
      )}
    </aside>
  )
}
