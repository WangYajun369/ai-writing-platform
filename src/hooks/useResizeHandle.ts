import { useCallback, useRef, useEffect, useState } from 'react'

interface UseResizeHandleOptions {
  /** 初始宽度（px） */
  initialWidth: number
  /** 最小宽度（px） */
  minWidth?: number
  /** 最大宽度（px） */
  maxWidth?: number
  /** 拖拽结束后回调 */
  onResizeEnd?: (width: number) => void
  /**
   * 拖拽方向：'left' 表示向左拖增大宽度，'right' 表示向右拖减小宽度
   * 默认 'right'（面板在右侧，向左拖 → 面板变宽）
   */
  direction?: 'left' | 'right'
}

/**
 * 可拖拽调整面板宽度的 Hook
 * 返回当前宽度和拖拽手柄的 props（直接展开到拖拽手柄元素上）
 */
export function useResizeHandle({
  initialWidth,
  minWidth = 200,
  maxWidth = 800,
  onResizeEnd,
  direction = 'right',
}: UseResizeHandleOptions) {
  const [width, setWidth] = useState(initialWidth)
  const [isResizing, setIsResizing] = useState(false)
  const stateRef = useRef({ startX: 0, startWidth: initialWidth })
  const widthRef = useRef(width)
  widthRef.current = width
  const onResizeEndRef = useRef(onResizeEnd)
  onResizeEndRef.current = onResizeEnd

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)
      stateRef.current = { startX: e.clientX, startWidth: widthRef.current }
    },
    [],
  )

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const delta =
        direction === 'right'
          ? stateRef.current.startX - e.clientX
          : e.clientX - stateRef.current.startX
      const newWidth = Math.min(maxWidth, Math.max(minWidth, stateRef.current.startWidth + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      onResizeEndRef.current?.(widthRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, direction, minWidth, maxWidth])

  const resizeHandleProps = {
    onMouseDown: handleMouseDown,
    role: 'separator' as const,
    'aria-valuenow': width,
    'aria-valuemin': minWidth,
    'aria-valuemax': maxWidth,
    'aria-label': '拖拽调整面板宽度',
  }

  return { width, setWidth, isResizing, resizeHandleProps }
}
