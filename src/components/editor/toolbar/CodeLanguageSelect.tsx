/**
 * 代码块语言选择器
 *
 * 在光标位于代码块内时显示，允许切换代码块的语言以实现语法高亮。
 */
import { useState, useEffect, useRef, memo } from 'react'
import type { Editor } from '@tiptap/react'
import { ChevronDownIcon } from 'lucide-react'
import { TooltipWrap } from './ToolbarBtn'
import { CODE_LANGUAGES } from './constants'

interface CodeLanguageSelectProps {
  editor: Editor | null
}

export const CodeLanguageSelect = memo(function CodeLanguageSelect({ editor }: CodeLanguageSelectProps) {
  const currentLang = (editor?.getAttributes('codeBlock').language ?? 'plaintext') as string
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const currentLabel = CODE_LANGUAGES.find((l) => l.value === currentLang)?.label ?? currentLang

  return (
    <div ref={ref} className="relative">
      <TooltipWrap title="选择代码语言">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <span>{currentLabel}</span>
          <ChevronDownIcon className="w-3 h-3" />
        </button>
      </TooltipWrap>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 bg-popover border rounded-lg shadow-lg py-1 max-h-64 overflow-y-auto min-w-36">
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
        </div>
      )}
    </div>
  )
})
