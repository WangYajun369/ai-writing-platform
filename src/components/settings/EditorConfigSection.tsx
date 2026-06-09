/**
 * 编辑配置区块 —— 编辑器显示宽度
 */
import { OptionGroup, type OptionItem } from './shared'

interface EditorConfigSectionProps {
  editorWidth: string
  onEditorWidthChange: (w: string) => void
}

const WIDTH_OPTIONS: OptionItem[] = [
  { value: 'mobile', label: '手机宽度', desc: '约 448px', icon: '📱' },
  { value: 'standard', label: '标准宽度', desc: '约 768px', icon: '💻' },
  { value: 'wide', label: '宽幅宽度', desc: '约 1024px', icon: '🖥️' },
]

export function EditorConfigSection({ editorWidth, onEditorWidthChange }: EditorConfigSectionProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">编辑设置</h2>

      <div className="space-y-2">
        <label className="text-sm font-medium">编辑器显示宽度</label>
        <p className="text-xs text-muted-foreground">调整编辑区域的最大显示宽度，适配不同屏幕和写作习惯</p>
        <OptionGroup options={WIDTH_OPTIONS} value={editorWidth} onChange={onEditorWidthChange} />
      </div>
    </div>
  )
}
