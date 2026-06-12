/**
 * 表格操作弹窗
 *
 * 提供表格网格尺寸选择器和行/列添加操作。
 * gridHover 状态内化到组件内部，不再由父组件管理。
 */
import { useState, memo } from 'react'
import type { Editor } from '@tiptap/core'
import {
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  PlusIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils.ts'

const MAX_ROWS = 6
const MAX_COLS = 6

interface TablePopoverProps {
  editor: Editor | null
  onClose: () => void
}

export const TablePopover = memo(function TablePopover({
  editor,
  onClose,
  ref,
}: TablePopoverProps & { ref: React.Ref<HTMLDivElement> }) {
  const [gridHover, setGridHover] = useState({ rows: 3, cols: 3 })
  const isInTable = editor?.isActive('table') ?? false

  function handleInsertTable() {
    editor
      ?.chain()
      .focus()
      .insertTable({ rows: gridHover.rows, cols: gridHover.cols, withHeaderRow: true })
      .run()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 z-30 bg-popover border rounded-lg shadow-lg p-3 min-w-52"
    >
      {/* --- 表格内行/列添加操作 --- */}
      {isInTable && (
        <>
          <span className="text-xs font-medium text-muted-foreground block mb-2">添加行/列</span>

          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-xs text-muted-foreground w-8">行：</span>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addRowBefore().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在上方插入行"
            >
              <ArrowUpIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addRowAfter().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在下方插入行"
            >
              <ArrowDownIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="flex items-center gap-1 mb-2">
            <span className="text-xs text-muted-foreground w-8">列：</span>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addColumnBefore().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在左侧插入列"
            >
              <ArrowLeftToLineIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addColumnAfter().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在右侧插入列"
            >
              <ArrowRightToLineIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="h-px bg-border my-2" />
        </>
      )}

      {/* --- 网格尺寸选择器 --- */}
      <span className="text-xs font-medium text-muted-foreground block mb-2">插入表格</span>

      <div className="flex justify-center mb-2">
        <div
          className="inline-grid gap-0.5"
          style={{ gridTemplateColumns: `repeat(${MAX_COLS}, 1.5rem)` }}
        >
          {Array.from({ length: MAX_ROWS }, (_, row) =>
            Array.from({ length: MAX_COLS }, (_, col) => {
              const isActive = row < gridHover.rows && col < gridHover.cols
              return (
                <div
                  key={`${row}-${col}`}
                  onMouseEnter={() => setGridHover({ rows: row + 1, cols: col + 1 })}
                  onClick={handleInsertTable}
                  className={cn(
                    'w-6 h-6 rounded-sm border cursor-pointer transition-colors',
                    isActive
                      ? 'bg-primary/30 border-primary/50'
                      : 'border-border hover:border-muted-foreground/40',
                  )}
                />
              )
            }),
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground mb-2">
        {gridHover.rows} × {gridHover.cols}
      </p>

      {/* 取消按钮 */}
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="w-full py-1.5 text-xs rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        取消
      </button>
    </div>
  )
})
