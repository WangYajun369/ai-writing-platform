/**
 * 项目周报 / 动态（任务卡 P2）
 *
 * 依据操作日志生成近 8 周「新增 / 完成」双柱图 + 项目动态时间线。
 */
import { useEffect, useState } from 'react'
import { Activity, BarChart3, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { taskCardApi } from '@/lib/tauri-bridge'
import type { ActivityLog, ProjectView, ProjectWeeklyStat } from '@/types'

interface Props {
  project: ProjectView
  onClose: () => void
}

const WEEKS = 8

/** 动作 → 动态圆点颜色 */
const DOT: Record<string, string> = {
  'task.created': 'bg-sky-400',
  'task.completed': 'bg-emerald-400',
  'task.reopened': 'bg-amber-400',
  'task.updated': 'bg-zinc-400',
  'task.deleted': 'bg-rose-400',
  'task.restored': 'bg-teal-400',
  'task.moved': 'bg-indigo-400',
  'task.archived': 'bg-zinc-500',
  'subtask.done': 'bg-emerald-400',
  'subtask.removed': 'bg-rose-400',
  'attachment.added': 'bg-violet-400',
  'attachment.removed': 'bg-rose-400',
}

function fmtTime(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === new Date().toDateString()) return `${hh}:${mm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

function weekLabel(ws: string): string {
  const m = Number(ws.slice(5, 7))
  const d = Number(ws.slice(8, 10))
  return `${m}月${d}日`
}

export default function ProjectReportModal({ project, onClose }: Props) {
  const [stats, setStats] = useState<ProjectWeeklyStat[]>([])
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    Promise.all([
      taskCardApi.projectWeeklyStats(project.id, WEEKS),
      taskCardApi.listProjectActivity(project.id, 50),
    ])
      .then(([s, l]) => {
        if (!alive) return
        setStats(s)
        setLogs(l)
      })
      .catch(() => {
        if (alive) toast.error('加载周报数据失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [project.id])

  const thisWeek = stats.length > 0 ? stats[stats.length - 1] : null
  const last4 = stats.length > 0 ? stats.slice(-4) : []
  const sum4 = last4.reduce(
    (acc, s) => ({ created: acc.created + s.created, completed: acc.completed + s.completed }),
    { created: 0, completed: 0 },
  )
  const maxVal = Math.max(1, ...stats.flatMap((s) => [s.created, s.completed]))
  const chartH = 88

  return (
    <div
      className="fixed inset-0 z-90 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[86vh] w-[640px] max-w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1a1a1f] shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center gap-2.5 border-b border-white/8 px-5 py-3.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[16px]"
            style={{ background: project.color + '26', border: `1px solid ${project.color}44` }}
          >
            {project.icon || '📁'}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14.5px] font-semibold">{project.name} · 周报</h3>
            <p className="text-[11px] text-zinc-500">近 {WEEKS} 周新增 / 完成 · 项目动态</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/8 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex justify-center py-16 text-zinc-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              {/* 汇总卡片 */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="rounded-xl border border-white/8 bg-white/3 px-3 py-2.5">
                  <p className="text-[10.5px] text-zinc-500">本周完成</p>
                  <p className="mt-0.5 text-[20px] leading-6 font-bold tabular-nums text-emerald-300">
                    {thisWeek?.completed ?? 0}
                  </p>
                  <p className="text-[10px] text-zinc-600">新增 {thisWeek?.created ?? 0}</p>
                </div>
                <div className="rounded-xl border border-white/8 bg-white/3 px-3 py-2.5">
                  <p className="text-[10.5px] text-zinc-500">近四周完成</p>
                  <p className="mt-0.5 text-[20px] leading-6 font-bold tabular-nums text-emerald-300">
                    {sum4.completed}
                  </p>
                  <p className="text-[10px] text-zinc-600">新增 {sum4.created}</p>
                </div>
                <div className="rounded-xl border border-white/8 bg-white/3 px-3 py-2.5">
                  <p className="text-[10.5px] text-zinc-500">项目总量</p>
                  <p className="mt-0.5 text-[20px] leading-6 font-bold tabular-nums text-zinc-200">
                    {project.stats.total}
                  </p>
                  <p className="text-[10px] text-zinc-600">完成 {project.stats.done}</p>
                </div>
              </div>

              {/* 柱状图 */}
              <div className="mt-4 rounded-xl border border-white/8 bg-white/3 p-3.5">
                <p className="mb-3 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400">
                  <BarChart3 className="h-3.5 w-3.5" />
                  近 {WEEKS} 周新增 / 完成
                  <span className="ml-auto flex items-center gap-3 text-[10px] font-normal text-zinc-500">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-sm bg-emerald-400" />
                      完成
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-sm bg-sky-400/70" />
                      新增
                    </span>
                  </span>
                </p>
                {stats.length === 0 ? (
                  <p className="py-6 text-center text-[11.5px] text-zinc-600">暂无周统计</p>
                ) : (
                  <div className="flex items-end justify-between gap-1.5">
                    {stats.map((s, i) => {
                      const isCurrent = i === stats.length - 1
                      const hDone = Math.round((s.completed / maxVal) * chartH)
                      const hNew = Math.round((s.created / maxVal) * chartH)
                      return (
                        <div
                          key={s.weekStart}
                          className="flex flex-1 flex-col items-center gap-1"
                          title={`${weekLabel(s.weekStart)} 周：完成 ${s.completed}，新增 ${s.created}`}
                        >
                          <div className="flex h-[96px] w-full items-end justify-center gap-0.5">
                            <div
                              className="w-2.5 rounded-sm bg-emerald-400 transition-all"
                              style={{ height: Math.max(hDone, s.completed > 0 ? 3 : 0) }}
                            />
                            <div
                              className="w-2.5 rounded-sm bg-sky-400/60 transition-all"
                              style={{ height: Math.max(hNew, s.created > 0 ? 3 : 0) }}
                            />
                          </div>
                          <span
                            className={cn(
                              'text-[9.5px] tabular-nums',
                              isCurrent ? 'font-medium text-zinc-300' : 'text-zinc-600',
                            )}
                          >
                            {weekLabel(s.weekStart)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* 项目动态 */}
              <div className="mt-4 rounded-xl border border-white/8 bg-white/3 p-3.5">
                <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400">
                  <Activity className="h-3.5 w-3.5" />
                  项目动态
                  {logs.length > 0 && <span className="text-zinc-600">（{logs.length}）</span>}
                </p>
                {logs.length === 0 ? (
                  <p className="py-4 text-center text-[11.5px] text-zinc-600">
                    暂无动态 —— 完成或新增任务后会记录在这里
                  </p>
                ) : (
                  <ul className="max-h-64 overflow-y-auto pr-1">
                    {logs.map((l) => (
                      <li
                        key={l.id}
                        className="relative flex items-start gap-2 border-l border-white/8 pb-2 pl-3"
                      >
                        <span
                          className={cn(
                            'absolute top-[4px] left-[-3.5px] h-[7px] w-[7px] rounded-full ring-2 ring-[#1a1a1f]',
                            DOT[l.action] ?? 'bg-zinc-500',
                          )}
                        />
                        <p className="min-w-0 flex-1 text-[11.5px] leading-4 text-zinc-300">
                          {l.summary}
                        </p>
                        <span className="shrink-0 text-[10px] text-zinc-600">
                          {fmtTime(l.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
