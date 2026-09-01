/**
 * useAnchorPosition — 计算触发元素在视口中的位置，供 Portal 弹层 fixed 定位使用。
 *
 * 背景：工具栏 header 使用 overflow-x-auto 横向滚动，按 CSS 规范这会使 overflow-y
 * 被强制计算为 auto，导致向下弹出的弹窗/提示被裁剪。因此弹层需要通过
 * createPortal 渲染到 document.body，再基于锚点的 getBoundingClientRect 计算 fixed 定位。
 *
 * 返回 { top, left, right }：
 *  - top   = 锚点底部 + offsetY
 *  - left  = 锚点左边缘（用于左对齐弹层）
 *  - right = 视口右缘到锚点右边缘的距离（用于 right-0 语义的右对齐弹层）
 */
import { useCallback, useEffect, useState } from 'react'

export interface AnchorPos {
  top: number
  left: number
  right: number
}

export function useAnchorPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  offsetY = 4,
) {
  const [pos, setPos] = useState<AnchorPos | null>(null)

  const update = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      top: rect.bottom + offsetY,
      left: rect.left,
      right: window.innerWidth - rect.right,
    })
  }, [anchorRef, offsetY])

  useEffect(() => {
    update()
    window.addEventListener('resize', update)
    // capture 捕获阶段监听，覆盖任意滚动容器的滚动
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [update])

  return pos
}
