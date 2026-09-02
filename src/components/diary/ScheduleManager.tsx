/**
 * ScheduleManager — 个人日程管理
 *
 * 按日期展示、添加、完成、删除、编辑日程。
 * 切换日期时自动重新加载对应日期的日程列表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckIcon, Loader2Icon, PlusIcon, Trash2Icon } from 'lucide-react'
import { scheduleApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { formatShortDate } from '@/lib/diary-utils'
import type { Schedule } from '@/types'

interface ScheduleManagerProps {
  /** 当前要选中日程的日期 YYYY-MM-DD */
  date: string
  /** 日程数据发生变更（增删改、完成切换）后通知父级刷新日历状态点 */
  onChanged?: () => void
}

export default function ScheduleManager({ date, onChanged }: ScheduleManagerProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(false)
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)

  /** 正在编辑的日程 id 与内容 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')

  // 引用保持最新（供异步回调使用）
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await scheduleApi.listByDate(date)
      setSchedules(list)
    } catch (err) {
      console.error('加载日程失败', err)
      toast.error(`加载日程失败：${err instanceof Error ? err.message : err}`)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    void load()
  }, [load])

  const handleAdd = async () => {
    const content = input.trim()
    if (!content) return
    setAdding(true)
    try {
      const saved = await scheduleApi.save({ scheduleDate: date, content, done: false })
      setSchedules((prev) => [...prev, saved])
      setInput('')
      onChangedRef.current?.()
    } catch (err) {
      console.error('添加日程失败', err)
      toast.error(`添加日程失败：${err instanceof Error ? err.message : err}`)
    } finally {
      setAdding(false)
    }
  }

  const toggleDone = async (item: Schedule) => {
    try {
      const saved = await scheduleApi.save({ ...item, done: !item.done })
      setSchedules((prev) => prev.map((s) => (s.id === saved.id ? saved : s)))
      onChangedRef.current?.()
    } catch (err) {
      console.error('更新日程失败', err)
      toast.error(`更新日程失败：${err instanceof Error ? err.message : err}`)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await scheduleApi.delete(id)
      setSchedules((prev) => prev.filter((s) => s.id !== id))
      onChangedRef.current?.()
    } catch (err) {
      console.error('删除日程失败', err)
      toast.error(`删除日程失败：${err instanceof Error ? err.message : err}`)
    }
  }

  const startEdit = (item: Schedule) => {
    setEditingId(item.id)
    setEditContent(item.content)
  }

  const commitEdit = async () => {
    if (!editingId) return
    const content = editContent.trim()
    if (!content) {
      setEditingId(null)
      return
    }
    const item = schedules.find((s) => s.id === editingId)
    if (!item || content === item.content) {
      setEditingId(null)
      return
    }
    try {
      const saved = await scheduleApi.save({ ...item, content })
      setSchedules((prev) => prev.map((s) => (s.id === saved.id ? saved : s)))
      onChangedRef.current?.()
    } catch (err) {
      console.error('保存日程失败', err)
      toast.error(`保存日程失败：${err instanceof Error ? err.message : err}`)
    } finally {
      setEditingId(null)
    }
  }

  const cancelEdit = () => setEditingId(null)

  const doneCount = useMemo(() => schedules.filter((s) => s.done).length, [schedules])

  return (
    <div className="border-t bg-card">
      {/* 标题栏 */}
      <div className="px-4 py-2.5 flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">个人日程管理</h3>
        <span className="text-[11px] px-1.5 py-px rounded bg-muted text-muted-foreground tabular-nums">
          {formatShortDate(date)}
        </span>
        <div className="flex-1" />
        {loading && <Loader2Icon className="w-3.5 h-3.5 text-muted-foreground animate-spin" />}
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
          {doneCount}/{schedules.length} 完成
        </span>
      </div>

      <div className="px-4 pb-3">
        {schedules.length === 0 && !loading ? (
          <p className="text-xs text-muted-foreground/60 py-2">暂无日程，添加一条吧</p>
        ) : (
          <ul className="space-y-1">
            {schedules.map((s) => (
              <li key={s.id} className="group flex items-center gap-2 py-1">
                <button
                  onClick={() => void toggleDone(s)}
                  className={cn(
                    'shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors',
                    s.done
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground/30 hover:border-primary',
                  )}
                  title={s.done ? '标记未完成' : '标记完成'}
                >
                  {s.done && <CheckIcon className="w-3 h-3" />}
                </button>

                {editingId === s.id ? (
                  <input
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onBlur={() => void commitEdit()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitEdit()
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    autoFocus
                    className="flex-1 min-w-0 text-xs bg-background border rounded px-1.5 py-1 outline-none focus:ring-1 focus:ring-ring"
                  />
                ) : (
                  <span
                    onDoubleClick={() => startEdit(s)}
                    className={cn(
                      'flex-1 min-w-0 text-xs truncate cursor-text',
                      s.done ? 'text-muted-foreground line-through' : 'text-foreground',
                    )}
                    title={`${s.content}（双击编辑）`}
                  >
                    {s.content}
                  </span>
                )}

                <button
                  onClick={() => void handleDelete(s.id)}
                  className="shrink-0 p-1 rounded text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="删除"
                >
                  <Trash2Icon className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 添加日程 */}
        <div className="mt-2 flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd()
            }}
            placeholder="添加日程…"
            className="flex-1 min-w-0 text-xs bg-background border rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={() => void handleAdd()}
            disabled={!input.trim() || adding}
            className="shrink-0 p-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-50 hover:opacity-90 transition-opacity"
            title="添加"
          >
            {adding ? (
              <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <PlusIcon className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
