/**
 * 操作记录 / 执行时间线（任务卡 P2）
 *
 * 任务详情内折叠展示动态时间线（创建/完成/重新打开/更新/删除/恢复/子任务/附件等），
 * 数据来自后端操作日志表（task_activity_logs），最新在前。
 */
import { useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { taskCardApi } from '@/lib/tauri-bridge'
import type { ActivityLog } from '@/types'

interface Props {
  taskId: string
  limit?: number
}

function fmtTime(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === new Date().toDateString()) return `${hh}:${mm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

/** 动作 → 时间线圆点颜色 */
const DOT: Record<string, string> = {
  'task.created': 'bg-sky-400',
  'task.completed': 'bg-emerald-400',
  'task.reopened': 'bg-amber-400',
  'task.updated': 'bg-zinc-400',
  'task.deleted': 'bg-rose-400',
  'task.restored': 'bg-teal-400',
  'task.moved': 'bg-indigo-400',
  'task.archived': 'bg-zinc-500',
  'subtask.added': 'bg-lime-400',
  'subtask.done': 'bg-emerald-400',
  'subtask.redone': 'bg-zinc-400',
  'subtask.updated': 'bg-zinc-400',
  'subtask.removed': 'bg-rose-400',
  'attachment.added': 'bg-violet-400',
  'attachment.removed': 'bg-rose-400',
}

export default function ActivityTimeline({ taskId, limit = 20 }: Props) {
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    taskCardApi
      .listTaskActivity(taskId, limit)
      .then((list) => {
        if (alive) setLogs(list)
      })
      .catch(() => {
        if (alive) toast.error('加载操作记录失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  return (
    <details className="rounded-lg border border-white/8 bg-white/3 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11.5px] font-medium text-zinc-500 select-none">
        <History className="h-3 w-3" />
        操作记录{logs.length > 0 ? `（${logs.length}）` : ''}
      </summary>
      <div className="mt-2 max-h-44 space-y-0 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex justify-center py-2 text-zinc-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </div>
        ) : logs.length === 0 ? (
          <p className="py-1 text-[11.5px] text-zinc-600">暂无操作记录</p>
        ) : (
          <ul>
            {logs.map((l) => (
              <li key={l.id} className="relative flex items-start gap-2 border-l border-white/8 pb-2 pl-3">
                <span
                  className={cn(
                    'absolute top-[3px] left-[-3.5px] h-[7px] w-[7px] rounded-full ring-2 ring-[#18181b]',
                    DOT[l.action] ?? 'bg-zinc-500',
                  )}
                />
                <p className="min-w-0 flex-1 text-[11.5px] leading-4 text-zinc-300">{l.summary}</p>
                <span className="shrink-0 text-[10px] text-zinc-600">{fmtTime(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
