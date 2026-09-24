/**
 * DraggableChapter — 可拖拽的章节条目组件
 *
 * 交互与结构：
 * - 同一 DOM 同时注册 useDraggable 与 useDroppable，dndId 由 utils.dndId 生成，
 *   供 useOutlineDnd 做碰撞检测（跨卷置入/同级排序均落在同一 id 上）
 * - 单击选中、双击进入行内重命名（Enter 提交 / Esc 放弃）
 * - 状态标签可点击循环切换：大纲 → 草稿 → 精修 → 定稿
 * - 拖拽手柄与删除按钮 hover 时浮现；isOver / isCrossGroupOver 用于区分
 *   普通悬停与跨卷悬停，配合前后 DropIndicator 精确指示插入落点
 */
import { useState, useCallback, memo } from 'react'
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

export const DraggableChapter = memo(function DraggableChapter({
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

  // 合并拖拽与投放的 ref，让同一节点同时扮演「可拖」与「可落」两种角色
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setDraggableRef(node)
      setDroppableRef(node)
    },
    [setDraggableRef, setDroppableRef],
  )

  /** 提交行内重命名：内容非空且有变化才回调父级，随后无论成功与否退出编辑态 */
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
          className="p-0.5 rounded hover:bg-muted-foreground/20 cursor-grab active:cursor-grabbing touch-none shrink-0 opacity-0 group-hover:opacity-100"
          {...listeners}
        >
          <GripVerticalIcon className="w-3 h-3" />
        </button>
        <FileTextIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />

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
            'text-xs px-1.5 py-0.5 rounded-full shrink-0 cursor-pointer hover:opacity-80 transition-opacity',
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
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive shrink-0"
          title="删除章节"
        >
          <Trash2Icon className="w-3.5 h-3.5" />
        </button>
      </div>
      <DropIndicator position="after" active={showDropAfter} />
    </div>
  )
})

export default DraggableChapter
