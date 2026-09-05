/**
 * 全局命令面板宿主 — 主窗口
 *
 * 消费注册到 command-palette 扩展点的插件命令：
 * - 唤起：Ctrl/⌘ + Shift + P（Esc 关闭，点击遮罩关闭）
 * - 输入即时过滤（名称/ID，忽略大小写）
 * - ↑↓ 选择、Enter 执行、鼠标悬停同步选中
 * 通用宿主：任何插件（含第三方）注册 command-palette 条目后自动出现在面板。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CommandIcon, CornerDownLeftIcon, Loader2Icon, XIcon } from 'lucide-react'
import { PluginManager } from '@/plugins/PluginManager'
import { COMMAND_ICON_MAP, FALLBACK_COMMAND_ICON } from '@/plugins/commandIcons'
import type { PluginCommand } from '@/plugins/types'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useShortcut } from '@/hooks/useShortcut'

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commands, setCommands] = useState<PluginCommand[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 命令源：订阅插件注册/启用变化，实时刷新
  useEffect(() => {
    const refresh = () => {
      setCommands(PluginManager.getCommandsByExtensionPoint('command-palette'))
    }
    refresh()
    return PluginManager.subscribe(refresh)
  }, [])

  // 唤起快捷键：mod + Shift + P（集中式快捷键系统）
  useShortcut('mod+shift+p', () => setOpen((o) => !o))

  // 打开时重置并聚焦输入
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIdx(0)
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return commands
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
    )
  }, [commands, q])

  useEffect(() => {
    setActiveIdx(0)
  }, [q])

  async function run(cmd: PluginCommand) {
    if (busyId) return
    setBusyId(cmd.id)
    try {
      await PluginManager.executeCommand(cmd.id, {
        notify: (msg, type = 'info') => toast[type]?.(msg),
      })
      setOpen(false)
    } catch (err) {
      toast.error(errText(err, '命令执行失败'))
    } finally {
      setBusyId(null)
    }
  }

  if (!open) return null

  const hasAny = commands.length > 0

  return (
    <div className="fixed inset-0 z-1000 flex items-start justify-center pt-[16vh]">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onMouseDown={() => setOpen(false)} />

      <div className="relative w-[560px] max-w-[88vw] overflow-hidden rounded-2xl border border-white/12 bg-[#0f1729]/95 shadow-2xl shadow-black/60 backdrop-blur-md">
        {/* 输入行 */}
        <div className="flex items-center gap-2.5 border-b border-white/8 px-4">
          <CommandIcon className="h-4.5 w-4.5 shrink-0 text-rose-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter' && filtered[activeIdx]) {
                e.preventDefault()
                void run(filtered[activeIdx])
              }
            }}
            placeholder={hasAny ? '输入命令，或 ↑↓ 选择后回车执行…' : '暂无可用命令'}
            className="h-13 flex-1 bg-transparent text-[14px] outline-none placeholder:text-zinc-600"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-zinc-500 hover:text-zinc-300">
              <XIcon className="h-4 w-4" />
            </button>
          )}
          <kbd className="shrink-0 rounded-md border border-white/12 bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-500">
            Ctrl/⌘ ⇧P
          </kbd>
        </div>

        {/* 结果列表 */}
        <div className="max-h-[46vh] overflow-y-auto py-1.5">
          {!hasAny ? (
            <div className="px-5 py-8 text-center text-[12.5px] text-zinc-500">
              <div className="mb-1">当前没有插件注册「命令面板」命令</div>
              <div className="text-[11px] text-zinc-600">
                内置任务卡插件已注册「打开任务卡 / 今日 / 全部任务」等命令
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-8 text-center text-[12.5px] text-zinc-500">没有匹配的命令</div>
          ) : (
            filtered.map((cmd, idx) => {
              const Icon = COMMAND_ICON_MAP[cmd.icon ?? ''] ?? FALLBACK_COMMAND_ICON
              const active = idx === activeIdx
              const busy = busyId === cmd.id
              return (
                <button
                  key={cmd.id}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => void run(cmd)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2.5 text-left transition',
                    active && 'bg-white/8',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                      active
                        ? 'border-rose-400/30 bg-rose-500/15 text-rose-300'
                        : 'border-white/8 bg-white/4 text-zinc-500',
                    )}
                  >
                    {busy ? (
                      <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Icon className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className={cn('flex-1 truncate text-[13px]', active ? 'text-zinc-100' : 'text-zinc-300')}>
                    {cmd.label}
                  </span>
                  <span className="text-[10px] text-zinc-600">{cmd.id}</span>
                  {active && (
                    <CornerDownLeftIcon className="h-3.5 w-3.5 shrink-0 text-rose-400/80" />
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
