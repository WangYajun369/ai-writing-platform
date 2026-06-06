import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { PlusIcon, FolderIcon, FileTextIcon, ChevronRightIcon, ChevronDownIcon } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
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

// 拍平后的列表项
type FlatItem =
  | { type: 'chapter'; id: string; chapter: Chapter; indent: boolean }
  | { type: 'volume'; id: string; volume: Volume; collapsed: boolean }

export default function OutlinePanel({ bookId }: OutlinePanelProps) {
  const { volumes, chapters, currentChapterId, setCurrentChapterId, addChapter, updateChapter, setVolumes } = useAppStore()
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set())
  const [inputDialog, setInputDialog] = useState<InputDialogState>({ open: false, label: '', defaultValue: '', onSubmit: () => {} })
  const inputRef = useRef<HTMLInputElement>(null)

  // 虚拟化
  const parentRef = useRef<HTMLDivElement>(null)

  // 拍平树形结构为线性列表（在 virtualizer 之前计算，以便传入 count）
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = []

    // 未分卷章节
    const unassigned = chapters
      .filter((c) => !c.deletedAt && !c.volumeId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    for (const c of unassigned) {
      items.push({ type: 'chapter', id: c.id, chapter: c, indent: false })
    }

    // 分卷章节
    const sortedVolumes = [...volumes].sort((a, b) => a.sortOrder - b.sortOrder)
    for (const vol of sortedVolumes) {
      items.push({ type: 'volume', id: vol.id, volume: vol, collapsed: collapsedVolumes.has(vol.id) })
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

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
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

  const openInput = useCallback((label: string, defaultValue: string, onSubmit: (value: string) => void) => {
    setInputDialog({ open: true, label, defaultValue, onSubmit })
  }, [])

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

  function toggleVolume(id: string) {
    setCollapsedVolumes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部操作 */}
      <div className="px-3 py-2 border-b flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">目录</span>
        <div className="flex gap-1">
          <button onClick={handleAddVolume} title="新建卷" className="p-1 rounded hover:bg-muted text-muted-foreground">
            <FolderIcon className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => handleAddChapter()} title="新建章节" className="p-1 rounded hover:bg-muted text-muted-foreground">
            <PlusIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 输入对话框 */}
      {inputDialog.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={handleDialogCancel} />
          <div className="relative bg-card border border-border rounded-lg shadow-lg p-4 w-72">
            <label className="block text-sm font-medium text-foreground mb-2">{inputDialog.label}</label>
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
              <button onClick={handleDialogCancel} className="px-3 py-1 text-sm rounded-md hover:bg-muted text-muted-foreground">取消</button>
              <button onClick={handleDialogConfirm} className="px-3 py-1 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 虚拟化章节树 */}
      <div ref={parentRef} className="flex-1 overflow-y-auto py-1">
        {flatItems.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">暂无章节，点击 + 新建</div>
        ) : (
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const item = flatItems[vItem.index]
              if (!item) return null

              return (
                <div
                  key={`${item.type}-${item.id}`}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  {item.type === 'volume' ? (
                    <div
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted cursor-pointer group"
                      onClick={() => toggleVolume(item.volume.id)}
                    >
                      {item.collapsed ? <ChevronRightIcon className="w-3 h-3" /> : <ChevronDownIcon className="w-3 h-3" />}
                      <FolderIcon className="w-3 h-3" />
                      <span className="flex-1 truncate">{item.volume.title}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAddChapter(item.volume.id) }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted-foreground/20"
                      >
                        <PlusIcon className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <ChapterItemVirtual
                      chapter={item.chapter}
                      isActive={item.chapter.id === currentChapterId}
                      indent={item.indent}
                      onSelect={() => setCurrentChapterId(item.chapter.id)}
                      onRename={async (title) => {
                        await chapterApi.rename(item.chapter.id, title)
                        updateChapter(item.chapter.id, { title })
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ==================== 虚拟化友好的章节条目 ====================
function ChapterItemVirtual({
  chapter,
  isActive,
  indent,
  onSelect,
  onRename,
}: {
  chapter: Chapter
  isActive: boolean
  indent?: boolean
  onSelect: () => void
  onRename: (title: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(chapter.title)
  const statusCfg = CHAPTER_STATUS_CONFIG[chapter.status]

  async function handleRename() {
    if (editValue.trim() && editValue !== chapter.title) {
      await onRename(editValue.trim())
    }
    setEditing(false)
  }

  return (
    <div
      onClick={() => { if (!isActive) onSelect() }}
      onDoubleClick={() => setEditing(true)}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer group transition-colors rounded-md mx-1',
        indent && 'pl-7',
        isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-foreground',
      )}
    >
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
        <span className="flex-1 truncate">{chapter.title}</span>
      )}

      <span className={cn('text-xs px-1.5 py-0.5 rounded-full flex-shrink-0', statusCfg.color)}>
        {statusCfg.label}
      </span>
    </div>
  )
}
