/**
 * 标签与设置 — 右侧抽屉
 *
 * Tab1 标签管理：新增 / 改名 / 换色 / 启停 / 删除
 * Tab2 日程迁移：把旧「个人日程」一键迁移为任务卡项目
 * Tab3 提醒偏好：截止前一天/当天/逾期每日 09:00 提醒（通知插件就绪后生效）
 */
import { useEffect, useState } from 'react'
import {
  ArrowLeftRightIcon,
  BellIcon,
  BellRingIcon,
  CheckIcon,
  LayoutTemplateIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  TagsIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import TemplatesTab from './TemplatesTab'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { taskCardApi } from '@/lib/tauri-bridge'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import type { ReminderPrefs, TaskTag } from '@/types'

const TAG_COLORS = ['#e11d48', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#71717a']

const DEFAULT_PREFS: ReminderPrefs = {
  enabled: false,
  dueBeforeDay: true,
  dueDay: true,
  overdueDaily: true,
  dailyEnabled: false,
  dailyTime: '09:00',
}

type TabKey = 'tags' | 'templates' | 'migrate' | 'reminder'

export default function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>('tags')
  const tags = useTaskCardsStore((s) => s.tags)
  const fetchTags = useTaskCardsStore((s) => s.fetchTags)

  // 标签编辑态
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')
  const [newColor, setNewColor] = useState('#e11d48')
  const [tagBusy, setTagBusy] = useState(false)

  // 迁移态
  const [migrating, setMigrating] = useState(false)
  const [migrateDone, setMigrateDone] = useState(false)

  // 提醒偏好
  const [prefs, setPrefs] = useState<ReminderPrefs>(DEFAULT_PREFS)
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const [checking, setChecking] = useState(false)

  async function runCheck() {
    setChecking(true)
    try {
      const sent = await taskCardApi.reminderCheck()
      if (sent > 0) {
        toast.success(`已发送 ${sent} 条提醒`)
      } else {
        toast.info('当前没有符合条件的到期/逾期任务，或尚未到 09:00 提醒时段')
      }
    } catch (err) {
      toast.error(errText(err, '检查失败'))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    void (async () => {
      try {
        const raw = await taskCardApi.getReminderPrefs()
        if (raw) setPrefs({ ...DEFAULT_PREFS, ...(JSON.parse(raw) as ReminderPrefs) })
      } catch {
        /* 忽略 */
      }
      setPrefsLoaded(true)
    })()
  }, [])

  async function createTag() {
    const name = newTag.trim()
    if (!name) return
    setTagBusy(true)
    try {
      await taskCardApi.createTag(name, newColor)
      setNewTag('')
      await fetchTags()
      toast.success('标签已创建')
    } catch (err) {
      toast.error(errText(err, '创建失败'))
    } finally {
      setTagBusy(false)
    }
  }

  async function updateTag(id: string, patch: { name?: string; color?: string; status?: 'enabled' | 'disabled' }) {
    try {
      await taskCardApi.updateTag(id, patch)
      await fetchTags()
    } catch (err) {
      toast.error(errText(err, '保存失败'))
    }
  }

  async function deleteTag(t: TaskTag) {
    if (!window.confirm(`删除标签「${t.name}」？任务上的关联将同时移除（任务本身不受影响）。`)) return
    setTagBusy(true)
    try {
      const removed = await taskCardApi.deleteTag(t.id)
      await fetchTags()
      toast.success(removed > 0 ? `标签已删除，移除了 ${removed} 个任务上的关联` : '标签已删除')
    } catch (err) {
      toast.error(errText(err, '删除失败'))
    } finally {
      setTagBusy(false)
    }
  }

  async function runMigrate() {
    setMigrating(true)
    try {
      const result = await taskCardApi.migrateSchedules()
      setMigrateDone(true)
      if (result.already) {
        toast.info('已经迁移过啦，数据保持最新')
      } else {
        toast.success(`迁移完成：${result.migrated} 条日程（已完成 ${result.completed} 条）已进入项目「日程迁移」`)
      }
      await useTaskCardsStore.getState().refreshAll()
    } catch (err) {
      toast.error(errText(err, '迁移失败'))
    } finally {
      setMigrating(false)
    }
  }

  async function savePrefs(next: ReminderPrefs) {
    setPrefs(next)
    try {
      await taskCardApi.setReminderPrefs(JSON.stringify(next))
      toast.success('提醒偏好已保存')
    } catch (err) {
      toast.error(errText(err, '保存失败'))
    }
  }

  function togglePref(key: keyof ReminderPrefs) {
    void savePrefs({ ...prefs, [key]: !prefs[key] })
  }

  const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'tags', label: '标签管理', icon: <TagsIcon className="h-4 w-4" /> },
    { key: 'templates', label: '任务模板', icon: <LayoutTemplateIcon className="h-4 w-4" /> },
    { key: 'migrate', label: '日程迁移', icon: <ArrowLeftRightIcon className="h-4 w-4" /> },
    { key: 'reminder', label: '提醒偏好', icon: <BellIcon className="h-4 w-4" /> },
  ]

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <aside className="absolute inset-y-0 right-0 flex w-[400px] flex-col border-l border-white/10 bg-[#141b2e] shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 h-14 border-b border-white/8">
          <h3 className="text-[15px] font-semibold">标签与设置</h3>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-white/8 hover:text-zinc-100">
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] transition',
                tab === t.key
                  ? 'bg-linear-to-r from-rose-500/25 to-orange-500/20 text-rose-100 border border-rose-400/25'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 ">
          {/* ── 标签管理 ── */}
          {tab === 'tags' && (
            <div className="space-y-3">
              {/* 新增 */}
              <div className="rounded-xl border border-white/8 bg-white/3 p-3">
                <div className="mb-2 text-[12px] font-medium text-zinc-300">新建标签</div>
                <div className="flex gap-2">
                  <input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createTag()
                    }}
                    placeholder="标签名称…"
                    className="flex-1 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-zinc-600 focus:border-rose-400/60"
                  />
                  <button
                    onClick={() => void createTag()}
                    disabled={tagBusy || !newTag.trim()}
                    className="flex items-center gap-1 rounded-lg bg-linear-to-r from-rose-500 to-orange-500 px-3 text-[12px] font-medium text-white disabled:opacity-40"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    添加
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setNewColor(c)}
                      className={cn(
                        'h-5 w-5 rounded-full border-2 transition',
                        newColor === c ? 'border-white scale-110' : 'border-transparent opacity-60 hover:opacity-100',
                      )}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>

              {/* 列表 */}
              <div className="space-y-1.5">
                {tags.length === 0 && (
                  <div className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-[12px] text-zinc-600">
                    暂无标签，任务中可以给它们打上标签方便筛选
                  </div>
                )}
                {tags.map((t) => {
                  const editing = editingId === t.id
                  return (
                    <div key={t.id} className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/3 px-3 py-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: t.color, opacity: t.status === 'enabled' ? 1 : 0.3 }}
                      />
                      {editing ? (
                        <input
                          autoFocus
                          defaultValue={t.name}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = (e.target as HTMLInputElement).value.trim()
                              if (v && v !== t.name) void updateTag(t.id, { name: v })
                              setEditingId(null)
                            }
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v && v !== t.name) void updateTag(t.id, { name: v })
                            setEditingId(null)
                          }}
                          className="flex-1 rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[12.5px] outline-none focus:border-rose-400/60"
                        />
                      ) : (
                        <span className={cn('flex-1 text-[13px]', t.status === 'disabled' && 'line-through opacity-50')}>
                          {t.name}
                        </span>
                      )}
                      {/* 颜色 */}
                      <div className="flex gap-0.5">
                        {TAG_COLORS.slice(0, 5).map((c) => (
                          <button
                            key={c}
                            onClick={() => void updateTag(t.id, { color: c })}
                            className={cn(
                              'h-3.5 w-3.5 rounded-full transition',
                              t.color === c ? 'ring-2 ring-white/80' : 'opacity-40 hover:opacity-100',
                            )}
                            style={{ background: c }}
                          />
                        ))}
                      </div>
                      <button
                        onClick={() => void updateTag(t.id, { status: t.status === 'enabled' ? 'disabled' : 'enabled' })}
                        title={t.status === 'enabled' ? '点击停用' : '点击启用'}
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded-md transition',
                          t.status === 'enabled'
                            ? 'text-emerald-400 hover:bg-emerald-500/10'
                            : 'text-zinc-600 hover:bg-white/8',
                        )}
                      >
                        {t.status === 'enabled' ? <CheckIcon className="h-3.5 w-3.5" /> : <XIcon className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => setEditingId(editing ? null : t.id)}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/8"
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => void deleteTag(t)}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:bg-red-500/15 hover:text-red-300"
                      >
                        <Trash2Icon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── 日程迁移 ── */}
          {tab === 'templates' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1 text-[11.5px] text-zinc-600">
                <LayoutTemplateIcon className="h-3.5 w-3.5" />
                把常做的任务存成模板，在下方选择项目后一键套用
              </div>
              <TemplatesTab onTaskCreated={onClose} />
            </div>
          )}

          {tab === 'migrate' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-sky-500/20 bg-sky-500/8 p-4 text-[12.5px] leading-relaxed text-zinc-300">
                <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-sky-200">
                  <ArrowLeftRightIcon className="h-4 w-4" />
                  从「个人日程」迁移
                </div>
                原书城底部「个人日程」已由任务卡取代。点击下方按钮可把已有日程一键迁移为任务卡项目，迁移后原日程保持不变（可在设置中手动隐藏）。
              </div>
              <button
                onClick={() => void runMigrate()}
                disabled={migrating}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13.5px] font-medium transition',
                  migrateDone
                    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'bg-linear-to-r from-rose-500 to-orange-500 text-white shadow-lg shadow-rose-900/30 hover:opacity-95',
                )}
              >
                {migrating && <Loader2Icon className="h-4 w-4 animate-spin" />}
                {migrateDone ? <CheckIcon className="h-4 w-4" /> : <ArrowLeftRightIcon className="h-4 w-4" />}
                {migrateDone ? '已迁移 · 再次点击保持同步' : migrating ? '迁移中…' : '开始迁移个人日程'}
              </button>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                迁移说明：已完成的历史日程会作为「已完成」任务归档；未完成的进入「日程迁移」项目按原时间排期。重复执行不会产生重复数据。
              </p>
            </div>
          )}

          {/* ── 提醒偏好 ── */}
          {tab === 'reminder' && (
            <div className="space-y-3">
              {!prefsLoaded && (
                <div className="py-6 text-center text-zinc-500">
                  <Loader2Icon className="h-5 w-5 animate-spin" />
                </div>
              )}
              {prefsLoaded && (
                <>
                  <button
                    onClick={() => void runCheck()}
                    disabled={checking}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/10 py-2 text-[12.5px] font-medium text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
                  >
                    {checking ? <Loader2Icon className="h-4 w-4 animate-spin" /> : <BellRingIcon className="h-4 w-4" />}
                    立即检查一次提醒（请求系统通知权限）
                  </button>
                  <div className="flex items-center justify-between rounded-xl border border-white/8 bg-white/3 px-4 py-3">
                    <div>
                      <div className="text-[13px] font-medium text-zinc-200">启用任务提醒</div>
                      <div className="text-[11px] text-zinc-500">应用运行时后台检查，系统通知提醒</div>
                    </div>
                    <Toggle on={prefs.enabled} onChange={() => togglePref('enabled')} />
                  </div>
                  {prefs.enabled && (
                    <>
                      {(
                        [
                          ['dueBeforeDay', '截止前一天提醒', '截止日前一天 09:00'],
                          ['dueDay', '截止当天提醒', '截止日 09:00'],
                          ['overdueDaily', '逾期后每日提醒', '逾期后每天 09:00'],
                        ] as [keyof ReminderPrefs, string, string][]
                      ).map(([key, label, hint]) => (
                        <div key={key} className="flex items-center justify-between rounded-xl border border-white/8 bg-white/3 px-4 py-3">
                          <div>
                            <div className="text-[13px] text-zinc-200">{label}</div>
                            <div className="text-[11px] text-zinc-500">{hint}</div>
                          </div>
                          <Toggle on={prefs[key] as boolean} onChange={() => togglePref(key)} />
                        </div>
                      ))}
                      {/* 每日待办提醒（9.11.1-4）：默认关，可配置时间 */}
                      <div className="flex items-center justify-between rounded-xl border border-white/8 bg-white/3 px-4 py-3">
                        <div>
                          <div className="text-[13px] text-zinc-200">每日待办提醒</div>
                          <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                            每天
                            <input
                              type="time"
                              value={prefs.dailyTime}
                              onChange={(e) =>
                                void savePrefs({ ...prefs, dailyTime: e.target.value || '09:00' })
                              }
                              className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-[11px] text-zinc-200 outline-none scheme-dark"
                            />
                            汇总今日待办（逾期 / 今日截止 / 计划今日）提醒一次
                          </div>
                        </div>
                        <Toggle on={prefs.dailyEnabled} onChange={() => togglePref('dailyEnabled')} />
                      </div>
                      <p className="text-[11px] leading-relaxed text-zinc-600">
                        提醒随应用运行触发（开机常驻时最稳定）。任务详情中可单独关闭某任务的提醒；系统通知需在系统设置中允许本应用发送通知。
                      </p>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition',
        on ? 'bg-linear-to-r from-rose-500 to-orange-500' : 'bg-zinc-600',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
          on ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  )
}
