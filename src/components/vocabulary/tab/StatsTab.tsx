/**
 * 统计 Tab — 学习概览 + 近 30 天复习量柱状图
 */
import { useMemo } from 'react'
import { BookMarkedIcon, GraduationCapIcon, ClockIcon, FlameIcon } from 'lucide-react'
import { useVocabStore } from '@/stores/vocabStore'
import { cn } from '@/lib/utils'
import { RATING_TEXT } from '../vocab-utils'

export default function StatsTab() {
  const stats = useVocabStore((s) => s.stats)

  const history = useMemo(() => stats?.reviewHistory ?? [], [stats])
  const maxCount = useMemo(() => Math.max(1, ...history.map((h) => h.count)), [history])
  const masteredRate = useMemo(() => {
    if (!stats || stats.total === 0) return 0
    return Math.round((stats.mastered / stats.total) * 100)
  }, [stats])

  if (!stats) {
    return <div className="flex h-full items-center justify-center text-[13px] text-zinc-500">统计加载中…</div>
  }

  const metrics = [
    { label: '总词数', value: stats.total, icon: BookMarkedIcon, color: 'text-sky-400' },
    { label: '学习中', value: stats.learning, icon: ClockIcon, color: 'text-indigo-400' },
    { label: '已掌握', value: stats.mastered, icon: GraduationCapIcon, color: 'text-emerald-400' },
    { label: '今日待复习', value: stats.dueToday, icon: FlameIcon, color: stats.dueToday > 0 ? 'text-red-400' : 'text-zinc-400' },
  ]

  return (
    <div className="h-full overflow-y-auto px-5 py-4 vocab-scroll">
      {/* 指标卡 */}
      <div className="grid grid-cols-4 gap-2.5">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <m.icon className={cn('h-3.5 w-3.5', m.color)} />
              {m.label}
            </div>
            <div className="mt-1 text-[22px] font-bold text-zinc-100">{m.value.toLocaleString()}</div>
          </div>
        ))}
      </div>

      {/* 掌握率 + 周新增 */}
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <div className="rounded-xl border border-white/8 bg-white/3 px-4 py-3">
          <div className="mb-1.5 text-[11px] text-zinc-500">掌握率（已掌握 / 总数）</div>
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-linear-to-r from-emerald-500 to-teal-400 transition-all"
                style={{ width: `${masteredRate}%` }}
              />
            </div>
            <span className="text-[15px] font-bold text-emerald-300">{masteredRate}%</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3 text-center">
            <div className="text-[20px] font-bold text-sky-300">{stats.newThisWeek}</div>
            <div className="mt-0.5 text-[10.5px] text-zinc-500">近 7 天新收录</div>
          </div>
          <div className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3 text-center">
            <div className="text-[20px] font-bold text-violet-300">{stats.reviewedToday}</div>
            <div className="mt-0.5 text-[10.5px] text-zinc-500">今日已复习</div>
          </div>
        </div>
      </div>

      {/* 近 30 天复习量 */}
      <div className="mt-2.5 rounded-xl border border-white/8 bg-white/3 px-4 py-3.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-medium text-zinc-300">近 30 天复习量</span>
          <span className="text-[10.5px] text-zinc-500">
            共 {history.reduce((s, h) => s + h.count, 0)} 次
          </span>
        </div>
        <div className="flex h-32 items-end gap-[3px]">
          {history.map((day, i) => {
            const today = i === history.length - 1
            return (
              <div key={day.date} className="group relative flex h-full flex-1 flex-col justify-end" title={`${day.date} · ${day.count} 次`}>
                <div
                  className={cn(
                    'w-full rounded-t-[3px] transition-all',
                    today
                      ? 'bg-linear-to-t from-sky-500 to-indigo-400'
                      : day.count > 0
                        ? 'bg-linear-to-t from-sky-500/50 to-sky-400/40 hover:from-sky-500/70 hover:to-sky-400/60'
                        : 'bg-white/5',
                  )}
                  style={{ height: day.count > 0 ? `${Math.max(8, (day.count / maxCount) * 100)}%` : '3px' }}
                />
              </div>
            )
          })}
        </div>
        <div className="mt-1.5 flex justify-between text-[9.5px] text-zinc-600">
          <span>{history[0]?.date ?? ''}</span>
          <span className="text-sky-400/70">{history[history.length - 1]?.date ?? ''}（今天）</span>
        </div>
      </div>

      {/* 关于算法 */}
      <div className="mt-2.5 rounded-xl border border-white/6 bg-white/2 px-4 py-3 text-[11px] leading-relaxed text-zinc-500">
        <span className="font-medium text-zinc-400">记忆原理：</span>
        采用艾宾浩斯遗忘曲线 + SM-2 间隔重复算法。每张卡的复习间隔按你的自评动态调整：
        {RATING_TEXT[3]}（+间隔）、{RATING_TEXT[2]}、{RATING_TEXT[1]}（缓慢增长）、{RATING_TEXT[0]}（重置重学）。
        长期答对且间隔 ≥ 30 天的词将自动标记为「已掌握」。
      </div>
    </div>
  )
}
