/**
 * 编辑配置区块 —— 编辑器显示宽度 / 写作字体 / 字体大小
 *
 * 偏好存取：受控组件，值由 SettingsPage 从 usePreferencesStore 读取，
 * 变更经各 onChange 回调 setter 持久化到后端 config；默认值 'standard' / 'yahei' / 16。
 *
 * 职责边界：编辑器专属的设置都归这里（宽度、字体、字号）；
 * 「外观」只保留主题 / 护眼 / 书库网格。
 */
import { MinusIcon, PlusIcon } from 'lucide-react'
import { OptionGroup, type OptionItem } from './shared'
import type { EditorWidthOption, FontFamilyOption } from '@/stores/preferencesStore'

/** 编辑器字号允许范围（与前端 DOM 应用逻辑、后端默认值保持一致） */
const FONT_SIZE_MIN = 12
const FONT_SIZE_MAX = 24

interface EditorConfigSectionProps {
  editorWidth: EditorWidthOption
  fontFamily: FontFamilyOption
  fontSize: number
  onEditorWidthChange: (w: EditorWidthOption) => void
  onFontFamilyChange: (f: FontFamilyOption) => void
  onFontSizeChange: (s: number) => void
}

const WIDTH_OPTIONS: readonly OptionItem<EditorWidthOption>[] = [
  { value: 'mobile', label: '手机宽度', desc: '约 448px', icon: '📱' },
  { value: 'standard', label: '标准宽度', desc: '约 768px', icon: '💻' },
  { value: 'wide', label: '宽幅宽度', desc: '约 1024px', icon: '🖥️' },
]

const FONT_OPTIONS: readonly OptionItem<FontFamilyOption>[] = [
  { value: 'yahei', label: '微软雅黑' },
  { value: 'simhei', label: '黑体' },
  { value: 'simsun', label: '宋体' },
  { value: 'kaiti', label: '楷体' },
]

export function EditorConfigSection({
  editorWidth,
  fontFamily,
  fontSize,
  onEditorWidthChange,
  onFontFamilyChange,
  onFontSizeChange,
}: EditorConfigSectionProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">编辑设置</h2>

      <div className="space-y-2">
        <label className="text-sm font-medium">编辑器显示宽度</label>
        <p className="text-xs text-muted-foreground">调整编辑区域的最大显示宽度，适配不同屏幕和写作习惯</p>
        <OptionGroup
          ariaLabel="编辑器显示宽度"
          options={WIDTH_OPTIONS}
          value={editorWidth}
          onChange={onEditorWidthChange}
        />
      </div>

      {/* 写作字体 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">写作字体</label>
        <p className="text-xs text-muted-foreground">选择编辑器中使用的字体，营造不同的写作氛围</p>
        <OptionGroup
          ariaLabel="写作字体"
          options={FONT_OPTIONS}
          value={fontFamily}
          onChange={onFontFamilyChange}
        />
      </div>

      {/* 字体大小 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">字体大小</label>
        <p className="text-xs text-muted-foreground">
          调整编辑器字体大小（{FONT_SIZE_MIN}px - {FONT_SIZE_MAX}px）
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="减小字号"
            onClick={() => onFontSizeChange(Math.max(FONT_SIZE_MIN, fontSize - 1))}
            disabled={fontSize <= FONT_SIZE_MIN}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-muted hover:bg-muted/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <MinusIcon className="w-4 h-4" />
          </button>
          <span className="text-sm font-mono min-w-12 text-center">{fontSize}px</span>
          <button
            type="button"
            aria-label="增大字号"
            onClick={() => onFontSizeChange(Math.min(FONT_SIZE_MAX, fontSize + 1))}
            disabled={fontSize >= FONT_SIZE_MAX}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-muted hover:bg-muted/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <PlusIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
