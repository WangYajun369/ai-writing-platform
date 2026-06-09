/**
 * 外观配置区块 —— 主题 / 护眼模式 / 字体 / 字号 / 网格大小
 */
import { MinusIcon, PlusIcon } from 'lucide-react'
import { OptionGroup, type OptionItem } from './shared'

interface AppearanceSectionProps {
  theme: string
  eyeCareMode: string
  fontFamily: string
  fontSize: number
  gridSize: string
  onThemeChange: (t: string) => void
  onEyeCareChange: (m: string) => void
  onFontFamilyChange: (f: string) => void
  onFontSizeChange: (s: number) => void
  onGridSizeChange: (s: string) => void
}

const THEME_OPTIONS: OptionItem[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

const EYECARE_OPTIONS: OptionItem[] = [
  { value: 'off', label: '关闭' },
  { value: 'warm', label: '暖黄色', color: 'bg-[#f5efdb]' },
  { value: 'green', label: '豆沙绿', color: 'bg-[#d7e8d0]' },
]

const FONT_OPTIONS: OptionItem[] = [
  { value: 'yahei', label: '微软雅黑' },
  { value: 'simhei', label: '黑体' },
  { value: 'simsun', label: '宋体' },
  { value: 'kaiti', label: '楷体' },
]

const GRID_OPTIONS: OptionItem[] = [
  { value: 'small', label: '紧凑', desc: '更多列更密' },
  { value: 'medium', label: '标准', desc: '默认大小' },
  { value: 'large', label: '宽松', desc: '更大更敞' },
]

export function AppearanceSection({
  theme,
  eyeCareMode,
  fontFamily,
  fontSize,
  gridSize,
  onThemeChange,
  onEyeCareChange,
  onFontFamilyChange,
  onFontSizeChange,
  onGridSizeChange,
}: AppearanceSectionProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">外观设置</h2>

      {/* 主题 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">主题</label>
        <OptionGroup options={THEME_OPTIONS} value={theme} onChange={onThemeChange} />
      </div>

      {/* 护眼模式 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">护眼模式</label>
        <p className="text-xs text-muted-foreground">选择舒适的背景色，减轻长时间写作的视觉疲劳</p>
        <OptionGroup options={EYECARE_OPTIONS} value={eyeCareMode} onChange={onEyeCareChange} />
      </div>

      {/* 写作字体 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">写作字体</label>
        <p className="text-xs text-muted-foreground">选择编辑器中使用的字体，营造不同的写作氛围</p>
        <OptionGroup options={FONT_OPTIONS} value={fontFamily} onChange={onFontFamilyChange} />
      </div>

      {/* 字体大小 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">字体大小</label>
        <p className="text-xs text-muted-foreground">调整编辑器字体大小（12px - 24px）</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onFontSizeChange(Math.max(12, fontSize - 1))}
            disabled={fontSize <= 12}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-muted hover:bg-muted/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <MinusIcon className="w-4 h-4" />
          </button>
          <span className="text-sm font-mono min-w-12 text-center">{fontSize}px</span>
          <button
            onClick={() => onFontSizeChange(Math.min(24, fontSize + 1))}
            disabled={fontSize >= 24}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-muted hover:bg-muted/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <PlusIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 作品列表网格大小 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">作品列表网格大小</label>
        <p className="text-xs text-muted-foreground">调整作品列表页网格视图的卡片大小和间距</p>
        <OptionGroup options={GRID_OPTIONS} value={gridSize} onChange={onGridSizeChange} />
      </div>
    </div>
  )
}
