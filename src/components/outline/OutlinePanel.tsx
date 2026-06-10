/**
 * OutlinePanel — 卷-章节目录树面板
 *
 * 展示书籍的卷-章节两级结构，支持：
 * - 新建卷/章节（弹窗输入 + 后端创建）
 * - 卷折叠/展开
 * - 虚拟化滚动渲染（@tanstack/react-virtual）
 * - 章节行内重命名与状态标签显示
 * - 拖拽排序（@dnd-kit）：卷在卷之间排序，章节在同级分组内排序
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import {
  PlusIcon,
  FolderIcon,
  FileTextIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  Trash2Icon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import type {
  DragStartEvent,
  DragEndEvent,
  DragMoveEvent,
  CollisionDetection,
} from '@dnd-kit/core'
import { useAppStore } from '@/stores/appStore'
import { chapterApi, volumeApi } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import type { Chapter, Volume } from '@/types'
import { CHAPTER_STATUS_CONFIG } from '@/lib/utils'

interface OutlinePanelProps {
  bookId: string
}

interface InputDialogState {
  open: boolean
  label: string
  defaultValue: string
  onSubmit: (value: string) => void
}

interface ConfirmDialogState {
  open: boolean
  title: string
  message: string
  onConfirm: () => void
  confirmLabel?: string
  danger?: boolean
}

// 拍平后的列表项
type FlatItem =
  | { type: 'chapter'; id: string; chapter: Chapter; indent: boolean }
  | { type: 'volume'; id: string; volume: Volume; collapsed: boolean }

/** 为 DnD 生成唯一标识 */
function dndId(item: FlatItem): string {
  return `${item.type}-${item.id}`
}

/** 获取章节所属分组（unassigned 或 volumeId） */
function chapterGroup(chapter: Chapter): string {
  return chapter.volumeId || '__unassigned__'
}

export default function OutlinePanel({ bookId }: OutlinePanelProps) {
  const {
    volumes,
    chapters,
    currentChapterId,
    setCurrentChapterId,
    addChapter,
    updateChapter,
    removeChapter,
    setVolumes,
    reorderVolumes,
    reorderChapters,
    moveChapterToVolume,
  } = useAppStore()

  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set())
  const [inputDialog, setInputDialog] = useState<InputDialogState>({
    open: false,
    label: '',
    defaultValue: '',
    onSubmit: () => {},
  })
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    onConfirm: () => {},
  })
  const [recycleBinOpen, setRecycleBinOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 拖拽状态
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{
    id: string
    position: 'before' | 'after'
  } | null>(null)
  const dropIndicatorRef = useRef<{
    id: string
    position: 'before' | 'after'
  } | null>(null)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)

  // 虚拟化
  const parentRef = useRef<HTMLDivElement>(null)

  // 拍平树形结构为线性列表
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = []

    // 未分卷章节
    const unassigned = chapters
      .filter((c) => !c.deletedAt && !c.volumeId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    for (const c of unassigned) {
      items.push({ type: 'chapter', id: c.id, chapter: c, indent: false })
    }

    // 分卷章节（排除已软删除的卷）
    const sortedVolumes = [...volumes]
      .filter((v) => !v.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    for (const vol of sortedVolumes) {
      items.push({
        type: 'volume',
        id: vol.id,
        volume: vol,
        collapsed: collapsedVolumes.has(vol.id),
      })
      if (!collapsedVolumes.has(vol.id)) {
        const volChapters = chapters
          .filter((c) => c.volumeId === vol.id && !c.deletedAt)
          .sort((a, b) => a.sortOrder - b.sortOrder)
        for (const c of volChapters) {
          items.push({ type: 'chapter', id: c.id, chapter: c, indent: true })
        }
      }
    }

    return items
  }, [chapters, volumes, collapsedVolumes])

  // 回收站内容（卷 + 章节，按删除时间倒序混合排列）
  const trashItems = useMemo(() => {
    const items: Array<
      | { type: 'volume'; data: Volume }
      | { type: 'chapter'; data: Chapter }
    > = []

    for (const v of volumes) {
      if (v.deletedAt) {
        items.push({ type: 'volume', data: v })
      }
    }

    for (const c of chapters) {
      if (c.deletedAt) {
        items.push({ type: 'chapter', data: c })
      }
    }

    items.sort(
      (a, b) =>
        new Date(b.data.deletedAt!).getTime() -
        new Date(a.data.deletedAt!).getTime(),
    )

    return items
  }, [volumes, chapters])

  // 当前拖拽中项（必须在 flatItems 之后）
  const activeItem = useMemo(
    () => flatItems.find((f) => dndId(f) === activeId) ?? null,
    [activeId, flatItems],
  )

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: activeId ? 9999 : 10, // 拖拽时渲染全部
  })

  // 折叠/展开时重新测量
  useEffect(() => {
    virtualizer.measure()
  }, [collapsedVolumes, virtualizer])

  // 对话框打开时聚焦
  useEffect(() => {
    if (inputDialog.open) {
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [inputDialog.open])

  // ---------- DnD ----------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  /** 自定义碰撞检测：卷只能拖到卷；章节可拖到卷或任意章节 */
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const collisions = closestCenter(args)
      return collisions.filter((collision) => {
        // 未分卷区域（不在 flatItems 中，独立 droppable）
        if (collision.id === 'unassigned-zone-__unassigned-zone__') {
          return activeItem?.type === 'chapter' && !!activeItem.chapter.volumeId
        }

        const collidedItem = flatItems.find((f) => dndId(f) === collision.id)
        if (!activeItem || !collidedItem) return false

        if (activeItem.type === 'volume') {
          return collidedItem.type === 'volume'
        }

        if (activeItem.type === 'chapter') {
          if (collidedItem.type === 'volume') return true
          if (collidedItem.type === 'chapter') return true
          return false
        }

        return false
      })
    },
    [activeItem, flatItems],
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
    const e = event.activatorEvent as PointerEvent
    if (e) {
      dragStartPos.current = { x: e.clientX, y: e.clientY }
    }
  }, [])

  /** 拖拽移动时：根据指针在目标元素上/下半区，决定插入位置指示器 */
  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const over = event.over
      if (!over || !dragStartPos.current || !activeItem) return

      const targetItem = flatItems.find((f) => dndId(f) === over.id)
      if (!targetItem) return

      // 显示 before/after 插入线（卷↔卷 / 章节↔章节，含跨组）
      if (
        (activeItem.type === 'volume' && targetItem.type === 'volume') ||
        (activeItem.type === 'chapter' && targetItem.type === 'chapter')
      ) {
        const currentY = dragStartPos.current.y + event.delta.y
        const rect = over.rect
        const midY = rect.top + rect.height / 2
        const indicator = {
          id: over.id as string,
          position: (currentY < midY ? 'before' : 'after') as 'before' | 'after',
        }
        setDropIndicator(indicator)
        dropIndicatorRef.current = indicator
      } else {
        setDropIndicator(null)
        dropIndicatorRef.current = null
      }
    },
    [activeItem, flatItems],
  )

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      const finalIndicator = dropIndicatorRef.current
      setActiveId(null)
      setOverId(null)
      setDropIndicator(null)
      dropIndicatorRef.current = null
      dragStartPos.current = null

      if (!over || active.id === over.id) return

      // ---------- 章节移到未分卷区域 ----------
      if (over.id === 'unassigned-zone-__unassigned-zone__') {
        const fromItem = flatItems.find((f) => dndId(f) === active.id)
        if (!fromItem || fromItem.type !== 'chapter') return
        if (!fromItem.chapter.volumeId) return
        try {
          await chapterApi.moveToVolume(fromItem.chapter.id, null)
          moveChapterToVolume(fromItem.chapter.id, null)
        } catch (err) {
          console.error('移动章节到未分卷区域失败', err)
        }
        return
      }

      const fromItem = flatItems.find((f) => dndId(f) === active.id)
      const toItem = flatItems.find((f) => dndId(f) === over.id)
      if (!fromItem || !toItem) return

      // ---------- 卷重排 ----------
      if (fromItem.type === 'volume' && toItem.type === 'volume') {
        const orderedVolumes = [...volumes].sort(
          (a, b) => a.sortOrder - b.sortOrder,
        )
        const fromIdx = orderedVolumes.findIndex(
          (v) => v.id === fromItem.volume.id,
        )
        const toIdx = orderedVolumes.findIndex(
          (v) => v.id === toItem.volume.id,
        )
        if (fromIdx === -1 || toIdx === -1) return

        const reordered = [...orderedVolumes]
        const [moved] = reordered.splice(fromIdx, 1)
        reordered.splice(toIdx, 0, moved)

        const ids = reordered.map((v) => v.id)
        try {
          await volumeApi.reorder(ids)
          reorderVolumes(ids)
        } catch (err) {
          console.error('卷重排失败', err)
        }
        return
      }

      // ---------- 章节重排 / 跨组移动 ----------
      if (fromItem.type === 'chapter' && toItem.type === 'chapter') {
        const fromGroup = chapterGroup(fromItem.chapter)
        const toGroup = chapterGroup(toItem.chapter)

        if (fromGroup === toGroup) {
          // 同组内重排
          const groupChapters = chapters
            .filter((c) => !c.deletedAt && chapterGroup(c) === fromGroup)
            .sort((a, b) => a.sortOrder - b.sortOrder)

          const fromIdx = groupChapters.findIndex(
            (c) => c.id === fromItem.chapter.id,
          )
          const toIdx = groupChapters.findIndex(
            (c) => c.id === toItem.chapter.id,
          )
          if (fromIdx === -1 || toIdx === -1) return

          const reordered = [...groupChapters]
          const [moved] = reordered.splice(fromIdx, 1)
          reordered.splice(toIdx, 0, moved)

          const ids = reordered.map((c) => c.id)
          try {
            await chapterApi.reorder(ids)
            reorderChapters(ids)
          } catch (err) {
            console.error('章节重排失败', err)
          }
        } else {
          // 跨分组移动：将章节移到目标章节所在卷（或未分卷区域）
          const targetVolumeId =
            toGroup === '__unassigned__' ? null : toGroup
          try {
            await chapterApi.moveToVolume(
              fromItem.chapter.id,
              targetVolumeId,
            )
            moveChapterToVolume(fromItem.chapter.id, targetVolumeId)

            // 根据拖拽位置在新组内排序
            if (finalIndicator && finalIndicator.id === dndId(toItem)) {
              // moveChapterToVolume 后，章节已归属新组
              const groupChapters = chapters
                .filter(
                  (c) =>
                    !c.deletedAt && chapterGroup(c) === toGroup,
                )
                .sort((a, b) => a.sortOrder - b.sortOrder)

              const targetIdx = groupChapters.findIndex(
                (c) => c.id === toItem.chapter.id,
              )
              const movedIdx = groupChapters.findIndex(
                (c) => c.id === fromItem.chapter.id,
              )

              if (
                targetIdx >= 0 &&
                movedIdx >= 0 &&
                targetIdx !== movedIdx
              ) {
                const reordered = [...groupChapters]
                const [moved] = reordered.splice(movedIdx, 1)
                const adjustedTarget =
                  movedIdx < targetIdx ? targetIdx - 1 : targetIdx
                const insertAt =
                  finalIndicator.position === 'before'
                    ? adjustedTarget
                    : adjustedTarget + 1
                reordered.splice(insertAt, 0, moved)
                const ids = reordered.map((c) => c.id)
                await chapterApi.reorder(ids)
                reorderChapters(ids)
              }
            }
          } catch (err) {
            console.error('移动章节失败', err)
          }
        }
        return
      }

      // ---------- 章节移动到卷 ----------
      if (fromItem.type === 'chapter' && toItem.type === 'volume') {
        const targetVolumeId = toItem.volume.id
        // 如果章节已经在目标卷中，不操作
        if (fromItem.chapter.volumeId === targetVolumeId) return
        // 如果章节无卷且目标是未分卷区域，不操作
        if (!fromItem.chapter.volumeId && !targetVolumeId) return

        try {
          await chapterApi.moveToVolume(
            fromItem.chapter.id,
            targetVolumeId || null,
          )
          moveChapterToVolume(fromItem.chapter.id, targetVolumeId || null)
        } catch (err) {
          console.error('移动章节失败', err)
        }
      }
    },
    [flatItems, volumes, chapters, reorderVolumes, reorderChapters, moveChapterToVolume],
  )

  // ---------- 输入对话框 ----------
  const openInput = useCallback(
    (
      label: string,
      defaultValue: string,
      onSubmit: (value: string) => void,
    ) => {
      setInputDialog({ open: true, label, defaultValue, onSubmit })
    },
    [],
  )

  function handleDialogConfirm() {
    const value = inputRef.current?.value?.trim()
    if (value) {
      inputDialog.onSubmit(value)
    }
    setInputDialog((prev) => ({ ...prev, open: false }))
  }

  function handleDialogCancel() {
    setInputDialog((prev) => ({ ...prev, open: false }))
  }

  function handleAddChapter(volumeId?: string) {
    openInput('新章节标题', '', async (title) => {
      try {
        const chapter = await chapterApi.create({
          bookId,
          volumeId,
          title,
          sortOrder: chapters.length,
        })
        addChapter(chapter)
        setCurrentChapterId(chapter.id)
      } catch (err) {
        console.error('新建章节失败', err)
      }
    })
  }

  function handleAddVolume() {
    openInput('新卷标题', '', async (title) => {
      try {
        const vol = await volumeApi.create(bookId, title, volumes.length)
        setVolumes([...volumes, vol])
      } catch (err) {
        console.error('新建卷失败', err)
      }
    })
  }

  function handleDeleteChapter(chapterId: string, chapterTitle: string) {
    setConfirmDialog({
      open: true,
      title: '删除章节',
      message: `确定要删除章节「${chapterTitle}」吗？删除后将移入回收站，可在回收站中恢复。`,
      onConfirm: async () => {
        try {
          await chapterApi.delete(chapterId)
          updateChapter(chapterId, { deletedAt: new Date().toISOString() })
          if (currentChapterId === chapterId) {
            setCurrentChapterId(null)
          }
        } catch (err) {
          console.error('删除章节失败', err)
        }
        setConfirmDialog((prev) => ({ ...prev, open: false }))
      },
    })
  }

  async function handleRestoreChapter(chapterId: string) {
    try {
      const result = await chapterApi.restore(chapterId)
      updateChapter(chapterId, {
        deletedAt: undefined,
        volumeId: result.volumeId ?? undefined,
      })
    } catch (err) {
      console.error('恢复章节失败', err)
    }
  }

  function handlePermanentDeleteChapter(chapterId: string, chapterTitle: string) {
    setConfirmDialog({
      open: true,
      title: '永久删除',
      message: `确定要永久删除章节「${chapterTitle}」吗？此操作不可撤销。`,
      onConfirm: async () => {
        try {
          await chapterApi.hardDelete(chapterId)
          removeChapter(chapterId)
        } catch (err) {
          console.error('永久删除章节失败', err)
        }
        setConfirmDialog((prev) => ({ ...prev, open: false }))
      },
    })
  }

  function handleClearRecycleBin() {
    if (trashItems.length === 0) return
    setConfirmDialog({
      open: true,
      title: '清空回收站',
      message: `确定要永久删除回收站中的 ${trashItems.length} 个项目吗？此操作不可撤销。`,
      onConfirm: async () => {
        try {
          for (const item of trashItems) {
            if (item.type === 'chapter') {
              await chapterApi.hardDelete(item.data.id)
              removeChapter(item.data.id)
            } else {
              await volumeApi.hardDelete(item.data.id)
            }
          }
          setVolumes(volumes.filter((v) => !v.deletedAt))
        } catch (err) {
          console.error('清空回收站失败', err)
        }
        setConfirmDialog((prev) => ({ ...prev, open: false }))
      },
    })
  }

  function handleDeleteVolume(volumeId: string, volumeTitle: string) {
    // 检查卷下是否还有未删除的章节
    const volumeChapters = chapters.filter(
      (c) => c.volumeId === volumeId && !c.deletedAt,
    )
    if (volumeChapters.length > 0) {
      setConfirmDialog({
        open: true,
        title: '无法删除',
        message: `卷「${volumeTitle}」下还有 ${volumeChapters.length} 个章节，请先将卷内章节全部删除后再删除卷。`,
        danger: false,
        confirmLabel: '知道了',
        onConfirm: async () => {
          setConfirmDialog((prev) => ({ ...prev, open: false }))
        },
      })
      return
    }

    setConfirmDialog({
      open: true,
      title: '删除卷',
      message: `确定要删除卷「${volumeTitle}」吗？删除后将移入回收站，可在回收站中恢复。`,
      onConfirm: async () => {
        try {
          await volumeApi.delete(volumeId)
          setVolumes(volumes.map((v) =>
            v.id === volumeId
              ? { ...v, deletedAt: new Date().toISOString() }
              : v,
          ))
        } catch (err) {
          console.error('删除卷失败', err)
        }
        setConfirmDialog((prev) => ({ ...prev, open: false }))
      },
    })
  }

  async function handleRestoreVolume(volumeId: string) {
    try {
      await volumeApi.restore(volumeId)
      setVolumes(volumes.map((v) =>
        v.id === volumeId ? { ...v, deletedAt: undefined } : v,
      ))
    } catch (err) {
      console.error('恢复卷失败', err)
    }
  }

  function handlePermanentDeleteVolume(volumeId: string, volumeTitle: string) {
    setConfirmDialog({
      open: true,
      title: '永久删除卷',
      message: `确定要永久删除卷「${volumeTitle}」吗？此操作不可撤销。`,
      onConfirm: async () => {
        try {
          await volumeApi.hardDelete(volumeId)
          setVolumes(volumes.filter((v) => v.id !== volumeId))
        } catch (err) {
          console.error('永久删除卷失败', err)
        }
        setConfirmDialog((prev) => ({ ...prev, open: false }))
      },
    })
  }

  function toggleVolume(id: string) {
    setCollapsedVolumes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragMove={handleDragMove}
      onDragOver={(e) => setOverId((e.over?.id as string) ?? null)}
    >
      <div className="flex flex-col h-full">
        {/* 顶部操作 */}
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            目录
          </span>
          <div className="flex gap-1">
            <button
              onClick={handleAddVolume}
              title="新建卷"
              className="p-1 rounded hover:bg-muted text-muted-foreground"
            >
              <FolderIcon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => handleAddChapter()}
              title="新建章节"
              className="p-1 rounded hover:bg-muted text-muted-foreground"
            >
              <PlusIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 输入对话框 */}
        {inputDialog.open && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={handleDialogCancel}
            />
            <div className="relative bg-card border border-border rounded-lg shadow-lg p-4 w-72">
              <label className="block text-sm font-medium text-foreground mb-2">
                {inputDialog.label}
              </label>
              <input
                ref={inputRef}
                autoFocus
                defaultValue={inputDialog.defaultValue}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleDialogConfirm()
                  if (e.key === 'Escape') handleDialogCancel()
                }}
                className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-md outline-none focus:border-primary"
              />
              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={handleDialogCancel}
                  className="px-3 py-1 text-sm rounded-md hover:bg-muted text-muted-foreground"
                >
                  取消
                </button>
                <button
                  onClick={handleDialogConfirm}
                  className="px-3 py-1 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  确定
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除确认对话框 */}
        {confirmDialog.open && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center"> 
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
            />
            <div className="relative bg-card border border-border rounded-lg shadow-lg p-5 w-80">
              <h3 className="text-sm font-semibold text-foreground mb-2">
                {confirmDialog.title}
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                {confirmDialog.message}
              </p>
              <div className="flex justify-end gap-2">
                {confirmDialog.danger !== false && (
                  <button
                    onClick={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
                    className="px-3 py-1.5 text-sm rounded-md hover:bg-muted text-muted-foreground"
                  >
                    取消
                  </button>
                )}
                <button
                  onClick={confirmDialog.onConfirm}
                  className={cn(
                    'px-3 py-1.5 text-sm rounded-md',
                    confirmDialog.danger !== false
                      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90',
                  )}
                >
                  {confirmDialog.confirmLabel ?? '确认删除'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 回收站对话框 */}
        {recycleBinOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setRecycleBinOpen(false)}
            />
            <div className="relative bg-card border border-border rounded-lg shadow-lg w-96 max-h-[70vh] flex flex-col">
              {/* 回收站标题栏 */}
              <div className="flex items-center justify-between px-5 py-3 border-b">
                <div className="flex items-center gap-2">
                  <Trash2Icon className="w-4 h-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold text-foreground">
                    回收站
                  </h3>
                  {trashItems.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      ({trashItems.length})
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {trashItems.length > 0 && (
                    <button
                      onClick={handleClearRecycleBin}
                      className="px-2 py-1 text-xs rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20"
                    >
                      清空回收站
                    </button>
                  )}
                  <button
                    onClick={() => setRecycleBinOpen(false)}
                    className="p-1 rounded hover:bg-muted text-muted-foreground"
                  >
                    <XIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 回收站内容 */}
              <div className="flex-1 overflow-y-auto p-3">
                {trashItems.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-12">
                    回收站为空
                  </div>
                ) : (
                  <div className="space-y-1">
                    {trashItems.map((item) =>
                      item.type === 'volume' ? (
                        <div
                          key={`vol-${item.data.id}`}
                          className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-muted/50 group"
                        >
                          <FolderIcon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="flex-1 text-sm truncate">
                            {item.data.title}
                          </span>
                          <span className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                            卷
                          </span>
                          <button
                            onClick={() => handleRestoreVolume(item.data.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary flex-shrink-0"
                            title="恢复卷"
                          >
                            <RotateCcwIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() =>
                              handlePermanentDeleteVolume(
                                item.data.id,
                                item.data.title,
                              )
                            }
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex-shrink-0"
                            title="永久删除"
                          >
                            <Trash2Icon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div
                          key={`ch-${item.data.id}`}
                          className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-muted/50 group"
                        >
                          <FileTextIcon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="flex-1 text-sm truncate">
                            {item.data.title}
                          </span>
                          <span
                            className={cn(
                              'text-xs px-1.5 py-0.5 rounded-full flex-shrink-0',
                              CHAPTER_STATUS_CONFIG[item.data.status].color,
                            )}
                          >
                            {CHAPTER_STATUS_CONFIG[item.data.status].label}
                          </span>
                          <button
                            onClick={() => handleRestoreChapter(item.data.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary flex-shrink-0"
                            title="恢复章节"
                          >
                            <RotateCcwIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() =>
                              handlePermanentDeleteChapter(
                                item.data.id,
                                item.data.title,
                              )
                            }
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex-shrink-0"
                            title="永久删除"
                          >
                            <Trash2Icon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 虚拟化章节树 */}
        <div ref={parentRef} className="flex-1 overflow-y-auto py-1">
          {activeItem?.type === 'chapter' && activeItem.chapter.volumeId && (
            <DroppableUnassignedZone
              isOver={overId === 'unassigned-zone-__unassigned-zone__'}
              hasDraggingChapter
            />
          )}
          {flatItems.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-8">
              暂无章节，点击 + 新建
            </div>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: 'relative',
                width: '100%',
              }}
            >
              {virtualizer.getVirtualItems().map((vItem) => {
                const item = flatItems[vItem.index]
                if (!item) return null

                return (
                  <div
                    key={dndId(item)}
                    ref={virtualizer.measureElement}
                    data-index={vItem.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vItem.start}px)`,
                      transition: 'transform 0.2s ease',
                    }}
                  >
                    {(() => {
                      const showBefore =
                        dropIndicator?.id === dndId(item) &&
                        dropIndicator.position === 'before'
                      const showAfter =
                        dropIndicator?.id === dndId(item) &&
                        dropIndicator.position === 'after'

                      if (item.type === 'volume') {
                        return (
                          <DraggableVolume
                            item={item}
                            isOver={overId === dndId(item)}
                            isChapterOver={
                              overId === dndId(item) &&
                              activeItem?.type === 'chapter'
                            }
                            showDropBefore={showBefore}
                            showDropAfter={showAfter}
                            onToggle={() => toggleVolume(item.volume.id)}
                            onAddChapter={() =>
                              handleAddChapter(item.volume.id)
                            }
                            onDelete={() =>
                              handleDeleteVolume(
                                item.volume.id,
                                item.volume.title,
                              )
                            }
                          />
                        )
                      }

                      if (item.type === 'chapter') {
                        return (
                          <DraggableChapter
                            item={item}
                            isActive={item.chapter.id === currentChapterId}
                            isOver={overId === dndId(item)}
                            isCrossGroupOver={
                              overId === dndId(item) &&
                              activeItem?.type === 'chapter' &&
                              chapterGroup(activeItem.chapter) !==
                                chapterGroup(item.chapter)
                            }
                            showDropBefore={showBefore}
                            showDropAfter={showAfter}
                            onSelect={() =>
                              setCurrentChapterId(item.chapter.id)
                            }
                            onRename={async (title) => {
                              await chapterApi.rename(
                                item.chapter.id,
                                title,
                              )
                              updateChapter(item.chapter.id, { title })
                            }}
                            onDelete={() =>
                              handleDeleteChapter(
                                item.chapter.id,
                                item.chapter.title,
                              )
                            }
                          />
                        )
                      }

                      return null
                    })()}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部回收站按钮 */}
        <div className="border-t px-3 py-2">
          <button
            onClick={() => setRecycleBinOpen(true)}
            className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted rounded-md transition-colors"
            title="回收站"
          >
            <Trash2Icon className="w-3.5 h-3.5" />
            <span>回收站</span>
            {trashItems.length > 0 && (
              <span className="ml-auto bg-muted-foreground/20 text-muted-foreground text-xs px-1.5 py-0.5 rounded-full">
                {trashItems.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* 拖拽预览 */}
      <DragOverlay dropAnimation={null}>
        {activeItem ? (
          activeItem.type === 'volume' ? (
            <VolumePreview volume={activeItem.volume} />
          ) : activeItem.type === 'chapter' ? (
            <ChapterPreview chapter={activeItem.chapter} />
          ) : null
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

// ==================== 可拖拽卷条目 ====================

function DraggableVolume({
  item,
  isOver,
  isChapterOver,
  showDropBefore,
  showDropAfter,
  onToggle,
  onAddChapter,
  onDelete,
}: {
  item: FlatItem & { type: 'volume' }
  isOver: boolean
  isChapterOver: boolean
  showDropBefore: boolean
  showDropAfter: boolean
  onToggle: () => void
  onAddChapter: () => void
  onDelete: () => void
}) {
  const id = dndId(item)
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({ id })
  const { setNodeRef: setDroppableRef } = useDroppable({ id })

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setDraggableRef(node)
      setDroppableRef(node)
    },
    [setDraggableRef, setDroppableRef],
  )

  return (
    <div className="relative">
      {/* 插入位置指示器 - 上方 */}
      <div
        className={cn(
          'absolute top-0 left-1 right-1 h-0.5 bg-primary rounded-full z-10 shadow-sm shadow-primary/30 transition-all duration-200 origin-center animate-pulse-indicator',
          showDropBefore ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0',
        )}
      />
      <div
        ref={ref}
        className={cn(
          'flex items-center gap-1 px-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted cursor-pointer group rounded-sm mx-1 transition-all duration-200',
          isDragging && 'opacity-30 scale-95',
          isChapterOver && 'ring-2 ring-primary/50 bg-primary/10 text-primary',
          !isChapterOver && isOver && 'bg-accent/50',
        )}
      onClick={onToggle}
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
      <span className="flex-1 truncate">{item.volume.title}</span>
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
      {/* 插入位置指示器 - 下方 */}
      <div
        className={cn(
          'absolute bottom-0 left-1 right-1 h-0.5 bg-primary rounded-full z-10 shadow-sm shadow-primary/30 transition-all duration-200 origin-center animate-pulse-indicator',
          showDropAfter ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0',
        )}
      />
    </div>
  )
}

// ==================== 可拖拽章节条目 ====================

function DraggableChapter({
  item,
  isActive,
  isOver,
  isCrossGroupOver,
  showDropBefore,
  showDropAfter,
  onSelect,
  onRename,
  onDelete,
}: {
  item: FlatItem & { type: 'chapter' }
  isActive: boolean
  isOver: boolean
  isCrossGroupOver: boolean
  showDropBefore: boolean
  showDropAfter: boolean
  onSelect: () => void
  onRename: (title: string) => Promise<void>
  onDelete: () => void
}) {
  const id = dndId(item)
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({ id })
  const { setNodeRef: setDroppableRef } = useDroppable({ id })
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(item.chapter.title)
  const statusCfg = CHAPTER_STATUS_CONFIG[item.chapter.status]

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
      {/* 插入位置指示器 - 上方 */}
      <div
        className={cn(
          'absolute top-0 left-1 right-1 h-0.5 bg-primary rounded-full z-10 shadow-sm shadow-primary/30 transition-all duration-200 origin-center animate-pulse-indicator',
          showDropBefore ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0',
        )}
      />
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
        className={cn(
          'text-xs px-1.5 py-0.5 rounded-full flex-shrink-0',
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
      {/* 插入位置指示器 - 下方 */}
      <div
        className={cn(
          'absolute bottom-0 left-1 right-1 h-0.5 bg-primary rounded-full z-10 shadow-sm shadow-primary/30 transition-all duration-200 origin-center animate-pulse-indicator',
          showDropAfter ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0',
        )}
      />
    </div>
  )
}

// ==================== 未分卷区域投放组件 ====================

function DroppableUnassignedZone({
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

// ==================== 拖拽预览组件 ====================

function VolumePreview({ volume }: { volume: Volume }) {
  return (
    <div className="animate-pop-in flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-card border border-border rounded shadow-lg">
      <GripVerticalIcon className="w-3 h-3 text-muted-foreground" />
      <FolderIcon className="w-3 h-3 text-muted-foreground" />
      <span className="truncate">{volume.title}</span>
    </div>
  )
}

function ChapterPreview({ chapter }: { chapter: Chapter }) {
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
