/**
 * useShortcut — 集中式全局快捷键 hook
 *
 * 解决：快捷键散落各组件手写 addEventListener，无统一解析、无冲突检测、
 * 平台差异（⌘/Ctrl）各自处理。
 *
 * 用法：
 *   useShortcut('mod+s', handler, { enabled: canSave })
 *   useShortcut('Escape', closeDialog, { enabled: open })
 *   useShortcut('mod+shift+p', toggle)
 *
 * 组合键语法（+ 分隔，顺序无关）：
 *   mod     —— ⌘(macOS) / Ctrl(其余)
 *   ctrl / alt / shift —— 精确修饰键（ctrl 仅指 Ctrl 键本身，不含 ⌘）
 *   其它     —— e.key 匹配（忽略大小写），如 's'、'Escape'、'Enter'、'F5'
 */
import { useEffect, useMemo, useRef } from 'react'

// ─── 快捷键注册表（集中维护，供设置页/文档展示） ───
export const SHORTCUT_DEFS = {
  saveChapter: {
    combo: 'mod+s',
    label: '保存当前章节',
    macLabel: '⌘S',
    winLabel: 'Ctrl+S',
  },
  commandPalette: {
    combo: 'mod+shift+p',
    label: '打开/关闭命令面板',
    macLabel: '⌘⇧P',
    winLabel: 'Ctrl+Shift+P',
  },
  exitZenMode: {
    combo: 'Escape',
    label: '退出专注模式',
    macLabel: 'Esc',
    winLabel: 'Esc',
  },
  saveDiary: {
    combo: 'mod+s',
    label: '保存日记',
    macLabel: '⌘S',
    winLabel: 'Ctrl+S',
  },
  closeDiary: {
    combo: 'Escape',
    label: '关闭日记',
    macLabel: 'Esc',
    winLabel: 'Esc',
  },
} as const

export type ShortcutCombo = string

interface ParsedShortcut {
  key: string
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|od|ad)/.test(navigator.platform)

/**
 * 解析组合键字符串（如 'mod+shift+p' → { key:'p', mod:true, shift:true }）
 * 非法输入返回 null。
 */
export function parseShortcut(combo: string): ParsedShortcut | null {
  const parts = combo.split('+').map((s) => s.trim().toLowerCase())
  if (parts.length === 0) return null
  const parsed: ParsedShortcut = { key: '', mod: false, ctrl: false, alt: false, shift: false }

  const modifierKeys = new Set(['mod', 'ctrl', 'alt', 'shift'])
  const plainKeys = parts.filter((p) => !modifierKeys.has(p))
  if (plainKeys.length !== 1 || !plainKeys[0]) return null

  parsed.key = plainKeys[0]
  if (parts.includes('mod')) parsed.mod = true
  if (parts.includes('ctrl')) parsed.ctrl = true
  if (parts.includes('alt')) parsed.alt = true
  if (parts.includes('shift')) parsed.shift = true
  return parsed
}

function matchesEvent(e: KeyboardEvent, s: ParsedShortcut): boolean {
  if (e.key.toLowerCase() !== s.key.toLowerCase()) return false
  if (s.mod && (isMac ? !e.metaKey : !e.ctrlKey)) return false
  if (!s.mod && !s.ctrl && (isMac ? e.metaKey : e.ctrlKey)) return false
  if (s.ctrl && !e.ctrlKey) return false
  if (!s.ctrl && e.ctrlKey) return false
  if (s.alt !== e.altKey) return false
  if (s.shift !== e.shiftKey) return false
  return true
}

interface UseShortcutOptions {
  /** 为 false 时不监听（如依赖的 UI 未打开） */
  enabled?: boolean
  /** 命中时是否阻止默认行为，默认 true（如 Ctrl+S 浏览器保存页） */
  preventDefault?: boolean
  /** 监听的事件类型，默认 keydown */
  event?: 'keydown' | 'keyup'
}

export function useShortcut(
  combo: ShortcutCombo,
  handler: (e: KeyboardEvent) => void,
  options?: UseShortcutOptions,
) {
  const { enabled = true, preventDefault = true, event = 'keydown' } = options ?? {}

  const parsed = useMemo(() => parseShortcut(combo), [combo])

  // 始终持有最新 handler（避免依赖数组繁琐、闭包过期）
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    if (!parsed || !enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (matchesEvent(e, parsed)) {
        if (preventDefault) e.preventDefault()
        handlerRef.current(e)
      }
    }
    window.addEventListener(event, onKey)
    return () => window.removeEventListener(event, onKey)
  }, [parsed, enabled, preventDefault, event])
}
