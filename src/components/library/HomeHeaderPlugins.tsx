/**
 * HomeHeaderPlugins — 首页头部插件入口渲染
 *
 * 读取 PluginManager 中注册到 home-header 扩展点的命令，
 * 渲染为头部按钮：图标 + 名称 + 角标（如：今日待复习数）+ 激活态高亮。
 *
 * 角标/激活态刷新时机：
 * 1. 挂载时
 * 2. 后端广播 vocab-due-updated（任何影响复习队列的写操作）
 * 3. 插件子窗口关闭事件（vocab-window-closed）
 * 4. 每 20s 兜底轮询
 */
import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  BookMarkedIcon,
  LanguagesIcon,
  BookOpenIcon,
  CalendarIcon,
  ClipboardListIcon,
  FlameIcon,
  LightbulbIcon,
  PuzzleIcon,
  Loader2Icon,
  type LucideIcon,
} from 'lucide-react'
import { PluginManager } from '@/plugins/PluginManager'
import type { PluginCommand } from '@/plugins/types'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'

/** 可映射的图标名 → lucide 组件（未匹配时回退 Puzzle） */
const ICON_MAP: Record<string, LucideIcon> = {
  BookMarked: BookMarkedIcon,
  Languages: LanguagesIcon,
  BookOpen: BookOpenIcon,
  Calendar: CalendarIcon,
  ClipboardList: ClipboardListIcon,
  Flame: FlameIcon,
  Lightbulb: LightbulbIcon,
}

export default function HomeHeaderPlugins() {
  const [commands, setCommands] = useState<PluginCommand[]>([])
  const [badges, setBadges] = useState<Record<string, number>>({})
  const [active, setActive] = useState<Record<string, boolean>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  // 监听插件注册变化
  useEffect(() => {
    const update = () => setCommands(PluginManager.getCommandsByExtensionPoint('home-header'))
    update()
    return PluginManager.subscribe(update)
  }, [])

  /** 拉取所有入口的角标与激活态 */
  const pullState = useCallback(async () => {
    const cmds = PluginManager.getCommandsByExtensionPoint('home-header')
    if (cmds.length === 0) return
    const nextBadges: Record<string, number> = {}
    const nextActive: Record<string, boolean> = {}
    await Promise.all(
      cmds.map(async (cmd) => {
        if (cmd.badgeCount) {
          try {
            const n = await cmd.badgeCount()
            nextBadges[cmd.id] = typeof n === 'number' && n > 0 ? n : 0
          } catch {
            nextBadges[cmd.id] = 0
          }
        }
        if (cmd.isActive) {
          try {
            nextActive[cmd.id] = Boolean(cmd.isActive())
          } catch {
            nextActive[cmd.id] = false
          }
        }
      }),
    )
    setBadges(nextBadges)
    setActive(nextActive)
  }, [])

  // 挂载拉取 + 事件刷新 + 兜底轮询
  useEffect(() => {
    void pullState()
    const unDue = listen('vocab-due-updated', () => void pullState())
    const unClosed = listen('vocab-window-closed', () => void pullState())
    const timer = window.setInterval(() => void pullState(), 20_000)
    return () => {
      void unDue.then((fn) => fn())
      void unClosed.then((fn) => fn())
      window.clearInterval(timer)
    }
  }, [pullState])

  async function handleClick(cmd: PluginCommand) {
    if (busyId) return
    setBusyId(cmd.id)
    try {
      await PluginManager.executeCommand(cmd.id, {
        notify: (msg, type = 'info') => toast[type]?.(msg),
      })
      // 执行后（可能切换窗口/改变数据）刷新状态
      await pullState()
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '操作失败，请稍后重试')
    } finally {
      setBusyId(null)
    }
  }

  if (commands.length === 0) return null

  return (
    <>
      {commands.map((cmd) => {
        const Icon = ICON_MAP[cmd.icon ?? ''] ?? PuzzleIcon
        const badge = badges[cmd.id] ?? 0
        const isActive = Boolean(active[cmd.id])
        const isBusy = busyId === cmd.id
        return (
          <button
            key={cmd.id}
            onClick={() => void handleClick(cmd)}
            title={cmd.label}
            className={cn(
              'relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-300 shrink-0 whitespace-nowrap border',
              isActive
                ? 'bg-linear-to-r from-rose-500 to-pink-600 text-white shadow-md shadow-rose-500/25 border-transparent'
                : 'bg-linear-to-r from-rose-500/15 via-rose-500/10 to-rose-500/15 text-rose-300 border-rose-500/20 hover:border-rose-500/40 hover:shadow-sm hover:shadow-rose-500/10',
            )}
          >
            {isBusy ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <Icon className="h-4 w-4" />
            )}
            <span className="text-xs font-semibold tracking-wide">{cmd.label}</span>
            {badge > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow-sm shadow-red-900/40">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </>
  )
}
