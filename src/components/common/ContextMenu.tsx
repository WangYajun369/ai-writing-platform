/**
 * ContextMenu — 自定义右键菜单系统
 *
 * 提供 useContextMenu hook，组件声明式注册右键菜单，自动处理：
 * - stopPropagation 突破 App 层默认禁用
 * - 鼠标位置定位 + 视口边界感知
 * - 点击外部 / ESC 关闭
 * - 全局单例：任一菜单打开时自动关闭其他（订阅通知 + 计数器比对）
 * - 弹出动画
 */
import { useState, useCallback, useEffect, useRef, type ReactNode, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

// ---------- 类型 ----------

export interface ContextMenuDivider {
  type: 'divider'
}

export interface ContextMenuItem {
  label: string
  icon?: LucideIcon
  onClick: () => void
  /** 危险操作（红色） */
  danger?: boolean
  /** 禁用状态 */
  disabled?: boolean
  type?: 'item'
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider

export interface UseContextMenuOptions {
  items: ContextMenuEntry[]
  /** 最小宽度，默认 160px */
  minWidth?: number
}

export interface UseContextMenuReturn {
  /** 绑定到目标元素的 onContextMenu 处理器 */
  onContextMenu: (e: MouseEvent) => void
  /** 渲染在组件中的菜单 JSX */
  contextMenu: ReactNode
  /** 编程式在指定坐标打开菜单（用于按钮点击等场景） */
  openMenu: (x: number, y: number) => void
}

// ---------- 辅助 ----------

function isDivider(e: ContextMenuEntry): e is ContextMenuDivider {
  return 'type' in e && e.type === 'divider'
}

// ---------- 全局通知系统 ----------
// 问题：React 只重渲染本组件状态变更的实例，不同 BookCard 互不感知。
// 解决：模块级订阅机制，任一菜单打开时通知所有 hook 实例重渲染，通过计数器比对淘汰过期菜单。

let menuIdCounter = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function notifyMenuOpen() {
  menuIdCounter++
  listeners.forEach((l) => l())
}

/** 关闭所有菜单：递增计数器通知全部实例，不注册新菜单，旧菜单自动过期消失 */
export function closeAllMenus() {
  notifyMenuOpen()
}

// ---------- Hook ----------

export function useContextMenu({ items, minWidth = 160 }: UseContextMenuOptions): UseContextMenuReturn {
  const [state, setState] = useState<{ open: boolean; x: number; y: number }>({
    open: false,
    x: 0,
    y: 0,
  })
  /** 强制重渲染计数器：订阅全局通知 */
  const [, forceRender] = useState(0)

  const menuRef = useRef<HTMLDivElement>(null)
  const myMenuIdRef = useRef(0)

  // 订阅全局通知 —— 保证任一菜单打开时所有实例均重渲染
  useEffect(() => subscribe(() => forceRender((n) => n + 1)), [])

  /** 打开菜单：递增全局计数器并通知所有实例 */
  const openMenuAt = useCallback((x: number, y: number) => {
    notifyMenuOpen()
    myMenuIdRef.current = menuIdCounter
    setState({ open: true, x, y })
  }, [])

  /** 关闭当前菜单 */
  const close = useCallback(() => {
    setState((s) => (s.open ? { ...s, open: false } : s))
  }, [])

  const onContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt(e.clientX, e.clientY)
  }, [openMenuAt])

  // 点击外部关闭（捕获阶段）
  useEffect(() => {
    if (!state.open) return
    const handle = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close()
      }
    }
    const timer = setTimeout(() => document.addEventListener('click', handle, true), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handle, true)
    }
  }, [state.open, close])

  // ESC 关闭
  useEffect(() => {
    if (!state.open) return
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [state.open, close])

  const openMenu = openMenuAt

  return {
    onContextMenu,
    openMenu,
    contextMenu: state.open && myMenuIdRef.current === menuIdCounter
      ? createPortal(
          <ContextMenuPopup
            ref={menuRef}
            x={state.x}
            y={state.y}
            items={items}
            minWidth={minWidth}
            onClose={close}
          />,
          document.body,
        )
      : null,
  }
}

// ---------- 菜单弹窗 ----------

interface PopupProps {
  x: number
  y: number
  items: ContextMenuEntry[]
  minWidth: number
  onClose: () => void
}

function ContextMenuPopup({ x, y, items, minWidth, onClose, ref }: PopupProps & { ref?: React.Ref<HTMLDivElement> }) {
  const popupRef = useRef<HTMLDivElement>(null)

  // 合并外部 ref
  useEffect(() => {
    if (!ref) return
    if (typeof ref === 'function') {
      ref(popupRef.current)
    } else {
      (ref as React.MutableRefObject<HTMLDivElement | null>).current = popupRef.current
    }
  }, [ref])

  // 边界调整
  useEffect(() => {
    const el = popupRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let ax = x
    let ay = y
    if (x + r.width > vw) ax = vw - r.width - 8
    if (y + r.height > vh) ay = vh - r.height - 8
    if (ax !== x) el.style.left = `${ax}px`
    if (ay !== y) el.style.top = `${ay}px`
  }, [x, y])

  return (
    <div
      ref={popupRef}
      className="fixed z-50 bg-popover border rounded-lg shadow-xl py-1 animate-pop-in"
      style={{ left: x, top: y, minWidth }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if (isDivider(entry)) {
          return <div key={`div-${i}`} className="my-1 border-t border-border" />
        }
        return (
          <button
            key={`${entry.label}-${i}`}
            onClick={() => {
              if (entry.disabled) return
              entry.onClick()
              onClose()
            }}
            disabled={entry.disabled}
            className={`flex items-center gap-2.5 px-3 py-1.5 text-sm w-full text-left transition-colors
              ${entry.disabled
                ? 'opacity-40 cursor-not-allowed'
                : entry.danger
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'text-popover-foreground hover:bg-muted'
              }`}
          >
            {entry.icon && <entry.icon className="w-3.5 h-3.5 flex-shrink-0" />}
            <span className="truncate">{entry.label}</span>
          </button>
        )
      })}
    </div>
  )
}
