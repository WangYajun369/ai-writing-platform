/**
 * DiaryPanel — 首页右侧「日记 + 个人日程管理」模块
 *
 * 布局（自上而下）：
 * - 模块标题栏 + 「今日日记」快捷入口
 * - 按月日历（点击某天：仅将下方切换到该日的日记与日程，不自动弹窗）
 * - 第一行「日记」：所选日期的日记卡片（无日记则显示空态写日记入口，
 *   点击「写日记 / 编辑日记」才打开 DiaryDialog）
 * - 第二行「个人日程管理」：所选日期的日程（新增 / 完成 / 删除 / 双击编辑）
 *
 * 点击任意日期后，下方两行内容同步切换到那一天。
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
import { diaryApi, scheduleApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
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
import type { Diary, DiaryMeta, Schedule } from '@/types'
import DiaryDialog from './DiaryDialog'
import ScheduleManager from './ScheduleManager'
import DiaryBookDialog from './DiaryBookDialog'

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
  /** 当前视图月的全部日程（用于日历日程状态点） */
  const [monthSchedules, setMonthSchedules] = useState<Schedule[]>([])
  /** 当前选中的日期（驱动下方日记与日程两行联动切换） */
  const [selectedDate, setSelectedDate] = useState<string>(todayKey)
  /** 选中日期当天的日记全文（无则为 null） */
  const [selectedDiary, setSelectedDiary] = useState<Diary | null>(null)
  const [selLoading, setSelLoading] = useState(false)
  /** 正在编辑的日期（控制 DiaryDialog 开关） */
  const [editingDate, setEditingDate] = useState<string | null>(null)
  /** 「看日记」书页式浏览弹窗开关 */
  const [bookOpen, setBookOpen] = useState(false)
  /** 请求序号：避免快速切换日期时旧请求覆盖新结果 */
  const selectedReqRef = useRef(0)

  const loadEntries = useCallback(async (year: number, month: number) => {
    setLoading(true)
    try {
      const list = await diaryApi.listMonth(year, month)
      setEntries(list)
    } catch (err) {
      console.error('加载日记列表失败', err)
      toast.error(`加载日记列表失败：${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [])

  /** 加载当前视图月的全部日程（供日历状态点使用） */
  const loadMonthSchedules = useCallback(async (year: number, month: number) => {
    try {
      const list = await scheduleApi.listMonth(year, month)
      setMonthSchedules(list)
    } catch (err) {
      console.error('加载当月日程失败', err)
      toast.error(`加载当月日程失败：${err instanceof Error ? err.message : err}`)
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
        toast.error(`加载日记失败：${err instanceof Error ? err.message : err}`)
      }
    }
  }, [])

  // 切换年月后自动重新加载该月日记与日程
  useEffect(() => {
    void loadEntries(viewYear, viewMonth)
    void loadMonthSchedules(viewYear, viewMonth)
  }, [viewYear, viewMonth, loadEntries, loadMonthSchedules])

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
  /** 打开“今天”的日记编辑窗，并把视图切回本月 */
  const writeToday = () => {
    const now = new Date()
    setViewYear(now.getFullYear())
    setViewMonth(now.getMonth() + 1)
    setSelectedDate(todayKey)
    setEditingDate(todayKey)
  }

  /** 本月已写日记的日期集合（日历圆点） */
  const writtenSet = useMemo(() => new Set(entries.map((e) => e.diaryDate)), [entries])
  /** 日程按日期分组 */
  const scheduleMap = useMemo(() => {
    const map = new Map<string, Schedule[]>()
    for (const s of monthSchedules) {
      const arr = map.get(s.scheduleDate)
      if (arr) arr.push(s)
      else map.set(s.scheduleDate, [s])
    }
    return map
  }, [monthSchedules])

  /**
   * 某日期“数字下方”的日程状态点颜色（有日程才显示）：
   * 过去有未完成=红 / 过去全部完成=灰 / 今天=绿 / 未来=蓝
   */
  const schedDotClassFor = (key: string): string | null => {
    const list = scheduleMap.get(key)
    if (!list || list.length === 0) return null
    if (key < todayKey) {
      return list.some((s) => !s.done) ? 'bg-destructive' : 'bg-muted-foreground/40'
    }
    if (key === todayKey) return 'bg-green-500'
    return 'bg-blue-500'
  }
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
            onClick={() => setBookOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
            title="像翻书一样翻阅全部日记（仅展示）"
          >
            <BookOpenIcon className="w-3.5 h-3.5" />
            看日记
          </button>
          <button
            onClick={writeToday}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="写 / 编辑今日日记"
          >
            <PenLineIcon className="w-3.5 h-3.5" />
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

        {/* 日期网格：点击仅切换选中日期（下方日记与日程联动），不弹窗 */}
        <div className="grid grid-cols-7 pb-2">
          {monthCells.map((day, i) => {
            if (day === 0) return <div key={`empty-${i}`} className="h-8" />
            const key = cellKey(day)
            const hasDiary = writtenSet.has(key)
            const today = key === todayKey
            const selected = key === selectedDate
            const schedDotClass = schedDotClassFor(key)
            const schedList = scheduleMap.get(key)
            const hasSched = !!schedList && schedList.length > 0
            const schedHint = hasSched
              ? key < todayKey
                ? schedList!.some((s) => !s.done)
                  ? '有逾期未完成的日程'
                  : '该日日程已全部完成'
                : key === todayKey
                  ? '有今日日程'
                  : '有未来日程安排'
              : null
            const hint =
              [schedHint, hasDiary ? '已写日记' : null].filter(Boolean).join(' · ') ||
              '查看当日日记与日程'
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
                  {/* 日程状态点：数字下方 */}
                  {schedDotClass && (
                    <span
                      className={cn(
                        'absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full',
                        schedDotClass,
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

        {/* ─── 第二行：当日个人日程管理 ─── */}
        <ScheduleManager
          date={selectedDate}
          onChanged={() => void loadMonthSchedules(viewYear, viewMonth)}
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

      {/* ─── 「看日记」书页式只读浏览弹窗 ─── */}
      {bookOpen && <DiaryBookDialog onClose={() => setBookOpen(false)} />}
    </aside>
  )
}
