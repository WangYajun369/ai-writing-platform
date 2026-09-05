/**
 * WritingStatsPanel — 编辑器状态栏写作统计（Phase 4 问题 24）
 *
 * 展示：今日已写 / 日更目标进度条、连续写作天数；悬停/点击展开近 30 日
 * 字数迷你柱状图。保存成功后（lastSaved 变化）自动刷新数据。
 */
import { useCallback, useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { lastSavedAtom } from '@/stores/uiAtoms'
import { useCurrentBook } from '@/stores/appStore'
import { writingApi, type WritingStatsPayload } from '@/lib/tauri-bridge'
import { formatWordCount } from '@/lib/utils'
import { BarChart3Icon, FlameIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const CHART_HEIGHT = 52

export default function WritingStatsPanel() {
  const book = useCurrentBook()
  const lastSaved = useAtomValue(lastSavedAtom)
  const [stats, setStats] = useState<WritingStatsPayload | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async (bookId: string) => {
    try {
      const data = await writingApi.getWritingStats(bookId)
      setStats(data)
    } catch (err) {
      console.warn('[WritingStatsPanel] 获取写作统计失败:', err)
      setStats(null)
    }
  }, [])

  // 书籍切换 / 每次保存成功后刷新
  useEffect(() => {
    if (!book?.id) {
      setStats(null)
      return
    }
    void refresh(book.id)
  }, [book?.id, lastSaved, refresh])

  if (!book || !stats) return null

  const { dailyTarget, todayWords, streakDays, lastDays } = stats
  const ratio = dailyTarget > 0 ? Math.min(1, todayWords / dailyTarget) : 0
  const maxWords = Math.max(1, ...lastDays.map((d) => d.words), dailyTarget)
  const hasGoal = dailyTarget > 0

  return (
    <div className="relative flex items-center shrink-0">
      {/* 今日统计 + 目标进度条 */}
      <button
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起字数曲线' : '展开近 30 日字数曲线'}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted/70 transition-colors"
      >
        <BarChart3Icon className="w-3 h-3" />
        <span className="tabular-nums">
          今日 {formatWordCount(todayWords)}
          {hasGoal && <span className="opacity-70"> / {formatWordCount(dailyTarget)}</span>}
        </span>
        {hasGoal && (
          <span className="inline-block w-14 h-1.5 rounded-full bg-muted overflow-hidden align-middle">
            <span
              className={cn(
                'block h-full rounded-full transition-all',
                ratio >= 1 ? 'bg-green-500' : 'bg-primary',
              )}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </span>
        )}
        {streakDays > 0 && (
          <span
            title={`连续写作 ${streakDays} 天`}
            className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
          >
            <FlameIcon className="w-3 h-3" />
            <span className="tabular-nums">{streakDays}</span>
          </span>
        )}
      </button>

      {/* 近 30 日迷你柱状图弹层 */}
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full z-20 mb-1 rounded-lg border bg-popover text-popover-foreground shadow-md p-2.5">
            <div className="text-[10px] text-muted-foreground mb-1.5 flex items-center justify-between gap-6">
              <span>近 30 日每日新增字数</span>
              <span className="tabular-nums">峰值 {formatWordCount(maxWords)}</span>
            </div>
            <div className="flex items-end gap-[2px]" style={{ height: CHART_HEIGHT }}>
              {lastDays.map((d) => {
                const h = Math.max(2, Math.round((d.words / maxWords) * CHART_HEIGHT))
                const isToday = d.date === lastDays[lastDays.length - 1]?.date
                return (
                  <div
                    key={d.date}
                    title={`${d.date}：${formatWordCount(d.words)}`}
                    className={cn(
                      'flex-1 rounded-sm transition-colors',
                      d.words > 0
                        ? isToday
                          ? 'bg-primary'
                          : 'bg-primary/40 hover:bg-primary/70'
                        : 'bg-muted-foreground/10',
                    )}
                    style={{ height: h }}
                  />
                )
              })}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 flex justify-between">
              <span>{lastDays[0]?.date.slice(5)}</span>
              <span>今日 {lastDays[lastDays.length - 1]?.date.slice(5)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
