/**
 * QuickHints — 快捷提示词
 *
 * 仅在 AI 聊天空对话（AiSidePanel 判断 messages.length === 0）时展示；
 * 点击仅将 QUICK_HINTS 预设提示词写入输入框，不直接发送。
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
