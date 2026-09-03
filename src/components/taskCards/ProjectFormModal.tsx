/**
 * 项目 新建/编辑 弹窗
 * 字段：名称、emoji 图标、颜色、描述、计划开始/结束日期、状态（编辑时）、钉置
 */
import { useEffect, useState } from 'react'
import { Loader2Icon, PinIcon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import type { ProjectStatus, TaskProject } from '@/types'

const EMOJIS = ['📚', '💡', '📝', '🏋️', '🎨', '💻', '🛒', '🏠', '🚀', '🎵', '📷', '🧠', '✈️', '💰', '🎓', '⚽']

const COLORS = [
  '#e11d48', '#f97316', '#f59e0b', '#84cc16',
  '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6',
  '#ec4899', '#64748b',
]

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '进行中',
  completed: '已完成',
  archived: '已归档',
}

export default function ProjectFormModal({
  editId,
  onClose,
  onSaved,
}: {
  editId?: string
  onClose: () => void
  onSaved: (projectId: string) => void
}) {
  const projects = useTaskCardsStore((s) => s.projects)
  const createProject = useTaskCardsStore((s) => s.createProject)
  const updateProject = useTaskCardsStore((s) => s.updateProject)
  const editProject: TaskProject | undefined = projects.find((p) => p.id === editId)

  const [name, setName] = useState(editProject?.name ?? '')
  const [icon, setIcon] = useState(editProject?.icon || '📚')
  const [color, setColor] = useState(editProject?.color || '#e11d48')
  const [description, setDescription] = useState(editProject?.description ?? '')
  const [planStart, setPlanStart] = useState(editProject?.planStartDate ?? '')
  const [planEnd, setPlanEnd] = useState(editProject?.planEndDate ?? '')
  const [status, setStatus] = useState<ProjectStatus>(editProject?.status ?? 'active')
  const [pinned, setPinned] = useState(editProject?.pinned ?? false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    const n = name.trim()
    if (!n) {
      toast.error('请填写项目名称')
      return
    }
    setSaving(true)
    try {
      const common = {
        name: n,
        description: description.trim() || undefined,
        color,
        icon,
        planStartDate: planStart || undefined,
        planEndDate: planEnd || undefined,
      }
      if (editProject) {
        const updated = await updateProject(editProject.id, { ...common, status, pinned })
        toast.success('项目已更新')
        onSaved(updated.id)
      } else {
        const created = await createProject({ ...common, status: 'active', pinned })
        toast.success(`项目「${created.name}」已创建`)
        onSaved(created.id)
      }
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-[440px] max-h-[86vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#151d31] shadow-2xl ">
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h3 className="text-[15px] font-semibold">{editProject ? '编辑项目' : '新建项目'}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-white/8 hover:text-zinc-100">
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-400">名称 *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：毕业论文 / 装修进度"
              className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[13.5px] outline-none placeholder:text-zinc-600 focus:border-rose-400/60"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-400">图标</label>
              <div className="grid grid-cols-8 gap-1">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setIcon(e)}
                    className={cn(
                      'flex h-8 items-center justify-center rounded-lg text-[15px] transition',
                      icon === e ? 'bg-rose-500/20 ring-1 ring-rose-400/60' : 'hover:bg-white/8',
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-400">颜色</label>
              <div className="grid grid-cols-5 gap-1.5">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={cn(
                      'h-6.5 w-6.5 rounded-full border-2 transition',
                      color === c ? 'border-white scale-110' : 'border-transparent opacity-70 hover:opacity-100',
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-400">描述（可选）</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="这个项目的目标是什么？"
              className="w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[13px] outline-none placeholder:text-zinc-600 focus:border-rose-400/60"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-400">计划开始</label>
              <input
                type="date"
                value={planStart}
                onChange={(e) => setPlanStart(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[13px] outline-none focus:border-rose-400/60 scheme-dark"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-400">计划结束</label>
              <input
                type="date"
                value={planEnd}
                onChange={(e) => setPlanEnd(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[13px] outline-none focus:border-rose-400/60 scheme-dark"
              />
            </div>
          </div>

          {editProject && (
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-[11.5px] font-medium text-zinc-400">项目状态</label>
                <div className="mt-1.5 flex gap-1.5">
                  {(Object.keys(STATUS_LABEL) as ProjectStatus[]).map((st) => (
                    <button
                      key={st}
                      onClick={() => setStatus(st)}
                      className={cn(
                        'rounded-lg border px-2.5 py-1 text-[12px] transition',
                        status === st
                          ? 'border-rose-400/50 bg-rose-500/15 text-rose-200'
                          : 'border-white/10 text-zinc-400 hover:bg-white/5',
                      )}
                    >
                      {STATUS_LABEL[st]}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setPinned(!pinned)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition',
                  pinned
                    ? 'border-amber-400/50 bg-amber-500/15 text-amber-300'
                    : 'border-white/10 text-zinc-400 hover:bg-white/5',
                )}
              >
                <PinIcon className="h-3.5 w-3.5" />
                {pinned ? '已置顶' : '置顶'}
              </button>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-[13px] text-zinc-300 hover:bg-white/5"
            >
              取消
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-4 py-2 text-[13px] font-medium text-white shadow-lg shadow-rose-900/30 disabled:opacity-60"
            >
              {saving && <Loader2Icon className="h-3.5 w-3.5 animate-spin" />}
              {editProject ? '保存修改' : '创建项目'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
