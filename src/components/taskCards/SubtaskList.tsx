/**
 * 任务清单（子任务，任务卡 P2）
 *
 * 展示某任务下的勾选清单：添加 / 点击标题重命名 / 勾选完成 / 悬停删除。
 * 全部子任务数据在组件内管理（后端 task_subtasks 表），与卡片其余字段解耦。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2Icon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { taskCardApi } from '@/lib/tauri-bridge'
import type { TaskSubtask } from '@/types'

interface Props {
  taskId: string
}

export default function SubtaskList({ taskId }: Props) {
  const [items, setItems] = useState<TaskSubtask[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const doneCount = items.filter((i) => i.done).length
  const allDone = items.length > 0 && doneCount === items.length

  const reload = () => {
    setLoading(true)
    taskCardApi
      .listSubtasks(taskId)
      .then((list) => setItems(list))
      .catch(() => toast.error('加载清单失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const startAdd = () => {
    setAdding(true)
    setDraft('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const commitAdd = () => {
    const title = draft.trim()
    if (!title) return
    setDraft('')
    setAdding(false)
    taskCardApi
      .createSubtask(taskId, title)
      .then((item) => {
        setItems((prev) => [...prev, item])
        setEditingId(null)
      })
      .catch((e) => toast.error(errText(e)))
  }

  const toggle = (item: TaskSubtask) => {
    // 乐观更新 + 回滚
    const prev = items
    setItems((list) =>
      list.map((x) => (x.id === item.id ? { ...x, done: !x.done } : x)),
    )
    taskCardApi
      .setSubtaskDone(item.id, !item.done)
      .catch((e) => {
        setItems(prev)
        toast.error(errText(e))
      })
  }

  const startEdit = (item: TaskSubtask) => {
    setEditingId(item.id)
    setEditDraft(item.title)
  }

  const commitEdit = () => {
    const id = editingId
    const title = editDraft.trim()
    if (!id) return
    setEditingId(null)
    if (!title) return
    taskCardApi
      .updateSubtask(id, title)
      .then((item) => setItems((list) => list.map((x) => (x.id === id ? item : x))))
      .catch((e) => toast.error(errText(e)))
  }

  const remove = (item: TaskSubtask) => {
    setItems((list) => list.filter((x) => x.id !== item.id))
    taskCardApi.deleteSubtask(item.id).catch((e) => toast.error(errText(e)))
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="block text-[11.5px] font-medium text-zinc-500">
          任务清单
          {items.length > 0 && (
            <span
              className={cn(
                'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]',
                allDone ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/8 text-zinc-500',
              )}
            >
              {doneCount}/{items.length}
            </span>
          )}
        </label>
        {!adding && (
          <button
            onClick={startAdd}
            className="flex items-center gap-1 text-[11.5px] text-zinc-500 transition hover:text-rose-300"
          >
            <PlusIcon className="h-3 w-3" />
            添加
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-1.5 text-[11.5px] text-zinc-600">
          <Loader2Icon className="h-3 w-3 animate-spin" />
          加载清单…
        </div>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
          {items.map((item) => (
            <li key={item.id} className="group flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-white/5">
              <button
                onClick={() => toggle(item)}
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition',
                  item.done
                    ? 'border-emerald-400 bg-emerald-400/90 text-black'
                    : 'border-white/25 text-transparent hover:border-emerald-400/70 hover:text-emerald-400/40',
                )}
                title={item.done ? '标记未完成' : '标记完成'}
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </button>

              {editingId === item.id ? (
                <input
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    else if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={commitEdit}
                  maxLength={200}
                  className="min-w-0 flex-1 rounded bg-black/20 px-1.5 py-0.5 text-[12.5px] outline-none ring-1 ring-rose-400/50"
                />
              ) : (
                <button
                  onClick={() => startEdit(item)}
                  title="点击重命名"
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[12.5px] transition',
                    item.done ? 'text-zinc-600 line-through' : 'text-zinc-300 hover:text-zinc-100',
                  )}
                >
                  {item.title}
                </button>
              )}

              {editingId === item.id ? (
                <button
                  onClick={() => setEditingId(null)}
                  className="shrink-0 text-zinc-600 hover:text-zinc-300"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              ) : (
                <button
                  onClick={() => remove(item)}
                  className="shrink-0 text-zinc-700 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                  title="删除"
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && !adding && (
            <li className="py-1 text-[11.5px] text-zinc-600">还没有子步骤，点右上角「添加」拆解任务</li>
          )}
        </ul>
      )}

      {adding && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAdd()
              else if (e.key === 'Escape') {
                setAdding(false)
                setDraft('')
              }
            }}
            maxLength={200}
            placeholder="输入清单项，回车添加"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[12.5px] outline-none placeholder:text-zinc-600 focus:border-rose-400/60"
          />
          <button
            onClick={commitAdd}
            disabled={!draft.trim()}
            className="shrink-0 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-2.5 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-40"
          >
            添加
          </button>
        </div>
      )}
    </div>
  )
}
