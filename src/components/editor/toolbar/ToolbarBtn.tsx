/**
 * 工具栏通用子组件：ToolbarBtn / TooltipWrap
 *
 * - 共享 useTooltip hook 消除重复的延迟显示逻辑
 * - 均使用 React.memo 避免父组件频繁重渲染导致的不必要更新
 * - Tooltip 通过 createPortal 渲染到 document.body，避免被工具栏
 *   overflow-x-auto 容器裁剪遮挡
 */
import { useState, useRef, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils.ts'

/** 共享的 tooltip 延迟显示逻辑 + 锚点定位 */
function useTooltip(delayMs = 150) {
  const [show, setShow] = useState(false)
  const timeoutRef = useRef<number>(0)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(null)

  const onMouseEnter = useCallback(() => {
    timeoutRef.current = window.setTimeout(() => {
      const el = anchorRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        setTipPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 })
      }
      setShow(true)
    }, delayMs)
  }, [delayMs])

  const onMouseLeave = useCallback(() => {
    clearTimeout(timeoutRef.current)
    setShow(false)
  }, [])

  return { show, onMouseEnter, onMouseLeave, anchorRef, tipPos }
}

/** tooltip 弹出层（Portal 到 body，fixed 定位显示在锚点下方居中） */
function TooltipLabel({ text, pos }: { text: string; pos: { top: number; left: number } }) {
  return createPortal(
    <span
      className="fixed z-100 -translate-x-1/2 px-2 py-0.5 rounded bg-popover border shadow text-xs text-muted-foreground whitespace-nowrap pointer-events-none"
      style={{ top: pos.top, left: pos.left }}
    >
      {text}
    </span>,
    document.body,
  )
}

/**
 * 工具栏按钮
 *
 * 高亮当前激活状态，支持自定义图标与文字提示。
 */
export const ToolbarBtn = memo(function ToolbarBtn({
  active,
  onClick,
  title,
  icon,
  className,
}: {
  active: boolean
  onClick: () => void
  title: string
  icon: React.ReactNode
  className?: string
}) {
  const { show, onMouseEnter, onMouseLeave, anchorRef, tipPos } = useTooltip()

  return (
    <div
      ref={anchorRef}
      className="relative flex items-center shrink-0"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <button
        onClick={onClick}
        className={cn(
          'p-1.5 rounded transition-colors',
          active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          className,
        )}
      >
        {icon}
      </button>
      {show && tipPos && <TooltipLabel text={title} pos={tipPos} />}
    </div>
  )
})

/**
 * 工具提示包装器
 *
 * 为任意内联按钮添加即时悬停提示，替代原生 title 属性。
 */
export const TooltipWrap = memo(function TooltipWrap({ title, children }: { title: string; children: React.ReactNode }) {
  const { show, onMouseEnter, onMouseLeave, anchorRef, tipPos } = useTooltip()

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex items-center"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
      {show && tipPos && <TooltipLabel text={title} pos={tipPos} />}
    </span>
  )
})
