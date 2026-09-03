/**
 * DiaryBookDialog — 「看日记」书页式浏览弹窗（仅展示，只读）
 *
 * 像翻一本真正的书一样回看全部日记：
 * - 按月分章：每个月从新的一页开始，左侧为空白页、右侧为该月第一篇日记
 * - 同月内日记左右两篇成页（左旧右新），页面按时间顺序向前/向后流动
 * - 月份结束时若剩单篇，则单独占左半页（右半页留白）
 * - 打开时定位到「本月第一篇」所在书页（左空白、右日记）；本月无日记则落到最近一个有日记的月份
 * - 顶栏年月选择器可跳转到任意有日记月份的开篇页
 * - 点左右箭头 / ← → 方向键往前（更早）或往后（更晚）翻
 * - 正文用 tiptap-editor 排版样式只读渲染，不可编辑
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FeatherIcon,
  Loader2Icon,
  NotebookPenIcon,
  XIcon,
} from 'lucide-react'
import { diaryApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { formatDiaryTime, formatFullDateLabel, toDateKey } from '@/lib/diary-utils'
import type { Diary, DiaryMeta } from '@/types'

interface DiaryBookDialogProps {
  onClose: () => void
}

/** 缓存中日记内容的状态：'pending' = 加载中，null = 该日无记录 */
type CachedDiary = Diary | null | 'pending'

/** 翻页动画方向 */
type FlipDir = 'prev' | 'next' | null

/** 一页展开的双页：left/right 为 metas 下标，null 表示该半页留白 */
type BookPage = { left: number | null; right: number | null }

const todayKey = toDateKey(new Date())

/** 提取日期所属的年月键 'YYYY-MM' */
const ymOfDate = (date: string) => date.slice(0, 7)

/** 月份中文名（index 0 → 一月） */
const zhMonths = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

export default function DiaryBookDialog({ onClose }: DiaryBookDialogProps) {
  /** 全部日记摘要（按日期升序，最早的在前） */
  const [metas, setMetas] = useState<DiaryMeta[] | null>(null)
  /** 当前展开书页在 pages 中的下标 */
  const [pageIdx, setPageIdx] = useState(0)
  /** 翻页方向（驱动入场动画） */
  const [dir, setDir] = useState<FlipDir>(null)
  /** 全文缓存（date → Diary） */
  const cacheRef = useRef(new Map<string, CachedDiary>())
  const [, setTick] = useState(0)

  const n = metas?.length ?? 0

  /**
   * 把日记列表排成书页（按月分章）：
   * - 每个月的第一篇总是新起一页：左半页留白、右半页为当月第一篇
   * - 同月其余日记依次填入“左 → 右”成页；某月结束时若剩单篇，则单独占左半页
   */
  const pages = useMemo<BookPage[]>(() => {
    if (!metas || metas.length === 0) return []
    const out: BookPage[] = []
    let cur: BookPage | null = null
    const closeCur = () => {
      if (cur) {
        out.push(cur)
        cur = null
      }
    }
    let prevKey: string | null = null
    metas.forEach((m, i) => {
      const key = ymOfDate(m.diaryDate)
      const monthStart = key !== prevKey
      prevKey = key
      if (monthStart) {
        closeCur()
        out.push({ left: null, right: i })
        return
      }
      if (!cur) cur = { left: null, right: null }
      if (cur.left === null) cur.left = i
      else {
        cur.right = i
        closeCur()
      }
    })
    closeCur()
    return out
  }, [metas])

  // 初次打开：加载全部摘要
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await diaryApi.listAll()
        if (cancelled) return
        setMetas(list)
      } catch (err) {
        console.error('加载日记目录失败', err)
        toast.error(`加载日记失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 按日期加载/复用全文 */
  const loadDate = useCallback(async (date: string) => {
    if (cacheRef.current.has(date)) return
    cacheRef.current.set(date, 'pending')
    setTick((t) => t + 1)
    try {
      const data = await diaryApi.get(date)
      cacheRef.current.set(date, data)
    } catch (err) {
      console.error(`加载 ${date} 日记失败`, err)
      cacheRef.current.set(date, null)
    } finally {
      setTick((t) => t + 1)
    }
  }, [])

  // 当前书页正文 + 相邻两页预取
  useEffect(() => {
    if (!metas || pages.length === 0) return
    const idxs = new Set<number>()
    const collect = (pg: BookPage | undefined) => {
      if (!pg) return
      if (pg.left != null) idxs.add(pg.left)
      if (pg.right != null) idxs.add(pg.right)
    }
    collect(pages[pageIdx])
    collect(pages[pageIdx - 1])
    collect(pages[pageIdx + 1])
    for (const i of idxs) void loadDate(metas[i].diaryDate)
  }, [metas, pages, pageIdx, loadDate])

  const canPrev = pageIdx > 0
  const canNext = pageIdx < pages.length - 1
  const pageTotal = Math.max(1, pages.length)
  const pageNo = pages.length === 0 ? 0 : pageIdx + 1

  const goPrev = useCallback(() => {
    if (pageIdx <= 0) return
    setDir('prev')
    setPageIdx(pageIdx - 1)
  }, [pageIdx])
  const goNext = useCallback(() => {
    if (pageIdx >= pages.length - 1) return
    setDir('next')
    setPageIdx(pageIdx + 1)
  }, [pageIdx, pages.length])

  /** 已写过日记的月份（按时间升序）及各自篇数，供年月选择器使用 */
  const months = useMemo(() => {
    if (!metas) return []
    const out: { key: string; label: string; count: number }[] = []
    for (const m of metas) {
      const key = ymOfDate(m.diaryDate)
      const last = out[out.length - 1]
      if (last && last.key === key) last.count += 1
      else {
        const [y, mo] = key.split('-').map(Number)
        out.push({ key, label: `${y}年${mo}月`, count: 1 })
      }
    }
    return out
  }, [metas])

  /** 首次定位：打开到「本月（无则最近有日记的月份）第一篇」的开篇页，即左空白、右为该月第一篇 */
  const positionedRef = useRef(false)
  useEffect(() => {
    if (positionedRef.current || !metas || n === 0 || pages.length === 0) return
    positionedRef.current = true
    const thisMonth = ymOfDate(todayKey)
    const month = months.find((m) => m.key === thisMonth) ?? months[months.length - 1]
    const i = metas.findIndex((m) => ymOfDate(m.diaryDate) === month.key)
    const target = pages.findIndex((pg) => pg.left === i || pg.right === i)
    setPageIdx(target >= 0 ? target : 0)
  }, [metas, n, pages, months])

  /** 当前书页“最早出现”的那篇所属月份（年月选择器当前值） */
  const viewMonthKey = useMemo(() => {
    if (!metas || pages.length === 0) return ''
    const pg = pages[Math.min(pageIdx, pages.length - 1)]
    const di = pg.left ?? pg.right
    if (di == null) return ''
    return ymOfDate(metas[di].diaryDate)
  }, [metas, pages, pageIdx])

  /** 跳到某月第一篇日记的开篇页 */
  const jumpToMonth = useCallback(
    (key: string) => {
      if (!metas || n === 0 || pages.length === 0) return
      const i = metas.findIndex((m) => ymOfDate(m.diaryDate) === key)
      if (i < 0) return
      const target = pages.findIndex((pg) => pg.left === i || pg.right === i)
      if (target < 0 || target === pageIdx) return
      setDir(target > pageIdx ? 'next' : 'prev')
      setPageIdx(target)
    },
    [metas, n, pages, pageIdx],
  )

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const goPrevRef = useRef(goPrev)
  goPrevRef.current = goPrev
  const goNextRef = useRef(goNext)
  goNextRef.current = goNext

  // 键盘：Esc 关闭，← 更早 / → 更晚
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseRef.current()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrevRef.current()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNextRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** 渲染一页日记（仅展示） */
  const renderDiaryPage = (meta: DiaryMeta, side: 'left' | 'right') => {
    const cached = cacheRef.current.get(meta.diaryDate) as CachedDiary | undefined
    const loading = cached === undefined || cached === 'pending'
    const diary = cached !== undefined && cached !== 'pending' ? cached : null
    const isToday = meta.diaryDate === todayKey
    return (
      <div
        key={meta.diaryDate}
        className={cn(
          'flex-1 min-w-0 h-full flex flex-col bg-background border-border/60',
          side === 'left'
            ? 'rounded-l-2xl border-r shadow-[inset_-14px_0_16px_-16px_rgba(0,0,0,0.3)]'
            : 'rounded-r-2xl border-l shadow-[inset_14px_0_16px_-16px_rgba(0,0,0,0.3)]',
        )}
      >
        {/* 页眉：日期标题 */}
        <div className="px-6 pt-5 pb-1 shrink-0 text-center">
          <h3 className="text-sm font-bold tracking-wide inline-flex items-center gap-2 whitespace-nowrap">
            {formatFullDateLabel(meta.diaryDate)}
            {isToday && (
              <span className="text-[10px] px-1.5 py-px rounded-full bg-primary/15 text-primary font-medium">
                今天
              </span>
            )}
          </h3>
        </div>
        <div className="px-6 pb-2 shrink-0">
          <div className="h-px bg-linear-to-r from-transparent via-border/80 to-transparent" />
        </div>

        {loading ? (
          /* 加载占位 */
          <div className="flex-1 min-h-0 px-6 py-4 space-y-3 overflow-hidden">
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-3 w-full rounded bg-muted animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
          </div>
        ) : diary && diary.contentHtml ? (
          /* 只读正文（tiptap 排版样式） */
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-3">
            {diary.keywords.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 mb-2">
                {diary.keywords.map((kw) => (
                  <span
                    key={kw}
                    className="px-1.5 py-px text-[10px] rounded bg-primary/10 text-primary/80 border border-primary/15 whitespace-nowrap"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            )}
            {/* 内容为本地存储的 TipTap HTML（自生成，含内嵌图），只读渲染 */}
            <div
              className="tiptap-editor"
              style={{ fontSize: 'var(--font-editor-size, 15px)' }}
              dangerouslySetInnerHTML={{ __html: diary.contentHtml }}
            />
          </div>
        ) : (
          /* 正文缺失兜底 */
          <div className="flex-1 min-h-0 flex items-center justify-center text-xs text-muted-foreground/60">
            （内容加载失败，请稍后重试）
          </div>
        )}

        {/* 页脚：字数与更新时间 */}
        <div className="px-6 py-2.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
          {diary ? (
            <>
              <span>{diary.wordCount.toLocaleString()} 字</span>
              <span className="flex-1 border-t border-dashed border-border/70" />
              <span>更新于 {formatDiaryTime(diary.updatedAt)}</span>
            </>
          ) : (
            <span className="flex-1" />
          )}
        </div>
      </div>
    )
  }

  /**
   * 装饰空白页（对开留白）：
   * - 左侧空白 = 新月份开篇页，右侧为该月第一篇日记
   * - 右侧空白 = 月份收尾（单篇占左页时）
   * 用 neighbor（对侧那篇日记）标出所属年月，做成素雅的“纸张扉页”
   */
  const renderBlankPage = (side: 'left' | 'right', neighbor: DiaryMeta | null) => {
    const keyOf = neighbor ? ymOfDate(neighbor.diaryDate) : ''
    const [year, monthNum] = keyOf ? keyOf.split('-').map(Number) : [null, null]
    const zhMonth = monthNum ? `${zhMonths[monthNum - 1]}月` : '时光'
    const opener = side === 'left'
    return (
      <div
        key={`blank-${side}`}
        className={cn(
          'relative flex-1 min-w-0 h-full overflow-hidden bg-background border-border/60 select-none',
          side === 'left'
            ? 'rounded-l-2xl border-r shadow-[inset_-14px_0_16px_-16px_rgba(0,0,0,0.25)]'
            : 'rounded-r-2xl border-l shadow-[inset_14px_0_16px_-16px_rgba(0,0,0,0.25)]',
        )}
      >
        {/* 纸张质感：上缘柔光 + 淡淡纵向明暗，模拟纸页起伏 */}
        <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-foreground/4 via-transparent to-foreground/2" />
        {/* 内框装饰线，呼应版面 */}
        <div className="pointer-events-none absolute inset-5 rounded-lg border border-foreground/5" />

        {/* 中央扉页内容 */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-8 py-10 text-center">
          {/* 圆环 + 羽毛笔 */}
          <div className="relative h-20 w-20">
            <div className="absolute inset-0 rounded-full border border-foreground/10" />
            <div className="absolute inset-[7px] rounded-full border border-dashed border-foreground/7" />
            <div className="absolute inset-0 flex items-center justify-center">
              <FeatherIcon className={cn('h-7 w-7 text-primary/40', side === 'right' && '-scale-x-100')} />
            </div>
          </div>

          {/* 年月 */}
          <div className="leading-tight">
            <p className="text-[11px] tracking-[0.5em] pl-[0.5em] text-muted-foreground/40">
              {year ?? ''}
            </p>
            <p className="mt-1.5 text-4xl font-light tracking-[0.3em] pl-[0.3em] text-muted-foreground/30">
              {zhMonth}
            </p>
          </div>

          {/* 点缀分割 */}
          <div className="flex items-center gap-2 text-muted-foreground/25">
            <span className="h-px w-8 bg-current" />
            <span className="h-1 w-1 rotate-45 bg-current" />
            <span className="h-px w-8 bg-current" />
          </div>

          {/* 页语 */}
          <p className="text-[11px] tracking-[0.35em] pl-[0.35em] text-muted-foreground/45">
            {opener ? '新 的 一 月' : '本 月 终 章'}
          </p>
        </div>

        {/* 底部留白小点 */}
        <div className="pointer-events-none absolute bottom-4 inset-x-0 flex items-center justify-center gap-1.5 text-foreground/10">
          <span className="h-1 w-1 rounded-full bg-current" />
          <span className="h-1 w-1 rounded-full bg-current" />
          <span className="h-1 w-1 rounded-full bg-current" />
        </div>
      </div>
    )
  }

  // ── 目录加载中 ──
  if (metas === null) {
    return (
      <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-6">
        <div className="w-[min(560px,92vw)] bg-background rounded-2xl border shadow-2xl h-[min(50vh,420px)] flex flex-col items-center justify-center gap-3">
          <Loader2Icon className="w-6 h-6 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">正在打开日记…</p>
        </div>
      </div>
    )
  }

  // ── 一篇日记都没有 ──
  if (n === 0) {
    return (
      <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-6">
        <div className="relative w-[min(560px,92vw)] bg-background rounded-2xl border shadow-2xl flex flex-col items-center justify-center gap-3 py-16 px-8">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="关闭 (Esc)"
          >
            <XIcon className="w-4 h-4" />
          </button>
          <NotebookPenIcon className="w-8 h-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">还没有写过日记</p>
          <p className="text-xs text-muted-foreground/60">
            在日历上选中某一天，点击「写这一天的日记」开始记录
          </p>
        </div>
      </div>
    )
  }

  const curPage = pages[Math.min(pageIdx, pages.length - 1)]
  const leftMeta = curPage.left != null ? metas[curPage.left] : null
  const rightMeta = curPage.right != null ? metas[curPage.right] : null
  const animCls = dir === 'prev' ? 'diary-anim-prev' : dir === 'next' ? 'diary-anim-next' : ''

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-background rounded-2xl border shadow-2xl flex flex-col overflow-hidden w-[min(1200px,96vw)] h-[min(84vh,780px)]">
        {/* ─── 顶栏 ─── */}
        <div className="h-11 px-3 border-b bg-card flex items-center gap-2 shrink-0">
          <BookOpenIcon className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-semibold">看日记</span>
          <span className="text-[10px] px-1.5 py-px rounded-full bg-muted text-muted-foreground shrink-0">
            仅展示
          </span>
          <div className="flex-1" />

          {/* 翻页控件 */}
          <div className="flex items-center gap-1">
            <button
              onClick={goPrev}
              disabled={!canPrev}
              title="翻向更早（←）"
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
            >
              <ChevronLeftIcon className="w-4 h-4" />
            </button>
            <span className="text-xs text-muted-foreground/90 tabular-nums whitespace-nowrap px-1">
              第 {pageNo} / {pageTotal} 页 · 共 {n} 篇
            </span>
            <button
              onClick={goNext}
              disabled={!canNext}
              title="翻向更晚（→）"
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          </div>

          {/* 年月选择：跳转到该月第一篇日记 */}
          {months.length > 1 && (
            <select
              value={viewMonthKey}
              onChange={(e) => jumpToMonth(e.target.value)}
              title="跳到有日记的月份"
              className="ml-1 h-7 max-w-44 rounded-lg bg-muted px-2 text-xs text-muted-foreground outline-none cursor-pointer whitespace-nowrap"
            >
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label} · {m.count} 篇
                </option>
              ))}
            </select>
          )}

          <div className="w-px h-5 bg-border mx-0.5 shrink-0" />

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
            title="关闭 (Esc)"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* ─── 书页主体 ─── */}
        <div className="flex-1 min-h-0 relative flex items-center justify-center px-12 py-5 bg-muted/15">
          {/* 左右浮动翻页大按钮 */}
          <button
            onClick={goPrev}
            disabled={!canPrev}
            title="翻向更早"
            className={cn(
              'absolute left-2 top-1/2 -translate-y-1/2 z-10 w-9 h-16 rounded-lg border bg-background/90 shadow-md flex items-center justify-center transition-colors',
              canPrev
                ? 'text-foreground hover:bg-primary hover:text-primary-foreground'
                : 'text-muted-foreground/30 cursor-not-allowed',
            )}
          >
            <ChevronLeftIcon className="w-5 h-5" />
          </button>
          <button
            onClick={goNext}
            disabled={!canNext}
            title="翻向更晚"
            className={cn(
              'absolute right-2 top-1/2 -translate-y-1/2 z-10 w-9 h-16 rounded-lg border bg-background/90 shadow-md flex items-center justify-center transition-colors',
              canNext
                ? 'text-foreground hover:bg-primary hover:text-primary-foreground'
                : 'text-muted-foreground/30 cursor-not-allowed',
            )}
          >
            <ChevronRightIcon className="w-5 h-5" />
          </button>

          {/* 展开的书：按月分章，左旧右新，无内容的一侧留白 */}
          <div key={`${pageIdx}-${dir ?? 'init'}`} className={cn('h-full w-full max-w-[1060px] flex', animCls)}>
            {/* 左半区 */}
            <div className="flex-1 min-w-0 flex">
              {leftMeta ? renderDiaryPage(leftMeta, 'left') : renderBlankPage('left', rightMeta)}
            </div>

            {/* 书脊 */}
            <div className="w-9 shrink-0 relative z-10">
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-linear-to-b from-transparent via-border to-transparent" />
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 ml-1.5 w-1.5 bg-linear-to-b from-transparent via-black/10 to-transparent" />
            </div>

            {/* 右半区 */}
            <div className="flex-1 min-w-0 flex">
              {rightMeta ? renderDiaryPage(rightMeta, 'right') : renderBlankPage('right', leftMeta)}
            </div>
          </div>

          {/* 翻页入场动画（局部样式，不污染全局） */}
          <style>{`
            @keyframes diaryPageInNext { from { opacity: 0.25; transform: translateX(28px); } to { opacity: 1; transform: none; } }
            @keyframes diaryPageInPrev { from { opacity: 0.25; transform: translateX(-28px); } to { opacity: 1; transform: none; } }
            .diary-anim-next { animation: diaryPageInNext 260ms ease-out; }
            .diary-anim-prev { animation: diaryPageInPrev 260ms ease-out; }
          `}</style>
        </div>

        {/* ─── 底栏 ─── */}
        <div className="h-8 px-4 border-t bg-card flex items-center justify-center gap-3 text-[11px] text-muted-foreground/70 shrink-0">
          <span>← → 方向键或点击两侧箭头翻页</span>
          <span className="text-muted-foreground/25">·</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
