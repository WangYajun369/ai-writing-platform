/**
 * BookTypePicker — 作品类型选择器
 *
 * 新建 / 编辑作品弹窗共用的类型选择控件，选项来自 `lib/book-types.ts` 值域表。
 * 以卡片网格呈现，选中项高亮，并在下方显示当前选中类型的说明文案。
 */
import { BOOK_TYPES, normalizeBookType } from '@/lib/book-types'

interface BookTypePickerProps {
  /** 当前选中的类型原始值（可能是存量作品的空字符串） */
  value: string
  /** 选中变更回调，回传值域内的合法 id */
  onChange: (value: string) => void
}

// 组件：BookTypePicker 作品类型卡片选择器
export default function BookTypePicker({ value, onChange }: BookTypePickerProps) {
  const current = normalizeBookType(value)

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        {BOOK_TYPES.map((t) => {
          const selected = t.id === current
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              aria-pressed={selected}
              className={[
                'text-left rounded-lg border px-3 py-2 transition-colors',
                selected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/40 hover:bg-muted/50',
              ].join(' ')}
            >
              <span
                className={[
                  'block text-sm font-medium',
                  selected ? 'text-primary' : 'text-foreground',
                ].join(' ')}
              >
                {t.label}
              </span>
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {BOOK_TYPES.find((t) => t.id === current)?.description}
      </p>
    </div>
  )
}
