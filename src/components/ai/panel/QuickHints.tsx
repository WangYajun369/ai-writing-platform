/**
 * 快捷提示词组件
 */
import { memo } from 'react'
import { QUICK_HINTS } from '../useAiChat'

interface QuickHintsProps {
  onSelect: (hint: string) => void
}

export const QuickHints = memo(function QuickHints({ onSelect }: QuickHintsProps) {
  return (
    <div className="px-3 pb-2 flex gap-1.5 flex-wrap">
      {QUICK_HINTS.map((hint) => (
        <button
          key={hint}
          onClick={() => onSelect(hint)}
          className="text-xs bg-muted hover:bg-muted/80 px-2.5 py-1.5 rounded-full transition-colors"
        >
          {hint}
        </button>
      ))}
    </div>
  )
})
