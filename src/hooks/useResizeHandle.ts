import { useCallback, useRef, useEffect, useState } from 'react'

interface UseResizeHandleOptions {
  /** 初始宽度（px），mode='pixel' 时使用 */
  initialWidth?: number
  /** 初始比例（0-1），mode='ratio' 时使用 */
  initialRatio?: number
  /** 最小宽度（px）或最小比例 */
  minWidth?: number
  /** 最大宽度（px）或最大比例 */
  maxWidth?: number
  /** 容器 ref，用于比例模式：计算容器宽度 */
  containerRef?: React.RefObject<HTMLElement | null>
  /** 拖拽结束后回调，传递当前值（像素模式下为 px，比例模式下为 0-1） */
  onResizeEnd?: (value: number) => void
  /**
   * 拖拽方向：'left' 表示向左拖增大宽度，'right' 表示向右拖减小宽度
   * 默认 'right'（面板在右侧，向左拖 → 面板变宽）
   */
  direction?: 'left' | 'right'
}

/**
 * 可拖拽调整面板宽度的 Hook
 *
 * 两种模式：
 * - pixel（默认）：直接操作像素宽度
 * - ratio：操作比例（0-1），窗口大小变化时自动按比例调整面板宽度
 *   传入 containerRef 时自动启用比例模式
 *
 * 返回当前宽度、拖拽手柄的 props（直接展开到拖拽手柄元素上）
 */
export function useResizeHandle({
  initialWidth = 300,
  initialRatio = 0.3,
  minWidth = 200,
  maxWidth = 800,
  containerRef,
  onResizeEnd,
  direction = 'right',
}: UseResizeHandleOptions) {
  /** 是否为比例模式 */
  const isRatioMode = !!containerRef

  // 获取容器的当前像素宽度
  const getContainerWidth = useCallback((): number => {
    if (containerRef?.current) {
      return containerRef.current.getBoundingClientRect().width
    }
    return window.innerWidth
  }, [containerRef])

  // 比例模式：从比例计算像素宽度
  const ratioToPx = useCallback(
    (ratio: number): number => {
      return Math.round(getContainerWidth() * ratio)
    },
    [getContainerWidth],
  )

  // 初始像素宽度：比例模式首次运行时需要从比例计算
  const initialPx = isRatioMode ? ratioToPx(initialRatio) : initialWidth

  const [ratio, setRatio] = useState(isRatioMode ? initialRatio : 0)

  const [width, setWidth] = useState(initialPx)
  const [isResizing, setIsResizing] = useState(false)
  const stateRef = useRef({ startX: 0, startRatio: 0, startPx: 0 })
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio
  const widthRef = useRef(width)
  widthRef.current = width
  const onResizeEndRef = useRef(onResizeEnd)
  onResizeEndRef.current = onResizeEnd

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)
      if (isRatioMode) {
        stateRef.current = { startX: e.clientX, startRatio: ratioRef.current, startPx: 0 }
      } else {
        stateRef.current = { startX: e.clientX, startRatio: 0, startPx: widthRef.current }
      }
    },
    [isRatioMode],
  )

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const pixelDelta =
        direction === 'right'
          ? stateRef.current.startX - e.clientX
          : e.clientX - stateRef.current.startX

      if (isRatioMode) {
        // 比例模式：将像素 delta 转换为比例 delta
        const containerWidth = getContainerWidth()
        if (containerWidth <= 0) return
        const ratioDelta = pixelDelta / containerWidth
        const newRatio = Math.min(maxWidth, Math.max(minWidth, stateRef.current.startRatio + ratioDelta))
        setRatio(newRatio)
        setWidth(Math.round(containerWidth * newRatio))
      } else {
        // 像素模式
        const newWidth = Math.min(maxWidth, Math.max(minWidth, stateRef.current.startPx + pixelDelta))
        setWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      if (isRatioMode) {
        onResizeEndRef.current?.(ratioRef.current)
      } else {
        onResizeEndRef.current?.(widthRef.current)
      }
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
  }, [isResizing, direction, minWidth, maxWidth, isRatioMode, getContainerWidth])

  // 比例模式：监听容器大小变化，自动调整面板宽度
  useEffect(() => {
    if (!isRatioMode || !containerRef?.current) return

    const observer = new ResizeObserver(() => {
      const newWidth = ratioToPx(ratioRef.current)
      setWidth(newWidth)
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [isRatioMode, containerRef, ratioToPx])

  const resizeHandleProps = {
    onMouseDown: handleMouseDown,
    role: 'separator' as const,
    'aria-valuenow': width,
    'aria-valuemin': minWidth,
    'aria-valuemax': maxWidth,
    'aria-label': '拖拽调整面板宽度',
  }

  return { width, setWidth, ratio, setRatio, isResizing, resizeHandleProps }
}
