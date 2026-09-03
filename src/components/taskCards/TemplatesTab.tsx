/**
 * 任务模板管理（任务卡 P2）
 *
 * 内置在「标签与设置」抽屉：新建模板（预设标题 / 描述 / 优先级 / 备注 /
 * 标签 / 子任务清单 / 截止偏移），列表展示并可一键套用创建任务。
 */
import { useEffect, useState } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  LayoutTemplateIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { taskCardApi } from '@/lib/tauri-bridge'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import type { TaskPriority, TaskTemplate } from '@/types'

interface Props {
  onTaskCreated?: () => void
}

export default function TemplatesTab({ onTaskCreated }: Props) {
  const projects = useTaskCardsStore((s) => s.projects)
  const tags = useTaskCardsStore((s) => s.tags)

  const [list, setList] = useState<TaskTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  // 新建折叠
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [offset, setOffset] = useState('0')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [subtaskText, setSubtaskText] = useState('')
  // 套用目标项目
  const [targetProject, setTargetProject] = useState('')

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!targetProject && projects.length > 0) setTargetProject(projects[0].id)
  }, [projects, targetProject])

  async function load() {
    setLoading(true)
    try {
      const tpls = await taskCardApi.listTemplates()
      setList(tpls)
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '加载模板失败')
    } finally {
      setLoading(false)
    }
  }

  function resetForm() {
    setName('')
    setTitle('')
    setPriority('medium')
    setOffset('0')
    setTagIds([])
    setSubtaskText('')
    setCreating(false)
  }

  async function createTemplate() {
    const n = name.trim()
    if (!n) {
      toast.error('请填写模板名称')
      return
    }
    setBusy(true)
    try {
      const subtasks = subtaskText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      await taskCardApi.createTemplate({
        name: n,
        title: title.trim() || undefined,
        priority,
        dueOffsetDays: Math.max(0, Number(offset) || 0),
        tagIds,
        subtaskTitles: subtasks,
      })
      toast.success('模板已保存')
      resetForm()
      await load()
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function applyTemplate(tpl: TaskTemplate) {
    if (!targetProject) {
      toast.error('请先选择要创建到的项目')
      return
    }
    setBusy(true)
    try {
      await taskCardApi.createTaskFromTemplate(tpl.id, targetProject)
      toast.success(`已按「${tpl.name}」创建任务`)
      void useTaskCardsStore.getState().refreshAll()
      onTaskCreated?.()
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function removeTemplate(tpl: TaskTemplate) {
    if (!window.confirm(`删除模板「${tpl.name}」？不影响已创建的任务。`)) return
    try {
      await taskCardApi.deleteTemplate(tpl.id)
      setList((prev) => prev.filter((t) => t.id !== tpl.id))
      toast.success('模板已删除')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '删除失败')
    }
  }

  const enabledTags = tags.filter((t) => t.status === 'enabled')

  return (
    <div className="space-y-3">
      {/* 套用目标项目 */}
      {projects.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/3 px-3 py-2">
          <span className="text-[11.5px] text-zinc-500">套用到</span>
          <div className="relative flex-1">
            <select
              value={targetProject}
              onChange={(e) => setTargetProject(e.target.value)}
              className="w-full appearance-none rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 pr-7 text-[12.5px] text-zinc-200 outline-none scheme-dark focus:border-indigo-400/60"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.icon} {p.name}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          </div>
        </div>
      )}

      {/* 新建 */}
      {!creating ? (
        <button
          onClick={() => setCreating(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-indigo-400/30 py-2 text-[12.5px] text-indigo-300 transition hover:border-indigo-400/60 hover:bg-indigo-500/8"
        >
          <PlusIcon className="h-4 w-4" />
          新建模板
        </button>
      ) : (
        <div className="rounded-xl border border-indigo-400/25 bg-indigo-500/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-indigo-200">
            <LayoutTemplateIcon className="h-4 w-4" />
            新建模板
          </div>
          <div className="space-y-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="模板名称（必填），如「公众号文章」"
              className="w-full rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-zinc-600 focus:border-indigo-400/60"
            />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="任务标题（留空 = 套用时用模板名）"
              className="w-full rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-zinc-600 focus:border-indigo-400/60"
            />
            <div className="flex items-center gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5">
                <span className="text-[11.5px] text-zinc-500">优先级</span>
                {(['high', 'medium', 'low'] as TaskPriority[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPriority(p)}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[11px]',
                      priority === p ? 'bg-indigo-500/70 text-white' : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    {p === 'high' ? '高' : p === 'medium' ? '中' : '低'}
                  </button>
                ))}
              </div>
              <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5">
                <span className="text-[11.5px] text-zinc-500">截止偏移</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                  className="w-12 bg-transparent text-center text-[12.5px] text-zinc-200 outline-none"
                />
                <span className="text-[11px] text-zinc-600">天</span>
              </div>
            </div>

            {/* 标签多选 */}
            <div className="flex flex-wrap gap-1 rounded-lg border border-white/10 bg-black/25 p-2">
              {enabledTags.length === 0 && (
                <span className="text-[11px] text-zinc-600">暂无启用标签，可在「标签管理」中创建</span>
              )}
              {enabledTags.map((t) => {
                const on = tagIds.includes(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() => setTagIds(on ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id])}
                    className={cn(
                      'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition',
                      on ? 'text-white' : 'bg-white/5 text-zinc-500 hover:text-zinc-300',
                    )}
                    style={on ? { background: t.color } : undefined}
                  >
                    {on && <CheckIcon className="h-3 w-3" />}
                    {t.name}
                  </button>
                )
              })}
            </div>

            <textarea
              value={subtaskText}
              onChange={(e) => setSubtaskText(e.target.value)}
              rows={2}
              placeholder={'子任务清单，每行一条（可选）\n例如：\n列大纲\n写初稿\n配图'}
              className="w-full resize-none rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[12.5px] leading-relaxed outline-none placeholder:text-zinc-600 focus:border-indigo-400/60"
            />

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => void createTemplate()}
                disabled={busy || !name.trim()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-linear-to-r from-indigo-500 to-violet-500 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
              >
                {busy ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <CheckIcon className="h-3.5 w-3.5" />}
                保存模板
              </button>
              <button
                onClick={resetForm}
                className="rounded-lg border border-white/10 px-3 py-2 text-[12.5px] text-zinc-400 hover:bg-white/5"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 列表 */}
      {loading ? (
        <div className="py-6 text-center text-zinc-500">
          <Loader2Icon className="h-5 w-5 animate-spin" />
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-[12px] text-zinc-600">
          暂无模板。把常做的任务存成模板，一键复用。
        </div>
      ) : (
        list.map((tpl) => {
          const defaultProject = projects.find((p) => p.id === tpl.projectId)
          return (
            <div key={tpl.id} className="rounded-xl border border-white/8 bg-white/3 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <LayoutTemplateIcon className="h-4 w-4 shrink-0 text-indigo-300/70" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-zinc-200">{tpl.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-zinc-500">
                    {tpl.title && <span className="truncate">{tpl.title}</span>}
                    {tpl.priority === 'high' && <span className="text-rose-400">高优先级</span>}
                    {tpl.dueOffsetDays > 0 && <span>截止 +{tpl.dueOffsetDays} 天</span>}
                    {tpl.tagIds.length > 0 && <span>{tpl.tagIds.length} 个标签</span>}
                    {tpl.subtaskTitles.length > 0 && <span>{tpl.subtaskTitles.length} 个子任务</span>}
                    {defaultProject && (
                      <span>
                        {defaultProject.icon} {defaultProject.name}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => void applyTemplate(tpl)}
                  disabled={busy || projects.length === 0}
                  title="按模板创建任务"
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-linear-to-r from-indigo-500 to-violet-500 px-2.5 py-1.5 text-[11.5px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  套用
                </button>
                <button
                  onClick={() => void removeTemplate(tpl)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-red-500/15 hover:text-red-300"
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
