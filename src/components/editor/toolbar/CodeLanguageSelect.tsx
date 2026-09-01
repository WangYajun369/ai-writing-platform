/**
 * 代码块语言选择器
 *
 * 在光标位于代码块内时显示，允许切换代码块的语言以实现语法高亮。
 * 下拉列表通过 createPortal 渲染到 document.body，位置由锚点计算，
 * 避免被工具栏 overflow-x-auto 容器裁剪遮挡。
 */
import { useState, useEffect, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { ChevronDownIcon } from 'lucide-react'
import { TooltipWrap } from './ToolbarBtn'
import { CODE_LANGUAGES } from './constants'
import { useAnchorPosition } from './useAnchorPosition'

interface CodeLanguageSelectProps {
  editor: Editor | null
}

export const CodeLanguageSelect = memo(function CodeLanguageSelect({ editor }: CodeLanguageSelectProps) {
  const currentLang = (editor?.getAttributes('codeBlock').language ?? 'plaintext') as string
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

  const currentLabel = CODE_LANGUAGES.find((l) => l.value === currentLang)?.label ?? currentLang

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <TooltipWrap title="选择代码语言">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 whitespace-nowrap"
        >
          <span>{currentLabel}</span>
          <ChevronDownIcon className="w-3 h-3" />
        </button>
      </TooltipWrap>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 bg-popover border rounded-lg shadow-lg py-1 max-h-64 overflow-y-auto min-w-36"
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          >
            {CODE_LANGUAGES.map((lang) => (
              <button
                key={lang.value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor?.chain().focus().updateAttributes('codeBlock', { language: lang.value }).run()
                  setOpen(false)
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  currentLang === lang.value
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground hover:bg-muted'
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
})
