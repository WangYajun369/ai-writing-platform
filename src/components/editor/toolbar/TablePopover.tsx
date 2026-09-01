/**
 * 表格操作弹窗
 *
 * 提供表格网格尺寸选择器、行/列添加操作，以及合并/拆分单元格操作。
 * gridHover 状态内化到组件内部，不再由父组件管理。
 * 合并/拆分的可用性由父组件（EditorToolbar）计算后通过 props 传入。
 *
 * 弹窗通过 createPortal 渲染到 document.body，位置由 anchorRef 锚点计算，
 * 避免被工具栏 overflow-x-auto 容器裁剪遮挡。
 */
import { useState, memo } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/react'
import {
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  PlusIcon,
  TableCellsMergeIcon,
  TableCellsSplitIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { isEditorUsable } from '@/lib/editor-guard.ts'
import { useAnchorPosition } from './useAnchorPosition'

const MAX_ROWS = 6
const MAX_COLS = 6

interface TablePopoverProps {
  editor: Editor | null
  onClose: () => void
  /** 当前是否选中了多个单元格，可执行合并 */
  canMergeCells?: boolean
  /** 当前单元格是否由合并产生（colspan/rowspan > 1），可执行拆分 */
  canSplitCell?: boolean
  /** 触发按钮容器（用于计算弹出位置） */
  anchorRef: React.RefObject<HTMLDivElement | null>
  /** 弹窗容器 ref（用于点击外部关闭检测） */
  popoverRef: React.RefObject<HTMLDivElement | null>
}

export const TablePopover = memo(function TablePopover({
  editor,
  onClose,
  canMergeCells = false,
  canSplitCell = false,
  anchorRef,
  popoverRef,
}: TablePopoverProps) {
  const [gridHover, setGridHover] = useState({ rows: 3, cols: 3 })
  // 已销毁的编辑器实例调用 isActive 会抛异常，需先校验
  const usableEditor = isEditorUsable(editor) ? editor : null
  const isInTable = usableEditor?.isActive('table') ?? false
  const pos = useAnchorPosition(anchorRef)

  function handleInsertTable() {
    usableEditor
      ?.chain()
      .focus()
      .insertTable({ rows: gridHover.rows, cols: gridHover.cols, withHeaderRow: true })
      .run()
    onClose()
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-50 bg-popover border rounded-lg shadow-lg p-3 min-w-52"
      style={pos ? { top: pos.top, right: pos.right } : { top: -9999, left: -9999 }}
    >
      {/* --- 表格内行/列添加操作 --- */}
      {isInTable && (
        <>
          <span className="text-xs font-medium text-muted-foreground block mb-2">添加行/列</span>
          <p className="text-[11px] leading-snug text-muted-foreground/70 mb-2">
            提示：将鼠标移到表格上方，拖动列边线可调整列宽
          </p>

          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-xs text-muted-foreground w-8">行：</span>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => usableEditor?.chain().focus().addRowBefore().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在上方插入行"
            >
              <ArrowUpIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => usableEditor?.chain().focus().addRowAfter().run()}
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
              onClick={() => usableEditor?.chain().focus().addColumnBefore().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在左侧插入列"
            >
              <ArrowLeftToLineIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => usableEditor?.chain().focus().addColumnAfter().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在右侧插入列"
            >
              <ArrowRightToLineIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="h-px bg-border my-2" />

          {/* --- 合并 / 拆分单元格 --- */}
          <span className="text-xs font-medium text-muted-foreground block mb-1.5">合并 / 拆分单元格</span>
          <p className="text-[11px] leading-snug text-muted-foreground/70 mb-2">
            合并：先拖动鼠标选中相邻的多个单元格
          </p>
          <div className="flex items-center gap-1 mb-2">
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => usableEditor?.chain().focus().mergeCells().run()}
              disabled={!canMergeCells}
              className={cn(
                'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors',
                canMergeCells
                  ? 'hover:bg-muted'
                  : 'text-muted-foreground/40 cursor-not-allowed',
              )}
              title="合并选中的多个单元格"
            >
              <TableCellsMergeIcon className="w-3 h-3" />
              合并
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => usableEditor?.chain().focus().splitCell().run()}
              disabled={!canSplitCell}
              className={cn(
                'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors',
                canSplitCell
                  ? 'hover:bg-muted'
                  : 'text-muted-foreground/40 cursor-not-allowed',
              )}
              title="拆分当前合并单元格"
            >
              <TableCellsSplitIcon className="w-3 h-3" />
              拆分
            </button>
          </div>
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
    </div>,
    document.body,
  )
})
