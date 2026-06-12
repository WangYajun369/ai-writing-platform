/**
 * 字体颜色选择器弹窗
 *
 * 展示预设色块网格 + 自定义颜色输入 + 清除颜色按钮。
 */
import { useState, memo } from 'react'
import { PRESET_COLORS } from './constants'

interface ColorPickerPopoverProps {
  currentColor: string | null
  onSelectColor: (color: string | null) => void
}

export const ColorPickerPopover = memo(function ColorPickerPopover({
  currentColor,
  onSelectColor,
  ref,
}: ColorPickerPopoverProps & { ref: React.Ref<HTMLDivElement> }) {
  const [customColor, setCustomColor] = useState('#000000')

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 z-30 bg-popover border rounded-lg shadow-lg p-3 min-w-52"
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">字体颜色</span>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelectColor(null)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="清除颜色"
        >
          还原默认
        </button>
      </div>

      {/* 当前颜色指示 */}
      {currentColor && (
        <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
          <span>当前：</span>
          <span
            className="inline-block w-4 h-4 rounded border border-border"
            style={{ backgroundColor: currentColor }}
          />
          <span className="font-mono">{currentColor}</span>
        </div>
      )}

      {/* 预设颜色网格 */}
      <div className="grid grid-cols-6 gap-1.5 mb-2">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelectColor(color)}
            className="w-7 h-7 rounded border border-border hover:scale-110 transition-transform"
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>

      {/* 分隔线 */}
      <div className="h-px bg-border mb-2" />

      {/* 自定义颜色 */}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={customColor}
          onChange={(e) => setCustomColor(e.target.value)}
          className="w-8 h-8 rounded border border-border cursor-pointer p-0 bg-transparent"
        />
        <span className="text-xs text-muted-foreground font-mono flex-1">{customColor}</span>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelectColor(customColor)}
          className="px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
        >
          应用
        </button>
      </div>
    </div>
  )
})
