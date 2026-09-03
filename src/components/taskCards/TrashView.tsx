/**
 * 回收站 — 项目与任务的软删除管理
 * 支持：恢复、彻底删除、清空
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  EraserIcon,
  Loader2Icon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { taskCardApi } from '@/lib/tauri-bridge'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import type { DeletedTaskItem, TaskProject } from '@/types'
import { fmtDateTime } from '@/lib/taskCardsTime'
import TaskCardView from './TaskCardView'
import TaskModal from './TaskModal'

type Tab = 'projects' | 'tasks'

export default function TrashView({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('tasks')
  const [projects, setProjects] = useState<TaskProject[]>([])
  const [tasks, setTasks] = useState<DeletedTaskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [openTask, setOpenTask] = useState<DeletedTaskItem | null>(null)

  const refreshAll = useTaskCardsStore((s) => s.refreshAll)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ps, ts] = await Promise.all([taskCardApi.listDeletedProjects(), taskCardApi.listDeletedTasks()])
      setProjects(ps)
      setTasks(ts)
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '加载回收站失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function restoreProject(p: TaskProject) {
    setBusy(true)
    try {
      await taskCardApi.restoreProject(p.id)
      await load()
      await refreshAll()
      toast.success(`已恢复项目「${p.name}」及其任务`)
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '恢复失败')
    } finally {
      setBusy(false)
    }
  }

  async function hardDeleteProject(p: TaskProject) {
    if (!window.confirm(`彻底删除项目「${p.name}」？其全部任务将被永久删除，不可恢复！`)) return
    setBusy(true)
    try {
      await taskCardApi.hardDeleteProject(p.id)
      await load()
      toast.success('已彻底删除')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  async function restoreTask(t: DeletedTaskItem) {
    setBusy(true)
    try {
      await taskCardApi.restoreTask(t.id)
      await load()
      await refreshAll()
      toast.success('已恢复任务')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '恢复失败')
    } finally {
      setBusy(false)
    }
  }

  async function hardDeleteTask(t: DeletedTaskItem) {
    if (!window.confirm('彻底删除该任务？不可恢复！')) return
    setBusy(true)
    try {
      await taskCardApi.hardDeleteTask(t.id)
      await load()
      toast.success('已彻底删除')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  async function clearAll() {
    if (!window.confirm(`清空「${tab === 'projects' ? '项目' : '任务'}」回收站？将被永久删除，不可恢复！`)) return
    setBusy(true)
    try {
      if (tab === 'projects') {
        await taskCardApi.clearProjectTrash()
      } else {
        await taskCardApi.clearTaskTrash()
      }
      await load()
      toast.success('回收站已清空')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '清空失败')
    } finally {
      setBusy(false)
    }
  }

  const count = tab === 'projects' ? projects.length : tasks.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-white/8 px-6 h-14 shrink-0">
        <button
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/8 hover:text-zinc-100"
          title="返回今日"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <div>
          <h2 className="text-[15px] font-semibold flex items-center gap-2">
            <Trash2Icon className="h-4.5 w-4.5 text-rose-400" />
            回收站
          </h2>
          <p className="text-[10.5px] text-zinc-500">软删除的项目与任务在这里保留，可恢复或彻底清除</p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center rounded-lg border border-white/10 p-0.5">
          {(['tasks', 'projects'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] transition',
                tab === t ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {t === 'tasks' ? `任务 · ${tasks.length}` : `项目 · ${projects.length}`}
            </button>
          ))}
        </div>
        {count > 0 && (
          <button
            onClick={() => void clearAll()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
          >
            <EraserIcon className="h-3.5 w-3.5" />
            清空
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5 ">
        {loading ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            <Loader2Icon className="h-5 w-5 animate-spin" />
          </div>
        ) : count === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
            <ArchiveRestoreIcon className="h-10 w-10" />
            <div className="text-[13px]">回收站是空的</div>
            <div className="text-[11.5px]">删除的项目与任务会先到这里</div>
          </div>
        ) : tab === 'projects' ? (
          <div className="mx-auto max-w-2xl space-y-2">
            {projects.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/3 px-4 py-3"
              >
                <span className="text-[20px]">{p.icon || '📁'}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-zinc-200">{p.name}</div>
                  <div className="text-[11px] text-zinc-500">
                    删除于 {fmtDateTime(p.deletedAt)} · 任务随项目一并回收
                  </div>
                </div>
                <button
                  onClick={() => void restoreProject(p)}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  <RotateCcwIcon className="h-3.5 w-3.5" />
                  恢复
                </button>
                <button
                  onClick={() => void hardDeleteProject(p)}
                  disabled={busy}
                  title="彻底删除"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
                >
                  <Trash2Icon className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-2">
            {tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-3">
                <div className="flex-1 opacity-80">
                  <TaskCardView
                    task={t}
                    project={undefined}
                    onOpen={() => setOpenTask(t)}
                    onToggleDone={() => {}}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <button
                    onClick={() => void restoreTask(t)}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5 text-[12px] text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    <RotateCcwIcon className="h-3.5 w-3.5" />
                    恢复
                  </button>
                  <button
                    onClick={() => void hardDeleteTask(t)}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                    彻底删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {openTask && <TaskModal task={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  )
}
