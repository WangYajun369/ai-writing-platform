/**
 * OutlineDragDrop — 拖拽相关 UI 组件
 * 包含：DroppableUnassignedZone（未分卷区域投放）、VolumePreview、ChapterPreview、DropIndicator
 */
import { useDroppable } from '@dnd-kit/core'
import {
  GripVerticalIcon,
  FolderIcon,
  FileTextIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHAPTER_STATUS_CONFIG } from '@/lib/utils'
import type { Chapter, Volume } from '@/types'

// ==================== 插入指示器 ====================

export function DropIndicator({
  position,
  active,
}: {
  position: 'before' | 'after'
  active: boolean
}) {
  return (
    <div
      className={cn(
        'absolute left-1 right-1 h-0.5 bg-primary rounded-full z-10 shadow-sm shadow-primary/30 transition-all duration-200 origin-center animate-pulse-indicator',
        position === 'before' ? 'top-0' : 'bottom-0',
        active ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0',
      )}
    />
  )
}

// ==================== 未分卷区域投放 ====================

export function DroppableUnassignedZone({
  isOver,
  hasDraggingChapter,
}: {
  isOver: boolean
  hasDraggingChapter: boolean
}) {
  const id = 'unassigned-zone-__unassigned-zone__'
  const { setNodeRef } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mx-1 rounded transition-all duration-200 flex items-center justify-center',
        hasDraggingChapter ? 'h-5' : 'h-0',
        isOver && 'bg-primary/15 ring-1 ring-primary/40',
        !isOver && hasDraggingChapter && 'bg-muted/20',
      )}
    >
      {isOver && hasDraggingChapter && (
        <span className="text-[10px] text-primary/70">
          移出至最外层
        </span>
      )}
    </div>
  )
}

// ==================== 拖拽预览 ====================

export function VolumePreview({ volume }: { volume: Volume }) {
  return (
    <div className="animate-pop-in flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-card border border-border rounded shadow-lg">
      <GripVerticalIcon className="w-3 h-3 text-muted-foreground" />
      <FolderIcon className="w-3 h-3 text-muted-foreground" />
      <span className="truncate">{volume.title}</span>
    </div>
  )
}

export function ChapterPreview({ chapter }: { chapter: Chapter }) {
  const statusCfg = CHAPTER_STATUS_CONFIG[chapter.status]
  return (
    <div className="animate-pop-in flex items-center gap-1.5 px-3 py-1.5 text-sm bg-card border border-border rounded shadow-lg">
      <GripVerticalIcon className="w-3 h-3 text-muted-foreground" />
      <FileTextIcon className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="truncate">{chapter.title}</span>
      <span
        className={cn(
          'text-xs px-1.5 py-0.5 rounded-full flex-shrink-0',
          statusCfg.color,
        )}
      >
        {statusCfg.label}
      </span>
    </div>
  )
}
