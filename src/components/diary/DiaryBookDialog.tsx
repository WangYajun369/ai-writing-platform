/**
 * DiaryBookDialog — 「看日记」书页式浏览弹窗（仅展示，只读）
 *
 * 像翻一本真正的书一样回看全部日记：
 * - 每次展开“左右两页”，左侧 = 较早日、右侧 = 较晚日（左旧右新）
 * - 只有写过日记的日子才占一页，无日记的日子自动跳过
 * - 打开时定位到最近写的日记；奇数篇时最后一篇单独占右页（左侧为装饰封面）
 * - 点左右箭头 / ← → 方向键往前（更早）或往后（更晚）翻
 * - 正文用 tiptap-editor 排版样式只读渲染，不可编辑
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
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

const todayKey = toDateKey(new Date())

export default function DiaryBookDialog({ onClose }: DiaryBookDialogProps) {
  /** 全部日记摘要（按日期升序，最早的在前） */
  const [metas, setMetas] = useState<DiaryMeta[] | null>(null)
  /** 当前“左页”在列表中的下标；奇数篇末篇单独成页时它即该篇下标 */
  const [leftIndex, setLeftIndex] = useState(0)
  /** 翻页方向（驱动入场动画） */
  const [dir, setDir] = useState<FlipDir>(null)
  /** 全文缓存（date → Diary） */
  const cacheRef = useRef(new Map<string, CachedDiary>())
  const [, setTick] = useState(0)

  const n = metas?.length ?? 0
  /** 最靠右的合法左页下标：奇数篇时末篇单独成右页 */
  const lastLeft = useMemo(() => {
    if (n <= 1) return 0
    return n % 2 === 1 ? n - 1 : n - 2
  }, [n])

  const showLeft = leftIndex < n - 1
  const rightIndex = Math.min(leftIndex + 1, n - 1)

  // 初次打开：加载全部摘要并定位到最近的一两篇
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await diaryApi.listAll()
        if (cancelled) return
        setMetas(list)
        const first =
          list.length <= 1 ? 0 : list.length % 2 === 1 ? list.length - 1 : list.length - 2
        setLeftIndex(first)
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

  // 当前两页正文 + 相邻两页预取
  useEffect(() => {
    if (!metas || n === 0) return
    const dates = [metas[rightIndex].diaryDate]
    if (showLeft) dates.push(metas[leftIndex].diaryDate)
    if (leftIndex - 2 >= 0) dates.push(metas[leftIndex - 2].diaryDate, metas[leftIndex - 1].diaryDate)
    if (leftIndex + 2 <= lastLeft) {
      dates.push(metas[leftIndex + 2]?.diaryDate, metas[leftIndex + 3]?.diaryDate)
    }
    for (const d of dates) {
      if (d) void loadDate(d)
    }
  }, [metas, leftIndex, lastLeft, n, rightIndex, showLeft, loadDate])

  const canPrev = leftIndex > 0
  const canNext = leftIndex < lastLeft
  const pageTotal = Math.max(1, Math.ceil(n / 2))
  const pageNo = n === 0 ? 0 : 1 + Math.floor((lastLeft - leftIndex) / 2)

  const goPrev = useCallback(() => {
    if (leftIndex <= 0) return
    setDir('prev')
    setLeftIndex((l) => Math.max(0, l - 2))
  }, [leftIndex])
  const goNext = useCallback(() => {
    if (leftIndex >= lastLeft) return
    setDir('next')
    setLeftIndex((l) => Math.min(lastLeft, l + 2))
  }, [leftIndex, lastLeft])

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
    const diary = !loading && cached !== 'pending' ? cached : null
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

  /** 左侧装饰封面（最末一篇单独占右页时使用） */
  const renderCoverPage = () => (
    <div className="flex-1 min-w-0 h-full rounded-l-2xl border-r border-border/60 bg-background flex flex-col items-center justify-center gap-3 text-muted-foreground/45 select-none shadow-[inset_-14px_0_16px_-16px_rgba(0,0,0,0.25)]">
      <BookOpenIcon className="w-10 h-10" />
      <p className="text-xs tracking-[0.3em]">翻 阅 · 记 录 日 常</p>
      <p className="text-[10px] text-muted-foreground/40">这已经是最近的一篇日记了</p>
    </div>
  )

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

  const leftMeta = showLeft ? metas[leftIndex] : null
  const rightMeta = metas[rightIndex]
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

          {/* 展开的书：左旧右新 */}
          <div key={`${leftIndex}-${dir ?? 'init'}`} className={cn('h-full w-full max-w-[1060px] flex', animCls)}>
            {/* 左半区 */}
            <div className="flex-1 min-w-0 flex">
              {leftMeta ? renderDiaryPage(leftMeta, 'left') : renderCoverPage()}
            </div>

            {/* 书脊 */}
            <div className="w-9 shrink-0 relative z-10">
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-linear-to-b from-transparent via-border to-transparent" />
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 ml-1.5 w-1.5 bg-linear-to-b from-transparent via-black/10 to-transparent" />
            </div>

            {/* 右半区 */}
            <div className="flex-1 min-w-0 flex">
              {renderDiaryPage(rightMeta, 'right')}
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
