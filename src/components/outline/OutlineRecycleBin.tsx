/**
 * OutlineRecycleBin — 回收站对话框
 * 展示已软删除的卷和章节，支持恢复和永久删除
 */
import {
  Trash2Icon,
  FolderIcon,
  FileTextIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHAPTER_STATUS_CONFIG } from '@/lib/utils'
import type { Chapter, Volume } from '@/types'

export interface RecycleBinItem {
  type: 'volume'
  data: Volume
}

export interface RecycleBinChapterItem {
  type: 'chapter'
  data: Chapter
}

type TrashItem = RecycleBinItem | RecycleBinChapterItem

interface OutlineRecycleBinProps {
  open: boolean
  trashItems: TrashItem[]
  onClose: () => void
  onRestoreVolume: (volumeId: string) => void
  onRestoreChapter: (chapterId: string) => void
  onPermanentDeleteVolume: (volumeId: string, title: string) => void
  onPermanentDeleteChapter: (chapterId: string, title: string) => void
  onClearAll: () => void
}

export default function OutlineRecycleBin({
  open,
  trashItems,
  onClose,
  onRestoreVolume,
  onRestoreChapter,
  onPermanentDeleteVolume,
  onPermanentDeleteChapter,
  onClearAll,
}: OutlineRecycleBinProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
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
                onClick={onClearAll}
                className="px-2 py-1 text-xs rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20"
              >
                清空回收站
              </button>
            )}
            <button
              onClick={onClose}
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
                      onClick={() => onRestoreVolume(item.data.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary flex-shrink-0"
                      title="恢复卷"
                    >
                      <RotateCcwIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        onPermanentDeleteVolume(
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
                      onClick={() => onRestoreChapter(item.data.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary flex-shrink-0"
                      title="恢复章节"
                    >
                      <RotateCcwIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        onPermanentDeleteChapter(
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
  )
}
