import { useState } from 'react'
import { PlusIcon, FolderIcon, FileTextIcon, ChevronRightIcon, ChevronDownIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { chapterApi, volumeApi } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import type { Chapter, Volume } from '@/types'
import { CHAPTER_STATUS_CONFIG } from '@/lib/utils'

interface OutlinePanelProps {
  bookId: string
}

export default function OutlinePanel({ bookId }: OutlinePanelProps) {
  const { volumes, chapters, currentChapterId, setCurrentChapterId, addChapter, updateChapter } = useAppStore()
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set())

  // 按卷分组章节
  const chaptersByVolume: Record<string, Chapter[]> = {}
  const unassigned: Chapter[] = []

  chapters
    .filter((c) => !c.deletedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .forEach((c) => {
      if (c.volumeId) {
        ;(chaptersByVolume[c.volumeId] ??= []).push(c)
      } else {
        unassigned.push(c)
      }
    })

  async function handleAddChapter(volumeId?: string) {
    const title = prompt('新章节标题：')
    if (!title?.trim()) return
    try {
      const chapter = await chapterApi.create({
        bookId,
        volumeId,
        title: title.trim(),
        sortOrder: chapters.length,
      })
      addChapter(chapter)
      setCurrentChapterId(chapter.id)
    } catch (err) {
      console.error('新建章节失败', err)
    }
  }

  async function handleAddVolume() {
    const title = prompt('新卷标题：')
    if (!title?.trim()) return
    try {
      await volumeApi.create(bookId, title.trim(), volumes.length)
      // 重新加载，简化处理
      window.location.reload()
    } catch (err) {
      console.error('新建卷失败', err)
    }
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

      {/* 章节树 */}
      <div className="flex-1 overflow-y-auto py-1">
        {/* 未分卷章节 */}
        {unassigned.map((c) => (
          <ChapterItem
            key={c.id}
            chapter={c}
            isActive={c.id === currentChapterId}
            onSelect={() => setCurrentChapterId(c.id)}
            onRename={async (title) => {
              await chapterApi.rename(c.id, title)
              updateChapter(c.id, { title })
            }}
          />
        ))}

        {/* 按卷展示 */}
        {volumes
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((vol) => (
            <VolumeGroup
              key={vol.id}
              volume={vol}
              chapters={chaptersByVolume[vol.id] ?? []}
              currentChapterId={currentChapterId}
              collapsed={collapsedVolumes.has(vol.id)}
              onToggle={() => toggleVolume(vol.id)}
              onSelectChapter={setCurrentChapterId}
              onAddChapter={() => handleAddChapter(vol.id)}
              onRenameChapter={async (id, title) => {
                await chapterApi.rename(id, title)
                updateChapter(id, { title })
              }}
            />
          ))}
      </div>
    </div>
  )
}

// ==================== 卷分组 ====================
function VolumeGroup({
  volume,
  chapters,
  currentChapterId,
  collapsed,
  onToggle,
  onSelectChapter,
  onAddChapter,
  onRenameChapter,
}: {
  volume: Volume
  chapters: Chapter[]
  currentChapterId: string | null
  collapsed: boolean
  onToggle: () => void
  onSelectChapter: (id: string) => void
  onAddChapter: () => void
  onRenameChapter: (id: string, title: string) => Promise<void>
}) {
  return (
    <div>
      <div
        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted cursor-pointer group"
        onClick={onToggle}
      >
        {collapsed ? (
          <ChevronRightIcon className="w-3 h-3" />
        ) : (
          <ChevronDownIcon className="w-3 h-3" />
        )}
        <FolderIcon className="w-3 h-3" />
        <span className="flex-1 truncate">{volume.title}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onAddChapter() }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted-foreground/20"
        >
          <PlusIcon className="w-3 h-3" />
        </button>
      </div>
      {!collapsed &&
        chapters.map((c) => (
          <ChapterItem
            key={c.id}
            chapter={c}
            isActive={c.id === currentChapterId}
            indent
            onSelect={() => onSelectChapter(c.id)}
            onRename={(title) => onRenameChapter(c.id, title)}
          />
        ))}
    </div>
  )
}

// ==================== 章节条目 ====================
function ChapterItem({
  chapter,
  isActive,
  indent = false,
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
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer group transition-colors rounded-md mx-1',
        indent && 'pl-7',
        isActive ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
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

      <span className={cn('text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 opacity-0 group-hover:opacity-100', statusCfg.color)}>
        {statusCfg.label}
      </span>
    </div>
  )
}
