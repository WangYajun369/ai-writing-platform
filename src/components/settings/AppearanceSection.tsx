/**
 * 外观配置区块 —— 主题 / 护眼模式 / 作品列表网格大小
 *
 * 偏好存取：受控组件，值由 SettingsPage 从 usePreferencesStore 读取，
 * 各 onChange 回调其 setter（内部持久化到后端 config）。
 *
 * 职责边界：**只负责"外观"语义**。编辑器专属的字体与字号已迁至
 * 编辑设置（[EditorConfigSection]），避免"外观"里混入编辑器设置。
 */
import { OptionGroup, type OptionItem } from './shared'
import type { EyeCareMode, GridSizeOption, ThemeMode } from '@/stores/preferencesStore'

interface AppearanceSectionProps {
  theme: ThemeMode
  eyeCareMode: EyeCareMode
  gridSize: GridSizeOption
  onThemeChange: (t: ThemeMode) => void
  onEyeCareChange: (m: EyeCareMode) => void
  onGridSizeChange: (s: GridSizeOption) => void
}

const THEME_OPTIONS: readonly OptionItem<ThemeMode>[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

const EYECARE_OPTIONS: readonly OptionItem<EyeCareMode>[] = [
  { value: 'off', label: '关闭' },
  { value: 'warm', label: '暖黄色', color: 'bg-[#f5efdb]' },
  { value: 'green', label: '豆沙绿', color: 'bg-[#d7e8d0]' },
]

const GRID_OPTIONS: readonly OptionItem<GridSizeOption>[] = [
  { value: 'small', label: '紧凑', desc: '更多列更密' },
  { value: 'medium', label: '标准', desc: '默认大小' },
  { value: 'large', label: '宽松', desc: '更大更敞' },
]

export function AppearanceSection({
  theme,
  eyeCareMode,
  gridSize,
  onThemeChange,
  onEyeCareChange,
  onGridSizeChange,
}: AppearanceSectionProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">外观设置</h2>

      {/* 主题 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">主题</label>
        <OptionGroup
          ariaLabel="主题"
          options={THEME_OPTIONS}
          value={theme}
          onChange={onThemeChange}
        />
      </div>

      {/* 护眼模式 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">护眼模式</label>
        <p className="text-xs text-muted-foreground">选择舒适的背景色，减轻长时间写作的视觉疲劳</p>
        <OptionGroup
          ariaLabel="护眼模式"
          options={EYECARE_OPTIONS}
          value={eyeCareMode}
          onChange={onEyeCareChange}
        />
      </div>

      {/* 作品列表网格大小 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">作品列表网格大小</label>
        <p className="text-xs text-muted-foreground">调整作品列表页网格视图的卡片大小和间距</p>
        <OptionGroup
          ariaLabel="作品列表网格大小"
          options={GRID_OPTIONS}
          value={gridSize}
          onChange={onGridSizeChange}
        />
      </div>
    </div>
  )
}
