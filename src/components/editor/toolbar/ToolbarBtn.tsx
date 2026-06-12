/**
 * 工具栏通用子组件：ToolbarBtn / TooltipWrap
 *
 * - 共享 useTooltip hook 消除重复的延迟显示逻辑
 * - 均使用 React.memo 避免父组件频繁重渲染导致的不必要更新
 */
import { useState, useRef, useCallback, memo } from 'react'
import { cn } from '@/lib/utils.ts'

/** 共享的 tooltip 延迟显示逻辑 */
function useTooltip(delayMs = 150) {
  const [show, setShow] = useState(false)
  const timeoutRef = useRef<number>(0)

  const onMouseEnter = useCallback(() => {
    timeoutRef.current = window.setTimeout(() => setShow(true), delayMs)
  }, [delayMs])

  const onMouseLeave = useCallback(() => {
    clearTimeout(timeoutRef.current)
    setShow(false)
  }, [])

  return { show, onMouseEnter, onMouseLeave }
}

/** tooltip 弹出层样式 */
function TooltipLabel({ text }: { text: string }) {
  return (
    <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 z-50 px-2 py-0.5 rounded bg-popover border shadow text-xs text-muted-foreground whitespace-nowrap pointer-events-none">
      {text}
    </span>
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
  const { show, onMouseEnter, onMouseLeave } = useTooltip()

  return (
    <div className="relative flex items-center" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
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
      {show && <TooltipLabel text={title} />}
    </div>
  )
})

/**
 * 工具提示包装器
 *
 * 为任意内联按钮添加即时悬停提示，替代原生 title 属性。
 */
export const TooltipWrap = memo(function TooltipWrap({ title, children }: { title: string; children: React.ReactNode }) {
  const { show, onMouseEnter, onMouseLeave } = useTooltip()

  return (
    <span className="relative inline-flex items-center" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {children}
      {show && <TooltipLabel text={title} />}
    </span>
  )
})
