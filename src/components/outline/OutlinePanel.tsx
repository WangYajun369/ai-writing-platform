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
  Trash2Icon,
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
import type {
  DragStartEvent,
  DragEndEvent,
  DragMoveEvent,
  CollisionDetection,
} from '@dnd-kit/core'
import { useAppStore } from '@/stores/appStore'
import { chapterApi, volumeApi } from '@/lib/tauri-bridge'
import type { Chapter } from '@/types'

import type { InputDialogState, ConfirmDialogState, FlatItem } from './types'
import { dndId, chapterGroup } from './utils'
import { InputDialog, ConfirmDialog } from './OutlineDialogs'
import OutlineRecycleBin from './OutlineRecycleBin'
import DraggableVolume from './DraggableVolume'
import DraggableChapter from './DraggableChapter'
import { DroppableUnassignedZone, VolumePreview, ChapterPreview } from './OutlineDragDrop'

interface OutlinePanelProps {
  bookId: string
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
    updateBook,
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
      | { type: 'volume'; data: typeof volumes[number] }
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

  // 当前拖拽中项
  const activeItem = useMemo(
    () => flatItems.find((f) => dndId(f) === activeId) ?? null,
    [activeId, flatItems],
  )

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: activeId ? 9999 : 10,
  })

  // 折叠/展开时重新测量
  useEffect(() => {
    virtualizer.measure()
  }, [collapsedVolumes, virtualizer])

  // ---------- DnD ----------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  /** 自定义碰撞检测：卷只能拖到卷；章节可拖到卷或任意章节 */
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const collisions = closestCenter(args)
      return collisions.filter((collision) => {
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

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const over = event.over
      if (!over || !dragStartPos.current || !activeItem) return

      const targetItem = flatItems.find((f) => dndId(f) === over.id)
      if (!targetItem) return

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
          const targetVolumeId =
            toGroup === '__unassigned__' ? null : toGroup
          try {
            await chapterApi.moveToVolume(
              fromItem.chapter.id,
              targetVolumeId,
            )
            moveChapterToVolume(fromItem.chapter.id, targetVolumeId)

            if (finalIndicator && finalIndicator.id === dndId(toItem)) {
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
        if (fromItem.chapter.volumeId === targetVolumeId) return
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

  // ---------- 操作处理器 ----------
  const openInputDialog = useCallback(
    (
      label: string,
      defaultValue: string,
      onSubmit: (value: string) => void,
    ) => {
      setInputDialog({ open: true, label, defaultValue, onSubmit })
    },
    [],
  )

  const closeInputDialog = useCallback(() => {
    setInputDialog((prev) => ({ ...prev, open: false }))
  }, [])

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, open: false }))
  }, [])

  function handleAddChapter(volumeId?: string) {
    openInputDialog('新章节标题', '', async (title) => {
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
    openInputDialog('新卷标题', '', async (title) => {
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
          const result = await chapterApi.delete(chapterId)
          updateChapter(chapterId, { deletedAt: new Date().toISOString() })
          updateBook(bookId, { wordCount: result.bookWordCount })
          if (currentChapterId === chapterId) {
            setCurrentChapterId(null)
          }
        } catch (err) {
          console.error('删除章节失败', err)
        }
        closeConfirmDialog()
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
      updateBook(bookId, { wordCount: result.bookWordCount })
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
          const result = await chapterApi.hardDelete(chapterId)
          removeChapter(chapterId)
          updateBook(bookId, { wordCount: result.bookWordCount })
        } catch (err) {
          console.error('永久删除章节失败', err)
        }
        closeConfirmDialog()
      },
    })
  }

  function handleClearRecycleBin() {
    if (trashItems.length === 0) return

    // 分两组：章节优先处理（避免先删卷后外键约束导致 SQL 逻辑错误）
    const chaptersToDelete = trashItems.filter((item) => item.type === 'chapter')
    const volumesToDelete = trashItems.filter((item) => item.type === 'volume')

    setConfirmDialog({
      open: true,
      title: '清空回收站',
      message: `确定要永久删除回收站中的 ${trashItems.length} 个项目吗？此操作不可撤销。`,
      onConfirm: async () => {
        let hasError = false
        let lastBookWc: number | null = null
        try {
          // 先删除所有章节（确保卷删除前其关联章节已被清理）
          for (const item of chaptersToDelete) {
            try {
              const result = await chapterApi.hardDelete(item.data.id)
              removeChapter(item.data.id)
              lastBookWc = result.bookWordCount
            } catch (err) {
              console.error('永久删除章节失败', item.data.title, err)
              hasError = true
            }
          }
          // 再删除所有卷
          for (const item of volumesToDelete) {
            try {
              await volumeApi.hardDelete(item.data.id)
            } catch (err) {
              console.error('永久删除卷失败', item.data.title, err)
              hasError = true
            }
          }
          // 清除已删除卷的状态 + 同步最终字数
          setVolumes(volumes.filter((v) => !v.deletedAt))
          if (lastBookWc !== null) {
            updateBook(bookId, { wordCount: lastBookWc })
          }
        } catch (err) {
          console.error('清空回收站失败', err)
          hasError = true
        }
        if (hasError) {
          setConfirmDialog({
            open: true,
            title: '部分操作失败',
            message:
              '清空回收站时部分项目删除失败，回收站可能未完全清空，请重试。',
            danger: false,
            confirmLabel: '知道了',
            onConfirm: closeConfirmDialog,
          })
        }
        closeConfirmDialog()
      },
    })
  }

  function handleDeleteVolume(volumeId: string, volumeTitle: string) {
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
        onConfirm: closeConfirmDialog,
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
        closeConfirmDialog()
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
        closeConfirmDialog()
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

        {/* 对话框层 */}
        <InputDialog
          state={inputDialog}
          onConfirm={(value) => inputDialog.onSubmit(value)}
          onCancel={closeInputDialog}
        />

        <ConfirmDialog
          state={confirmDialog}
          onClose={closeConfirmDialog}
        />

        <OutlineRecycleBin
          open={recycleBinOpen}
          trashItems={trashItems}
          onClose={() => setRecycleBinOpen(false)}
          onRestoreVolume={handleRestoreVolume}
          onRestoreChapter={handleRestoreChapter}
          onPermanentDeleteVolume={handlePermanentDeleteVolume}
          onPermanentDeleteChapter={handlePermanentDeleteChapter}
          onClearAll={handleClearRecycleBin}
        />

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

                const showBefore =
                  dropIndicator?.id === dndId(item) &&
                  dropIndicator.position === 'before'
                const showAfter =
                  dropIndicator?.id === dndId(item) &&
                  dropIndicator.position === 'after'

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
                    {item.type === 'volume' && (
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
                        onRename={async (newTitle) => {
                          await volumeApi.update(item.volume.id, newTitle)
                          setVolumes(volumes.map((v) =>
                            v.id === item.volume.id ? { ...v, title: newTitle } : v,
                          ))
                        }}
                      />
                    )}

                    {item.type === 'chapter' && (
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
                        onStatusChange={async (newStatus) => {
                          await chapterApi.updateStatus(
                            item.chapter.id,
                            newStatus,
                          )
                          updateChapter(item.chapter.id, { status: newStatus })
                        }}
                      />
                    )}
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
