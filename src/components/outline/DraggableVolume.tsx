/**
 * DraggableVolume — 可拖拽的卷条目组件
 * 支持折叠/展开、行内重命名、新建章节、删除操作
 */
import { useState, useCallback } from 'react'
import {
  PlusIcon,
  FolderIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  Trash2Icon,
} from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { dndId } from './utils'
import type { FlatItem } from './types'
import { DropIndicator } from './OutlineDragDrop'

interface DraggableVolumeProps {
  item: FlatItem & { type: 'volume' }
  isOver: boolean
  isChapterOver: boolean
  showDropBefore: boolean
  showDropAfter: boolean
  onToggle: () => void
  onAddChapter: () => void
  onDelete: () => void
  onRename: (newTitle: string) => Promise<void>
}

export default function DraggableVolume({
  item,
  isOver,
  isChapterOver,
  showDropBefore,
  showDropAfter,
  onToggle,
  onAddChapter,
  onDelete,
  onRename,
}: DraggableVolumeProps) {
  const id = dndId(item)
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({ id })
  const { setNodeRef: setDroppableRef } = useDroppable({ id })
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(item.volume.title)

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setDraggableRef(node)
      setDroppableRef(node)
    },
    [setDraggableRef, setDroppableRef],
  )

  async function handleRename() {
    if (editValue.trim() && editValue !== item.volume.title) {
      await onRename(editValue.trim())
    }
    setEditing(false)
  }

  return (
    <div className="relative">
      <DropIndicator position="before" active={showDropBefore} />
      <div
        ref={ref}
        className={cn(
          'flex items-center gap-1 px-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted cursor-pointer group rounded-sm mx-1 transition-all duration-200',
          isDragging && 'opacity-30 scale-95',
          isChapterOver && 'ring-2 ring-primary/50 bg-primary/10 text-primary',
          !isChapterOver && isOver && 'bg-accent/50',
        )}
        onClick={() => {
          if (!editing) onToggle()
        }}
        onDoubleClick={() => {
          setEditValue(item.volume.title)
          setEditing(true)
        }}
        {...attributes}
      >
        <button
          className="p-0.5 rounded hover:bg-muted-foreground/20 cursor-grab active:cursor-grabbing touch-none flex-shrink-0 transition-transform hover:scale-110"
          {...listeners}
        >
          <GripVerticalIcon className="w-3 h-3" />
        </button>
        {item.collapsed ? (
          <ChevronRightIcon className="w-3 h-3 flex-shrink-0" />
        ) : (
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        )}
        <FolderIcon className="w-3 h-3 flex-shrink-0" />
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
            className="flex-1 bg-transparent outline-none border-b border-primary text-foreground text-xs"
          />
        ) : (
          <span className="flex-1 truncate">{item.volume.title}</span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onAddChapter()
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted-foreground/20"
          title="新建章节"
        >
          <PlusIcon className="w-3 h-3" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
          title="删除卷"
        >
          <Trash2Icon className="w-3 h-3" />
        </button>
      </div>
      <DropIndicator position="after" active={showDropAfter} />
    </div>
  )
}
