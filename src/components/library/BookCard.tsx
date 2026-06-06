/**
 * BookCard — 书籍卡片组件
 *
 * 支持网格（grid）与列表（list）两种视图模式。
 * 网格模式展示封面、日更进度环及右键菜单；
 * 列表模式展示缩略图、书名、作者、字数及操作菜单。
 * 支持修改封面（网格模式悬停显示编辑按钮）。
 */
import { useState, useRef, useEffect } from 'react'
import { MoreVerticalIcon, EditIcon, Trash2Icon, CalendarIcon, ImageIcon } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { stat } from '@tauri-apps/plugin-fs'
import type { Book } from '@/types'
import { bookApi } from '@/lib/tauri-bridge.ts'
import { formatWordCount, formatRelativeTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import { resolveCoverSrc } from './CoverPicker'

/** 允许的封面图片扩展名 */
const ALLOWED_COVER_EXTS = ['jpg', 'jpeg', 'png', 'webp']
/** 封面最大文件大小：5 MB */
const MAX_COVER_SIZE = 5 * 1024 * 1024

interface BookCardProps {
  book: Book
  viewMode: 'grid' | 'list'
  onOpen: (book: Book) => void
  onRefresh: () => void
}

export default function BookCard({ book, viewMode, onOpen, onRefresh }: BookCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [coverChanging, setCoverChanging] = useState(false)
  const [coverSrc, setCoverSrc] = useState<string | undefined>(undefined)
  const prevCoverSrcRef = useRef<string | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)
  const { removeBook, updateBook } = useAppStore()

  // 异步加载封面为 blob URL
  useEffect(() => {
    let cancelled = false
    resolveCoverSrc(book.coverImage).then((src) => {
      if (cancelled) return
      // 释放前一个 blob URL
      if (prevCoverSrcRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(prevCoverSrcRef.current)
      }
      prevCoverSrcRef.current = src
      setCoverSrc(src)
    })
    return () => { cancelled = true }
  }, [book.coverImage])

  // 组件卸载时释放 blob URL
  useEffect(() => {
    return () => {
      if (prevCoverSrcRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(prevCoverSrcRef.current)
      }
    }
  }, [])

  // 日更进度百分比
  const dailyProgress = book.dailyTarget > 0
    ? Math.min((book.todayCount / book.dailyTarget) * 100, 100)
    : 0

  /** 选择并上传封面 */
  async function handleChangeCover() {
    setMenuOpen(false)
    setCoverChanging(true)
    try {
      const selected = await open({
        title: '选择封面图片',
        filters: [{ name: '图片文件', extensions: ALLOWED_COVER_EXTS }],
        multiple: false,
        directory: false,
      })
      if (!selected) return
      const filePath = selected as string

      // 校验扩展名
      const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
      if (!ALLOWED_COVER_EXTS.includes(ext)) {
        alert(`不支持的图片格式 .${ext}，仅支持 jpg、png、webp`)
        return
      }

      // 校验文件大小
      const fileStat = await stat(filePath)
      if (fileStat.size > MAX_COVER_SIZE) {
        const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1)
        alert(`图片过大（${sizeMB} MB），封面不能超过 5 MB`)
        return
      }

      const updated = await bookApi.setCover(book.id, filePath)
      updateBook(book.id, updated)
    } catch (err) {
      console.error('修改封面失败', err)
      alert('修改封面失败，请重试')
    } finally {
      setCoverChanging(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`确认删除《${book.title}》？此操作不可恢复。`)) return
    try {
      await bookApi.delete(book.id)
      removeBook(book.id)
    } catch (err) {
      console.error('删除失败', err)
    }
    setMenuOpen(false)
  }

  if (viewMode === 'list') {
    return (
      <div
        className="flex items-center gap-4 p-4 rounded-xl bg-card border hover:border-primary/40 transition-all cursor-pointer group relative"
        onDoubleClick={() => onOpen(book)}
      >
        {/* 封面缩略图 */}
        <div className="w-10 h-14 rounded flex-shrink-0 flex items-center justify-center overflow-hidden bg-gradient-to-br from-primary/20 to-primary/5">
          {coverSrc ? (
            <img src={coverSrc} alt={book.title} className="w-full h-full object-cover" />
          ) : (
            <span className="text-xs text-primary font-bold">{book.title.charAt(0)}</span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{book.title}</p>
          <p className="text-xs text-muted-foreground">{book.author}</p>
        </div>

        <div className="text-sm text-muted-foreground">{formatWordCount(book.wordCount)}</div>
        <div className="text-xs text-muted-foreground">{formatRelativeTime(book.updatedAt)}</div>

        <button
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
        >
          <MoreVerticalIcon className="w-4 h-4" />
        </button>

        {/* 下拉菜单 */}
        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute right-0 top-full mt-1 z-20 bg-popover border rounded-lg shadow-lg py-1 min-w-32"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted w-full text-left"
              onClick={() => { onOpen(book); setMenuOpen(false) }}
            >
              <EditIcon className="w-3 h-3" /> 打开编辑
            </button>
            <button
              className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted w-full text-left"
              onClick={handleChangeCover}
              disabled={coverChanging}
            >
              <ImageIcon className="w-3 h-3" /> 修改封面
            </button>
            <button
              className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted w-full text-left text-destructive"
              onClick={handleDelete}
            >
              <Trash2Icon className="w-3 h-3" /> 删除
            </button>
          </div>
        )}

        {/* 遮盖层关闭菜单 */}
        {menuOpen && (
          <div
            className="fixed inset-0 z-10"
            onClick={() => setMenuOpen(false)}
          />
        )}
      </div>
    )
  }

  // Grid 卡片
  return (
    <div
      className="relative group rounded-xl border bg-card hover:border-primary/40 hover:shadow-md transition-all cursor-pointer overflow-hidden"
      onDoubleClick={() => onOpen(book)}
    >
      {/* 封面区域 */}
      <div className="aspect-[3/4] bg-gradient-to-br from-primary/20 via-primary/10 to-accent flex items-end p-3 relative">
        {coverSrc ? (
          <img src={coverSrc} alt={book.title} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-4xl font-bold text-primary/20">{book.title.charAt(0)}</span>
          </div>
        )}

        {/* 日更进度环 */}
        {book.dailyTarget > 0 && (
          <div className="absolute top-2 right-2">
            <ProgressRing progress={dailyProgress} size={28} />
          </div>
        )}
      </div>

      {/* 信息区 */}
      <div className="p-3">
        <p className="font-medium text-sm truncate">{book.title}</p>
        <p className="text-xs text-muted-foreground">{book.author}</p>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-muted-foreground">{formatWordCount(book.wordCount)}</span>
          <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
            <CalendarIcon className="w-3 h-3" />
            {formatRelativeTime(book.updatedAt)}
          </span>
        </div>
      </div>

      {/* 右键/更多菜单按钮 */}
      <button
        className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 bg-black/40 text-white p-1 rounded-md transition-opacity"
        onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
      >
        <MoreVerticalIcon className="w-3 h-3" />
      </button>

      {/* 下拉菜单 */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute top-8 left-2 z-20 bg-popover border rounded-lg shadow-lg py-1 min-w-32"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted w-full text-left"
            onClick={() => { onOpen(book); setMenuOpen(false) }}
          >
            <EditIcon className="w-3 h-3" /> 打开编辑
          </button>
          <button
            className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted w-full text-left"
            onClick={handleChangeCover}
            disabled={coverChanging}
          >
            <ImageIcon className="w-3 h-3" /> 修改封面
          </button>
          <button
            className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted w-full text-left text-destructive"
            onClick={handleDelete}
          >
            <Trash2Icon className="w-3 h-3" /> 删除
          </button>
        </div>
      )}

      {/* 遮盖层关闭菜单 */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * 日更进度环 SVG 组件
 *
 * @param progress 完成百分比 0-100
 * @param size     SVG 直径（默认 32px）
 */
function ProgressRing({ progress, size = 32 }: { progress: number; size?: number }) {
  const r = (size - 4) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference - (progress / 100) * circumference
  return (
    <svg width={size} height={size} className="rotate-[-90deg]">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={3} />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke="white"
        strokeWidth={3}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  )
}
