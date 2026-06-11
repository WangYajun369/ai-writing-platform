/**
 * DraggableChapter — 可拖拽的章节条目组件
 * 支持选中高亮、行内重命名、状态切换、删除操作
 */
import { useState, useCallback } from 'react'
import {
  FileTextIcon,
  GripVerticalIcon,
  Trash2Icon,
} from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { CHAPTER_STATUS_CONFIG } from '@/lib/utils'
import { dndId } from './utils'
import type { Chapter } from '@/types'
import type { FlatItem } from './types'
import { DropIndicator } from './OutlineDragDrop'

interface DraggableChapterProps {
  item: FlatItem & { type: 'chapter' }
  isActive: boolean
  isOver: boolean
  isCrossGroupOver: boolean
  showDropBefore: boolean
  showDropAfter: boolean
  onSelect: () => void
  onRename: (title: string) => Promise<void>
  onDelete: () => void
  onStatusChange: (newStatus: Chapter['status']) => Promise<void>
}

export default function DraggableChapter({
  item,
  isActive,
  isOver,
  isCrossGroupOver,
  showDropBefore,
  showDropAfter,
  onSelect,
  onRename,
  onDelete,
  onStatusChange,
}: DraggableChapterProps) {
  const id = dndId(item)
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({ id })
  const { setNodeRef: setDroppableRef } = useDroppable({ id })
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(item.chapter.title)
  const statusCfg = CHAPTER_STATUS_CONFIG[item.chapter.status]

  /** 点击状态标签循环切换 */
  const cycleStatus = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const STATUS_ORDER: Chapter['status'][] = ['outline', 'draft', 'polishing', 'finished']
    const currentIdx = STATUS_ORDER.indexOf(item.chapter.status)
    const nextStatus = STATUS_ORDER[(currentIdx + 1) % STATUS_ORDER.length]
    await onStatusChange(nextStatus)
  }

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setDraggableRef(node)
      setDroppableRef(node)
    },
    [setDraggableRef, setDroppableRef],
  )

  async function handleRename() {
    if (editValue.trim() && editValue !== item.chapter.title) {
      await onRename(editValue.trim())
    }
    setEditing(false)
  }

  return (
    <div className="relative">
      <DropIndicator position="before" active={showDropBefore} />
      <div
        ref={ref}
        onClick={() => {
          if (!isActive) onSelect()
        }}
        onDoubleClick={() => setEditing(true)}
        className={cn(
          'flex items-center gap-1.5 px-1.5 py-1.5 text-sm cursor-pointer group rounded-sm mx-1 transition-all duration-200',
          item.indent && 'pl-6',
          isActive
            ? 'bg-primary/10 text-primary'
            : 'hover:bg-muted text-foreground',
          isDragging && 'opacity-30 scale-95',
          isCrossGroupOver && 'ring-2 ring-primary/50 bg-primary/5',
          !isCrossGroupOver && isOver && 'bg-accent/50',
        )}
        {...attributes}
      >
        <button
          className="p-0.5 rounded hover:bg-muted-foreground/20 cursor-grab active:cursor-grabbing touch-none flex-shrink-0 opacity-0 group-hover:opacity-100"
          {...listeners}
        >
          <GripVerticalIcon className="w-3 h-3" />
        </button>
        <FileTextIcon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />

        {editing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 bg-transparent outline-none border-b border-primary text-sm"
          />
        ) : (
          <span className="flex-1 truncate">{item.chapter.title}</span>
        )}

        <span
          onClick={cycleStatus}
          title="点击切换章节状态（大纲/草稿/精修/定稿）"
          className={cn(
            'text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity',
            statusCfg.color,
          )}
        >
          {statusCfg.label}
        </span>

        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive flex-shrink-0"
          title="删除章节"
        >
          <Trash2Icon className="w-3.5 h-3.5" />
        </button>
      </div>
      <DropIndicator position="after" active={showDropAfter} />
    </div>
  )
}
