/**
 * BookCard — 书籍卡片组件
 *
 * 支持网格（grid）与列表（list）两种视图模式。
 * 网格模式展示封面、日更进度环及右键菜单；
 * 列表模式展示缩略图、书名、作者、字数及操作菜单。
 * 支持修改封面（网格模式悬停显示编辑按钮）。
 */
import { useState, useEffect } from 'react'
import { MoreVerticalIcon, EditIcon, Trash2Icon, CalendarIcon, ImageIcon, PencilIcon, UploadIcon } from 'lucide-react'
import { open, save, confirm } from '@tauri-apps/plugin-dialog'
import { stat } from '@tauri-apps/plugin-fs'
import type { Book } from '@/types'
import { bookApi, importExportApi } from '@/lib/tauri-bridge.ts'
import { formatWordCount, formatRelativeTime } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import { resolveCoverSrc, processCroppedCoverImage, COVER_ASPECT } from '@/lib/image-utils.ts'
import type { CropArea } from '@/lib/image-utils'
import ImageCropperDialog from '@/components/editor/ImageCropperDialog'
import EditBookDialog from './EditBookDialog'
import { useContextMenu } from '@/components/common/ContextMenu'

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
  const [coverChanging, setCoverChanging] = useState(false)
  const [coverSrc, setCoverSrc] = useState<string | undefined>(undefined)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [isExportingBook, setIsExportingBook] = useState(false)
  const [cropperFile, setCropperFile] = useState<string | null>(null)
  const { updateBook } = useAppStore()

  // 异步加载封面为 data URL
  useEffect(() => {
    let cancelled = false
    resolveCoverSrc(book.coverImage).then((src) => {
      if (!cancelled) setCoverSrc(src)
    })
    return () => { cancelled = true }
  }, [book.coverImage])

  // 日更进度百分比
  const dailyProgress = book.dailyTarget > 0
    ? Math.min((book.todayCount / book.dailyTarget) * 100, 100)
    : 0

  /** 导出单个作品完整数据为加密 .tw 文件 */
  async function handleExportSingleBook() {
    if (isExportingBook) return
    setIsExportingBook(true)
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const filePath = await save({
        title: '导出作品数据',
        defaultPath: `TimeWrite-${book.title}-${timestamp}.tw`,
        filters: [{ name: 'TimeWrite 备份', extensions: ['tw'] }],
      })
      if (!filePath) { setIsExportingBook(false); return }

      // 收集该作品相关的 localStorage 缓存
      const cacheData: Record<string, unknown> = {}
      const cacheKeys = [
        'time-write-ai-config',
        'time-write-preferences',
        'time-write-editor-state',
        `time-write-ai-conversations-${book.id}`,
        `time-write-ai-summaries-${book.id}`,
      ]
      for (const key of cacheKeys) {
        const raw = localStorage.getItem(key)
        if (raw) {
          try { cacheData[key] = JSON.parse(raw) } catch { cacheData[key] = raw }
        }
      }

      await importExportApi.exportSingleBook(book.id, filePath, JSON.stringify(cacheData))
      alert(`《${book.title}》导出成功！`)
    } catch (err) {
      console.error('导出作品失败', err)
      alert(`导出失败：${err}`)
    } finally {
      setIsExportingBook(false)
    }
  }

  // 右键菜单（grid / list 共用）
  const { onContextMenu, openMenu, contextMenu } = useContextMenu({
    items: [
      { label: '打开编辑', icon: EditIcon, onClick: () => onOpen(book) },
      { label: '编辑信息', icon: PencilIcon, onClick: () => setShowEditDialog(true) },
      { label: '修改封面', icon: ImageIcon, onClick: handleChangeCover, disabled: coverChanging },
      { type: 'divider' as const },
      { label: '导出作品', icon: UploadIcon, onClick: handleExportSingleBook, disabled: isExportingBook },
      { type: 'divider' as const },
      { label: '删除', icon: Trash2Icon, onClick: handleDelete, danger: true },
    ],
  })

  /** 选择并裁剪封面 */
  async function handleChangeCover() {
    setCoverChanging(true)
    try {
      const selected = await open({
        title: '选择封面图片',
        filters: [{ name: '图片文件', extensions: ALLOWED_COVER_EXTS }],
        multiple: false,
        directory: false,
      })
      if (!selected) { setCoverChanging(false); return }
      const filePath = selected as string

      // 校验扩展名
      const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
      if (!ALLOWED_COVER_EXTS.includes(ext)) {
        alert(`不支持的图片格式 .${ext}，仅支持 jpg、png、webp`)
        setCoverChanging(false)
        return
      }

      // 校验文件大小
      const fileStat = await stat(filePath)
      if (fileStat.size > MAX_COVER_SIZE) {
        const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1)
        alert(`图片过大（${sizeMB} MB），封面不能超过 5 MB`)
        setCoverChanging(false)
        return
      }

      // 打开裁剪弹窗
      setCropperFile(filePath)
    } catch (err) {
      console.error('修改封面失败', err)
      alert('修改封面失败，请重试')
      setCoverChanging(false)
    }
  }

  /** 裁剪确认：处理并保存封面 */
  async function handleCropConfirm(crop: CropArea) {
    const filePath = cropperFile!
    setCropperFile(null)
    try {
      const dataUrl = await processCroppedCoverImage(filePath, crop)
      const updated = await bookApi.setCoverData(book.id, dataUrl)
      updateBook(book.id, updated)
    } catch (err) {
      console.error('裁剪封面失败', err)
      alert('裁剪封面失败，请重试')
    } finally {
      setCoverChanging(false)
    }
  }

  function handleCropClose() {
    setCropperFile(null)
    setCoverChanging(false)
  }

  async function handleDelete() {
    const ok = await confirm(
      `确认将《${book.title}》移入回收站？可在回收站中恢复或彻底删除。`,
      { title: '删除作品', kind: 'warning' },
    )
    if (!ok) return
    try {
      await bookApi.delete(book.id)
      onRefresh()
    } catch (err) {
      console.error('删除失败', err)
    }
  }

  if (viewMode === 'list') {
    return (
      <div
        className="flex items-center gap-4 p-4 rounded-xl bg-card border hover:border-primary/40 transition-all cursor-pointer group relative"
        onDoubleClick={() => onOpen(book)}
        onContextMenu={onContextMenu}
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
          onClick={(e) => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            openMenu(rect.left, rect.bottom + 4)
          }}
        >
          <MoreVerticalIcon className="w-4 h-4" />
        </button>

        {/* 共用右键菜单 */}
        {contextMenu}

        {/* 编辑信息弹窗 */}
        {showEditDialog && (
          <EditBookDialog
            book={book}
            onClose={() => setShowEditDialog(false)}
            onSaved={(_updated) => {
              setShowEditDialog(false)
              onRefresh()
            }}
          />
        )}

        {/* 封面裁剪弹窗 */}
        {cropperFile && (
          <ImageCropperDialog
            filePath={cropperFile}
            aspectRatio={COVER_ASPECT}
            onConfirm={handleCropConfirm}
            onClose={handleCropClose}
          />
        )}
      </div>
    )
  }

  // Grid 卡片
  return (
    <div
      className="relative group rounded-xl border bg-card hover:border-primary/40 hover:shadow-md transition-all cursor-pointer overflow-hidden flex flex-col"
      onDoubleClick={() => onOpen(book)}
      onContextMenu={onContextMenu}
    >
      {/* 封面区域 — 固定宽高比，不受 flex 挤压 */}
      <div className="aspect-[3/4] bg-muted/50 relative flex-shrink-0 overflow-hidden">
        {coverSrc ? (
          <img src={coverSrc} alt={book.title} className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-accent/5 flex items-center justify-center">
            <div className="flex flex-col items-center gap-1.5">
              {/* 书本图标为主视觉 */}
              <svg className="w-8 h-8 text-primary/20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
              {/* 小号首字点缀 */}
              <span className="text-lg font-semibold text-primary/20 select-none">{book.title.charAt(0)}</span>
            </div>
          </div>
        )}

        {/* 日更进度环 */}
        {book.dailyTarget > 0 && (
          <div className="absolute top-2 right-2">
            <ProgressRing progress={dailyProgress} size={28} />
          </div>
        )}
      </div>

      {/* 信息区 — flex-shrink-0 确保不被压缩 */}
      <div className="p-3 flex flex-col gap-0.5 flex-shrink-0">
        <p className="font-medium text-sm truncate leading-tight" title={book.title}>{book.title}</p>
        <p className="text-xs text-muted-foreground truncate leading-tight" title={book.author}>{book.author || '未署名'}</p>
        <div className="flex items-center gap-2 pt-1.5">
          <span className="text-xs text-muted-foreground tabular-nums">{formatWordCount(book.wordCount)}</span>
          <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1 shrink-0">
            <CalendarIcon className="w-3 h-3" />
            {formatRelativeTime(book.updatedAt)}
          </span>
        </div>
      </div>

      {/* 右键/更多菜单按钮 */}
      <button
        className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 bg-black/40 text-white p-1 rounded-md transition-opacity"
        onClick={(e) => {
          e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          openMenu(rect.left, rect.top + 4)
        }}
      >
        <MoreVerticalIcon className="w-3 h-3" />
      </button>

      {/* 共用右键菜单 */}
      {contextMenu}

      {/* 编辑信息弹窗 */}
      {showEditDialog && (
        <EditBookDialog
          book={book}
          onClose={() => setShowEditDialog(false)}
          onSaved={(_updated) => {
            setShowEditDialog(false)
            onRefresh()
          }}
        />
      )}

      {/* 封面裁剪弹窗 */}
      {cropperFile && (
        <ImageCropperDialog
          filePath={cropperFile}
          aspectRatio={COVER_ASPECT}
          onConfirm={handleCropConfirm}
          onClose={handleCropClose}
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
