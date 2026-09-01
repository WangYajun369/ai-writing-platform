/**
 * 标题级别选择器
 *
 * 将一级/二级/三级/四级标题合并为一个下拉菜单：
 * 按钮显示当前激活的标题级别图标，点击展开菜单切换标题级别。
 * 下拉列表通过 createPortal 渲染到 document.body，位置由锚点计算，
 * 避免被工具栏 overflow-x-auto 容器裁剪遮挡。
 */
import { useState, useEffect, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import {
  ChevronDownIcon,
  HeadingIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
} from 'lucide-react'
import { TooltipWrap } from './ToolbarBtn'
import { useAnchorPosition } from './useAnchorPosition'

interface HeadingSelectProps {
  editor: Editor | null
}

/** 标题级别配置：1~4 级，菜单内以字号差异体现层级 */
const HEADING_LEVELS = [
  { level: 1, label: '标题 1', short: 'H1', Icon: Heading1Icon, sizeClass: 'text-sm font-bold' },
  { level: 2, label: '标题 2', short: 'H2', Icon: Heading2Icon, sizeClass: 'text-sm font-bold' },
  { level: 3, label: '标题 3', short: 'H3', Icon: Heading3Icon, sizeClass: 'text-sm font-semibold' },
  { level: 4, label: '标题 4', short: 'H4', Icon: Heading4Icon, sizeClass: 'text-sm font-medium' },
] as const

export const HeadingSelect = memo(function HeadingSelect({ editor }: HeadingSelectProps) {
  const activeLevel = HEADING_LEVELS.find((h) => editor?.isActive('heading', { level: h.level }) ?? false)
  const ActiveIcon = activeLevel?.Icon ?? HeadingIcon
  const [open, setOpen] = useState(false)
  /** 锚点容器 ref（按钮 + 定位基准） */
  const anchorRef = useRef<HTMLDivElement>(null)
  /** 下拉弹窗 ref（点击外部关闭检测） */
  const popoverRef = useRef<HTMLDivElement>(null)
  const pos = useAnchorPosition(anchorRef)

  // 点击外部关闭（锚点或弹窗内部均不关闭）
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={anchorRef} className="relative flex items-center shrink-0">
      <TooltipWrap title="标题">
        <button
          onClick={() => setOpen((v) => !v)}
          className={open ? 'flex items-center gap-0.5 p-1.5 rounded transition-colors bg-primary/10 text-primary shrink-0' : 'flex items-center gap-0.5 p-1.5 rounded transition-colors text-muted-foreground hover:bg-muted hover:text-foreground shrink-0'}
        >
          <ActiveIcon className="w-4 h-4" />
          <ChevronDownIcon className="w-3 h-3" />
        </button>
      </TooltipWrap>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 bg-popover border rounded-lg shadow-lg py-1 min-w-36"
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          >
            <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground pointer-events-none">
              标题
            </div>
            {HEADING_LEVELS.map((h) => {
              const isActive = editor?.isActive('heading', { level: h.level }) ?? false
              return (
                <button
                  key={h.level}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor?.chain().focus().toggleHeading({ level: h.level }).run()
                    setOpen(false)
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-1.5 transition-colors ${
                    isActive ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span className={h.sizeClass}>{h.label}</span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">{h.short}</span>
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
})
