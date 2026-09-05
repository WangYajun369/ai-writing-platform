/**
 * useOutlineDnd — 目录树拖拽逻辑 hook（Phase 4 问题 5：OutlinePanel 拆分）
 *
 * 集中管理目录树全部拖拽状态与事件：
 * - 拖拽状态：activeId / overId / 插入指示线
 * - 碰撞策略：卷只能与卷碰撞；章节可拖到卷或任意章节；未分卷区域仅接受「有卷章节」
 * - 落子处理：卷重排 / 章节重排 / 跨卷移动（含跨组后按指示线精排）/ 移出到未分卷
 *
 * 纯状态逻辑不触碰 UI，主组件仅负责目录数据的拍平与渲染编排。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import type {
  CollisionDetection,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from '@dnd-kit/core'
import { useBooksStore } from '@/stores/booksStore'
import { chapterApi, volumeApi } from '@/lib/tauri-bridge'
import type { Chapter, Volume } from '@/types'
import type { FlatItem } from '../types'
import { chapterGroup, dndId } from '../utils'

export interface DndDropIndicator {
  id: string
  position: 'before' | 'after'
}

interface UseOutlineDndOptions {
  flatItems: FlatItem[]
  volumes: Volume[]
  chapters: Chapter[]
}

/** 未分卷区域的统一 DnD id（与 DroppableUnassignedZone 保持一致） */
const UNASSIGNED_ZONE_ID = 'unassigned-zone-__unassigned-zone__'

export function useOutlineDnd({ flatItems, volumes, chapters }: UseOutlineDndOptions) {
  const reorderVolumes = useBooksStore((s) => s.reorderVolumes)
  const reorderChapters = useBooksStore((s) => s.reorderChapters)
  const moveChapterToVolume = useBooksStore((s) => s.moveChapterToVolume)

  // ── 拖拽状态 ──
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<DndDropIndicator | null>(null)
  const dropIndicatorRef = useRef<DndDropIndicator | null>(null)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)

  // 当前拖拽中的项
  const activeItem = useMemo(
    () => (activeId ? flatItems.find((f) => dndId(f) === activeId) ?? null : null),
    [activeId, flatItems],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  /** 自定义碰撞检测：卷只能拖到卷；章节可拖到卷或任意章节 */
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const collisions = closestCenter(args)
      return collisions.filter((collision) => {
        if (collision.id === UNASSIGNED_ZONE_ID) {
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

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverId((event.over?.id as string) ?? null)
  }, [])

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
      if (over.id === UNASSIGNED_ZONE_ID) {
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
        const orderedVolumes = [...volumes].sort((a, b) => a.sortOrder - b.sortOrder)
        const fromIdx = orderedVolumes.findIndex((v) => v.id === fromItem.volume.id)
        const toIdx = orderedVolumes.findIndex((v) => v.id === toItem.volume.id)
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

          const fromIdx = groupChapters.findIndex((c) => c.id === fromItem.chapter.id)
          const toIdx = groupChapters.findIndex((c) => c.id === toItem.chapter.id)
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
          const targetVolumeId = toGroup === '__unassigned__' ? null : toGroup
          try {
            await chapterApi.moveToVolume(fromItem.chapter.id, targetVolumeId)
            moveChapterToVolume(fromItem.chapter.id, targetVolumeId)

            if (finalIndicator && finalIndicator.id === dndId(toItem)) {
              const groupChapters = chapters
                .filter((c) => !c.deletedAt && chapterGroup(c) === toGroup)
                .sort((a, b) => a.sortOrder - b.sortOrder)

              const targetIdx = groupChapters.findIndex((c) => c.id === toItem.chapter.id)
              const movedIdx = groupChapters.findIndex((c) => c.id === fromItem.chapter.id)

              if (targetIdx >= 0 && movedIdx >= 0 && targetIdx !== movedIdx) {
                const reordered = [...groupChapters]
                const [moved] = reordered.splice(movedIdx, 1)
                const adjustedTarget = movedIdx < targetIdx ? targetIdx - 1 : targetIdx
                const insertAt =
                  finalIndicator.position === 'before' ? adjustedTarget : adjustedTarget + 1
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
          await chapterApi.moveToVolume(fromItem.chapter.id, targetVolumeId || null)
          moveChapterToVolume(fromItem.chapter.id, targetVolumeId || null)
        } catch (err) {
          console.error('移动章节失败', err)
        }
      }
    },
    [flatItems, volumes, chapters, reorderVolumes, reorderChapters, moveChapterToVolume],
  )

  return {
    sensors,
    collisionDetection,
    activeId,
    overId,
    dropIndicator,
    activeItem,
    handleDragStart,
    handleDragMove,
    handleDragOver,
    handleDragEnd,
  }
}
