/**
 * 任务 新建 / 详情·编辑 弹窗
 *
 * 新建模式：填写完整字段后创建。
 * 详情模式：字段即时保存（文本 onBlur、选择项即时），并提供
 * 移动项目 / 复制 / 删除 / 完成任务 等操作。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BellIcon,
  CalendarIcon,
  CopyIcon,
  FlagIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { cn, htmlToPlainText } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { taskCardApi } from '@/lib/tauri-bridge'
import TaskDescriptionEditor from './TaskDescriptionEditor'
import CompleteSummaryModal from './CompleteSummaryModal'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import { fromInputValue, toInputValue } from '@/lib/taskCardsTime'
import { PRIORITY_META, STATUS_META, STATUS_ORDER } from '@/lib/taskCardsMeta'
import SubtaskList from './SubtaskList'
import AttachmentsBox from './AttachmentsBox'
import ActivityTimeline from './ActivityTimeline'
import RecurrencePicker from './RecurrencePicker'
import type { TaskCard, TaskPriority, TaskStatus, TaskTag } from '@/types'

interface Props {
  /** 有 task 时为详情/编辑；否则为新建 */
  task?: TaskCard
  /** 新建默认项目 */
  projectId?: string
  /** 新建默认「计划今日」 */
  defaultPlannedToday?: boolean
  onClose: () => void
}

export default function TaskModal({ task, projectId, defaultPlannedToday, onClose }: Props) {
  const projects = useTaskCardsStore((s) => s.projects)
  const tags = useTaskCardsStore((s) => s.tags)
  const tasksByProject = useTaskCardsStore((s) => s.tasksByProject)
  const createTask = useTaskCardsStore((s) => s.createTask)
  const updateTask = useTaskCardsStore((s) => s.updateTask)
  const deleteTask = useTaskCardsStore((s) => s.deleteTask)
  const copyTask = useTaskCardsStore((s) => s.copyTask)
  const moveTaskToProject = useTaskCardsStore((s) => s.moveTaskToProject)

  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<number>(0)
  // 详情内点「已完成」→ 弹出完成总结对话框
  const [completing, setCompleting] = useState(false)
  // 标签即时新建（9.5.2）
  const [tagCreating, setTagCreating] = useState(false)
  const [tagName, setTagName] = useState('')

  const isEdit = !!task
  const project = projects.find((p) => p.id === task?.projectId || p.id === projectId)

  // ── 表单状态 ──
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [note, setNote] = useState(task?.note ?? '')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo')
  const [plannedToday, setPlannedToday] = useState(task?.plannedToday ?? defaultPlannedToday ?? false)
  const [dueTime, setDueTime] = useState(toInputValue(task?.dueTime))
  const [startTime, setStartTime] = useState(toInputValue(task?.planStartTime))
  const [tagIds, setTagIds] = useState<string[]>(task?.tags.map((t) => t.id) ?? [])
  const [selProjectId, setSelProjectId] = useState(task?.projectId ?? projectId ?? '')
  // 父任务（同项目内；''=顶层任务）
  const [parentId, setParentId] = useState(task?.parentId ?? '')

  // 父任务候选：当前项目全部任务按「父在前」树序展开，排除自己及其后代（防环）
  const parentRows = useMemo<{ id: string; title: string; prefix: string }[]>(() => {
    const list = tasksByProject[selProjectId] ?? []
    if (!list.length) return []
    return collectParentRows(list, task?.id ?? null)
  }, [tasksByProject, selProjectId, task])
  // 任务级提醒（9.5.2 / 9.11.2）：跟随全局 / 不提醒 / 自定义单点
  const [remindChoice, setRemindChoice] = useState<'global' | 'off' | 'custom'>(() => {
    const rt = task?.remindType ?? ''
    return rt === 'off' || rt === 'custom' ? rt : 'global'
  })
  const [remindTime, setRemindTime] = useState(toInputValue(task?.remindAt))
  // 重复规则 JSON（P2）
  const [recurrence, setRecurrence] = useState(task?.recurrence ?? '')

  const firstTitle = useRef<string>(task?.title ?? '')

  // 详情内尽量使用 store 最新版本（完成任务后 completedTime / completionSummary 同步展示）
  const liveTask = useMemo(() => {
    if (!task) return task
    return tasksByProject[task.projectId]?.find((t) => t.id === task.id) ?? task
  }, [task, tasksByProject])

  // 跟随 store 内最新状态（如经完成总结弹窗置为已完成）
  useEffect(() => {
    if (isEdit && liveTask && liveTask.status !== status) setStatus(liveTask.status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTask?.status])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function flashSaved() {
    setSavedAt(Date.now())
    window.setTimeout(() => setSavedAt(0), 1200)
  }

  /** 详情模式：单字段即时保存 */
  async function patch(patch: Parameters<typeof updateTask>[1]) {
    if (!task) return
    setBusy(true)
    try {
      await updateTask(task.id, patch)
      flashSaved()
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  function toggleTag(tag: TaskTag) {
    const next = tagIds.includes(tag.id) ? tagIds.filter((x) => x !== tag.id) : [...tagIds, tag.id]
    setTagIds(next)
    if (isEdit) void patch({ tagIds: next })
  }

  /** 标签即时新建：创建成功后自动选中（9.5.2「可即时新建标签」） */
  async function createNewTag() {
    const name = tagName.trim()
    if (!name) return
    try {
      const dup = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
      if (dup) {
        setTagName('')
        setTagCreating(false)
        toggleTag(dup)
        toast.info(`已选用已有标签「${dup.name}」`)
        return
      }
      const used = new Set(tags.map((t) => t.color))
      const color =
        TAG_PALETTE.find((c) => !used.has(c)) ?? TAG_PALETTE[tags.length % TAG_PALETTE.length]
      const created = await taskCardApi.createTag(name.slice(0, 20), color)
      await useTaskCardsStore.getState().fetchTags()
      setTagName('')
      setTagCreating(false)
      toggleTag(created)
      toast.success(`已创建标签「${created.name}」`)
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '创建标签失败')
    }
  }

  /** 任务级提醒：切换选项即时保存（自定义需先有时间） */
  function chooseRemind(next: 'global' | 'off' | 'custom') {
    if (!isEdit) return
    setRemindChoice(next)
    if (next === 'global') void patch({ remindType: '', remindAt: undefined })
    else if (next === 'off') void patch({ remindType: 'off', remindAt: undefined })
  }

  function saveCustomRemindTime(v: string) {
    setRemindTime(v)
    const norm = fromInputValue(v)
    if (isEdit && norm) void patch({ remindType: 'custom', remindAt: norm })
  }

  async function handleCreate() {
    const t = title.trim()
    if (!t) {
      toast.error('请填写任务标题')
      return
    }
    if (!selProjectId) {
      toast.error('请选择所属项目')
      return
    }
    setBusy(true)
    try {
      const created = await createTask({
        projectId: selProjectId,
        parentId: parentId || undefined,
        title: t,
        description: description && htmlToPlainText(description) ? description : undefined,
        note: note.trim() || undefined,
        priority,
        status,
        plannedToday,
        dueTime: fromInputValue(dueTime),
        planStartTime: fromInputValue(startTime),
        tagIds: tagIds.length ? tagIds : undefined,
        recurrence: recurrence || undefined,
      })
      toast.success('任务已创建')
      onClose()
      void useTaskCardsStore.getState().fetchProjectTasks(created.projectId)
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!task) return
    if (!window.confirm('将任务移入回收站？可在回收站中恢复。')) return
    setBusy(true)
    try {
      await deleteTask(task.id)
      toast.success('已移入回收站')
      onClose()
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleCopy() {
    if (!task) return
    setBusy(true)
    try {
      await copyTask(task.id)
      toast.success('已复制任务')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '复制失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleMove(nextProjectId: string) {
    if (!task || nextProjectId === task.projectId) return
    setSelProjectId(nextProjectId)
    setBusy(true)
    try {
      await moveTaskToProject(task.id, nextProjectId)
      // 后端迁移整棵子树；若原父不在目标项目则父引用被解除，同步重置选择
      setParentId('')
      toast.success('已移动任务（含其子任务）')
    } catch (err) {
      setSelProjectId(task.projectId)
      toast.error(typeof err === 'string' ? err : '移动失败')
    } finally {
      setBusy(false)
    }
  }

  const accent = project?.color ?? '#e11d48'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex w-[520px] max-w-[94vw] max-h-[88vh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#151d31] shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-white/8 px-5 py-3.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accent }} />
          <span className="text-[13px] font-medium text-zinc-200">{project?.icon ?? '📁'} {project?.name ?? '未选择项目'}</span>
          <div className="flex-1" />
          {isEdit && savedAt > 0 && !busy && <span className="text-[11px] text-emerald-400">已保存 ✓</span>}
          {busy && <Loader2Icon className="h-4 w-4 animate-spin text-rose-400" />}
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-white/8 hover:text-zinc-100">
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 ">
          {/* 标题 */}
          <input
            autoFocus={!isEdit}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              const t = title.trim()
              if (isEdit && t && t !== firstTitle.current) {
                void patch({ title: t })
                firstTitle.current = t
              }
            }}
            placeholder="任务标题…"
            className="w-full border-b border-transparent bg-transparent px-0.5 pb-1 text-[17px] font-medium outline-none placeholder:text-zinc-600 focus:border-rose-400/40"
          />

          {/* 状态 */}
          <div className="flex items-center gap-1.5">
            {STATUS_ORDER.map((st) => (
              <button
                key={st}
                onClick={() => {
                  if (!isEdit || st === status) return
                  // 勾选完成 → 弹出总结对话框（总结随完成一并保存）
                  if (st === 'done') {
                    setCompleting(true)
                    return
                  }
                  setStatus(st)
                  void patch({ status: st })
                }}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition',
                  status === st ? STATUS_META[st].badge : 'border-white/10 text-zinc-400 hover:bg-white/5',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', status === st ? STATUS_META[st].dot : 'bg-zinc-500')} />
                {STATUS_META[st].label}
              </button>
            ))}
            {isEdit && status === 'done' && (liveTask?.completedTime ?? task?.completedTime) && (
              <span className="ml-auto text-[11px] text-zinc-500">
                完成于 {(liveTask?.completedTime ?? task?.completedTime)!.slice(0, 16).replace('T', ' ')}
              </span>
            )}
          </div>

          {/* 完成总结（已完成且有总结时展示） */}
          {isEdit && status === 'done' && liveTask?.completionSummary && (
            <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-emerald-300/90">
                完成总结
                <span className="font-normal text-zinc-600">本次完成的回顾，重新打开后仍会保留</span>
              </div>
              <div
                className="task-desc-prose summary-readonly max-h-[30vh] overflow-y-auto pr-1"
                dangerouslySetInnerHTML={{ __html: liveTask.completionSummary }}
              />
            </div>
          )}

          {/* 优先级 */}
          <div className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[11.5px] text-zinc-500">优先级</span>
            {(Object.keys(PRIORITY_META) as TaskPriority[]).map((pr) => (
              <button
                key={pr}
                onClick={() => {
                  if (pr === priority) return
                  setPriority(pr)
                  if (isEdit) void patch({ priority: pr })
                }}
                className={cn(
                  'flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] transition',
                  priority === pr ? PRIORITY_META[pr].badge : 'border-white/10 text-zinc-400 hover:bg-white/5',
                )}
              >
                <FlagIcon className="h-3 w-3" />
                {PRIORITY_META[pr].label}
              </button>
            ))}
          </div>

          {/* 父任务（层级关联，甘特图铺路；同项目内可选，可留空=顶层） */}
          <div className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[11.5px] text-zinc-500">父任务</span>
            <select
              value={parentId}
              onChange={(e) => {
                const v = e.target.value
                setParentId(v)
                if (isEdit && v !== (task?.parentId ?? '')) void patch({ parentId: v || '' })
              }}
              className="flex-1 rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[12.5px] text-zinc-300 outline-none scheme-dark"
            >
              <option value="">顶层任务（无父任务）</option>
              {parentRows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.prefix}· {r.title}
                </option>
              ))}
            </select>
            {isEdit && parentId && (
              <button
                onClick={() => {
                  setParentId('')
                  void patch({ parentId: '' })
                }}
                className="text-[11px] text-zinc-500 hover:text-rose-300"
              >
                解除
              </button>
            )}
          </div>

          {/* 时间 */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="w-14 shrink-0 text-[11.5px] text-zinc-500">截止时间</span>
              <input
                type="datetime-local"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                onBlur={() => {
                  if (!isEdit) return
                  const next = fromInputValue(dueTime)
                  if (next !== (task?.dueTime ?? undefined)) void patch({ dueTime: next })
                }}
                className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-rose-400/60 scheme-dark"
              />
              {dueTime && (
                <button
                  onClick={() => {
                    setDueTime('')
                    if (isEdit) void patch({ dueTime: undefined })
                  }}
                  className="text-[11px] text-zinc-500 hover:text-rose-300"
                >
                  清除
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-14 shrink-0 text-[11.5px] text-zinc-500">开始时间</span>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                onBlur={() => {
                  if (!isEdit) return
                  const next = fromInputValue(startTime)
                  if (next !== (task?.planStartTime ?? undefined)) void patch({ planStartTime: next })
                }}
                className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-rose-400/60 scheme-dark"
              />
              {startTime && (
                <button
                  onClick={() => {
                    setStartTime('')
                    if (isEdit) void patch({ planStartTime: undefined })
                  }}
                  className="text-[11px] text-zinc-500 hover:text-rose-300"
                >
                  清除
                </button>
              )}
            </div>
          </div>

          {/* 描述（TipTap 富文本；编辑框右下角可拖拽调整高度） */}
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-500">任务描述</label>
            <TaskDescriptionEditor
              value={description}
              onChange={(html) => setDescription(html)}
              onSave={(html) => {
                if (isEdit && html !== task.description) void patch({ description: html })
              }}
              placeholder="补充任务内容或验收标准…"
            />
          </div>

          {/* 标签 */}
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-500">
              标签{isEdit ? '（点击即保存）' : ''}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {tags.length === 0 && (
                <span className="text-[11.5px] text-zinc-600">暂无标签，可在「标签与设置」中创建</span>
              )}
              {tags.map((t) => {
                const active = tagIds.includes(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() => toggleTag(t)}
                    className="rounded-lg border px-2 py-1 text-[11.5px] transition"
                    style={
                      active
                        ? { color: t.color, borderColor: t.color + '66', background: t.color + '1f' }
                        : { color: '#71717a', borderColor: 'rgba(255,255,255,.08)' }
                    }
                  >
                    {active ? '✓ ' : '+ '}
                    {t.name}
                  </button>
                )
              })}
              {tagCreating ? (
                <input
                  autoFocus
                  value={tagName}
                  onChange={(e) => setTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void createNewTag()
                    } else if (e.key === 'Escape') {
                      setTagCreating(false)
                      setTagName('')
                    }
                  }}
                  onBlur={() => {
                    if (!tagName.trim()) {
                      setTagCreating(false)
                      setTagName('')
                    }
                  }}
                  maxLength={20}
                  placeholder="标签名，回车创建"
                  className="w-36 rounded-lg border border-rose-400/40 bg-black/20 px-2 py-1 text-[11.5px] outline-none placeholder:text-zinc-600"
                />
              ) : (
                <button
                  onClick={() => setTagCreating(true)}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-white/15 px-2 py-1 text-[11.5px] text-zinc-500 transition hover:border-rose-400/40 hover:text-rose-300"
                >
                  <PlusIcon className="h-3 w-3" />
                  新建标签
                </button>
              )}
            </div>
          </div>

          {/* 计划今日 */}
          <div className="flex items-center justify-between rounded-lg border border-white/8 bg-white/3 px-3 py-2">
            <div className="flex items-center gap-2 text-[12.5px] text-zinc-300">
              <CalendarIcon className="h-4 w-4 text-rose-400" />
              计划今日（今日任务页优先显示）
            </div>
            <button
              onClick={() => {
                const next = !plannedToday
                setPlannedToday(next)
                if (isEdit) void patch({ plannedToday: next })
              }}
              className={cn(
                'relative h-5 w-9 rounded-full transition',
                plannedToday ? 'bg-linear-to-r from-rose-500 to-orange-500' : 'bg-zinc-600',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
                  plannedToday ? 'left-[18px]' : 'left-0.5',
                  )}
                  />
                  </button>
                  </div>

                  {/* 重复（P2；详情模式即时保存） */}
                  <div>
                    <RecurrencePicker
                      value={recurrence}
                      onChange={(json) => {
                        setRecurrence(json)
                        if (isEdit) void patch({ recurrence: json })
                      }}
                    />
                  </div>

                  {/* 提醒（任务级，9.5.2 / 9.11.2；仅详情模式） */}
                  {isEdit && (
                  <div className="rounded-lg border border-white/8 bg-white/3 px-3 py-2.5">
                  <div className="mb-2 flex items-center gap-2 text-[12.5px] text-zinc-300">
                  <BellIcon className="h-4 w-4 text-amber-300" />
                  任务提醒
                  </div>
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/8 bg-black/20 p-1">
                  {(
                  [
                    ['global', '跟随全局'],
                    ['off', '不提醒'],
                    ['custom', '自定义'],
                  ] as const
                  ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => chooseRemind(key)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11.5px] transition',
                      remindChoice === key
                        ? 'bg-linear-to-r from-rose-500/80 to-orange-500/80 font-medium text-white'
                        : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    {label}
                  </button>
                  ))}
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-zinc-600">
                  {remindChoice === 'global' && '按「设置 → 提醒偏好」的截止 / 逾期 / 每日待办规则提醒。'}
                  {remindChoice === 'off' && '此任务不再产生任何截止与逾期提醒。'}
                  {remindChoice === 'custom' && '到设定时间提醒一次，触发后自动清除；可再次设置。'}
                  </p>
                  {remindChoice === 'custom' && (
                  <input
                  type="datetime-local"
                  value={remindTime}
                  onChange={(e) => saveCustomRemindTime(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-amber-400/30 bg-black/25 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none scheme-dark focus:border-amber-400/60"
                  />
                  )}
                  </div>
                  )}

                  {/* 任务清单（子任务，P2；仅详情模式） */}
                  {isEdit && (
                    <div className="rounded-lg border border-white/8 bg-white/3 px-3 py-2.5">
                      <SubtaskList taskId={task.id} />
                    </div>
                  )}

                  {/* 附件（P2；仅详情模式） */}
                  {isEdit && (
                    <div className="rounded-lg border border-white/8 bg-white/3 px-3 py-2.5">
                      <AttachmentsBox taskId={task.id} />
                    </div>
                  )}

                  {/* 操作记录 / 执行时间线（P2；仅详情模式） */}
                  {isEdit && <ActivityTimeline taskId={task.id} />}

                  {/* 备注 */}
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-zinc-500">个人备注</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => {
                if (isEdit && note !== task.note) void patch({ note })
              }}
              rows={1}
              placeholder="只给自己看的小纸条…"
              className="w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[13px] outline-none placeholder:text-zinc-600 focus:border-rose-400/60"
            />
          </div>

          {/* 元信息 */}
          {isEdit && (
            <div className="text-[10.5px] text-zinc-600">
              创建于 {task.createdAt.replace('T', ' ').slice(0, 16)}
              {task.remindType ? ` · 下次提醒 ${task.remindAt?.slice(0, 16).replace('T', ' ')}` : ''}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center gap-2 border-t border-white/8 px-5 py-3">
          {isEdit ? (
            <>
              <select
                value={selProjectId}
                onChange={(e) => void handleMove(e.target.value)}
                title="移动到其他项目"
                className="rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[12.5px] text-zinc-300 outline-none scheme-dark"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.icon} 移动到 {p.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => void handleCopy()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[12.5px] text-zinc-300 transition hover:bg-white/5 disabled:opacity-50"
              >
                <CopyIcon className="h-3.5 w-3.5" />
                复制
              </button>
              <div className="flex-1" />
              <button
                onClick={() => void handleDelete()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-1.5 text-[12.5px] text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
              >
                <Trash2Icon className="h-3.5 w-3.5" />
                删除
              </button>
            </>
          ) : (
            <>
              <select
                value={selProjectId}
                onChange={(e) => setSelProjectId(e.target.value)}
                className="rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-[12.5px] text-zinc-300 outline-none scheme-dark"
              >
                <option value="">选择项目…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.icon} {p.name}
                  </option>
                ))}
              </select>
              <div className="flex-1" />
              <button
                onClick={() => void handleCreate()}
                disabled={busy || !selProjectId}
                className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-4 py-2 text-[13px] font-medium text-white shadow-lg shadow-rose-900/30 disabled:opacity-50"
              >
                <PlusIcon className="h-4 w-4" />
                创建任务
              </button>
            </>
          )}
        </div>

        {/* 点「已完成」弹出的总结对话框（覆盖在详情之上） */}
        {completing && task && (
          <CompleteSummaryModal task={liveTask ?? task} onClose={() => setCompleting(false)} />
        )}
      </div>
    </div>
  )
}

/**
 * 父任务树形候选：按「父在前」层级展开，子任务以全角空格缩进示意层级。
 * excludeId 非空时（详情模式）排除该任务及其全部后代，避免形成循环引用。
 */
function collectParentRows(list: TaskCard[], excludeId: string | null): { id: string; title: string; prefix: string }[] {
  const byId = new Map(list.map((t) => [t.id, t]))
  const childrenOf = new Map<string, TaskCard[]>()
  for (const t of list) {
    if (t.parentId && byId.has(t.parentId)) {
      const arr = childrenOf.get(t.parentId) ?? []
      arr.push(t)
      childrenOf.set(t.parentId, arr)
    }
  }
  // 排除集 = 自己 + 全部后代（防环）
  const blocked = new Set<string>()
  if (excludeId) {
    const stack = [excludeId]
    while (stack.length) {
      const cur = stack.pop()!
      if (blocked.has(cur)) continue
      blocked.add(cur)
      for (const c of childrenOf.get(cur) ?? []) stack.push(c.id)
    }
  }
  const rows: { id: string; title: string; prefix: string }[] = []
  const seen = new Set<string>()
  const walk = (id: string, prefix: string) => {
    if (blocked.has(id) || seen.has(id)) return
    seen.add(id)
    const t = byId.get(id)
    if (t) rows.push({ id, title: t.title, prefix })
    for (const c of childrenOf.get(id) ?? []) walk(c.id, prefix + '　')
  }
  // 顶层任务（无父或父不在列表）按列表原序展开其整棵子树
  for (const t of list) {
    if (!t.parentId || !byId.has(t.parentId)) walk(t.id, '')
  }
  // 兜底：仍在排除集外且未出现过的（异常孤儿）也作为候选
  for (const t of list) {
    if (!blocked.has(t.id) && !seen.has(t.id)) rows.push({ id: t.id, title: t.title, prefix: '' })
  }
  return rows
}

/** 标签即时新建的候选色盘（自动挑未使用的颜色） */
const TAG_PALETTE = [
  '#f43f5e',
  '#f97316',
  '#f59e0b',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#a3e635',
  '#14b8a6',
  '#eab308',
  '#6366f1',
]
