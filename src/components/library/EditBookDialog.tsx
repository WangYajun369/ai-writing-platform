/**
 * EditBookDialog — 编辑作品信息弹窗
 *
 * 可修改书名、作者、简介、每日目标字数、封面图片等字段。
 * 修改成功后通过 updateBook 更新全局状态并触发回调。
 */
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from 'lucide-react'
import { bookApi } from '@/lib/tauri-bridge'
import { useAppStore } from '@/stores/appStore'
import CoverPicker from './CoverPicker'
import { resolveCoverSrc } from '@/lib/image-utils.ts'
import type { Book } from '@/types'

interface EditBookDialogProps {
  book: Book
  onClose: () => void
  onSaved: (book: Book) => void
}

export default function EditBookDialog({ book, onClose, onSaved }: EditBookDialogProps) {
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author)
  const [description, setDescription] = useState(book.description)
  const [dailyTarget, setDailyTarget] = useState(book.dailyTarget)
  const [coverPath, setCoverPath] = useState('') // 本地文件绝对路径（替换为新封面时使用）
  const [coverRemoved, setCoverRemoved] = useState(false) // 是否明确移除了封面
  const [currentCoverPreview, setCurrentCoverPreview] = useState<string | undefined>(undefined)
  const [newCoverPreview, setNewCoverPreview] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const { updateBook } = useAppStore()

  // 加载当前封面预览
  useEffect(() => {
    let cancelled = false
    resolveCoverSrc(book.coverImage || null).then((src) => {
      if (!cancelled) setCurrentCoverPreview(src)
    })
    return () => { cancelled = true }
  }, [book.coverImage])

  // 加载新选封面预览
  useEffect(() => {
    let cancelled = false
    resolveCoverSrc(coverPath || null).then((src) => {
      if (!cancelled) setNewCoverPreview(src)
    })
    return () => { cancelled = true }
  }, [coverPath])

  /** 显示的封面预览：优先展示新选的，其次当前封面 */
  const displayCoverPreview = coverRemoved
    ? undefined
    : newCoverPreview ?? currentCoverPreview

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      // 先更新元数据
      const updated = await bookApi.update(book.id, {
        title: title.trim(),
        author: author.trim() || '未署名',
        description: description.trim(),
        dailyTarget,
      })

      let finalBook = updated

      // 处理封面变更
      if (coverRemoved) {
        // 移除封面：传入空字符串
        finalBook = await bookApi.setCover(book.id, '')
      } else if (coverPath) {
        // 更换为新封面
        finalBook = await bookApi.setCover(book.id, coverPath)
      }

      updateBook(book.id, finalBook)
      onSaved(finalBook)
    } catch (err) {
      console.error('更新作品失败', err)
      alert('更新失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  function handleCoverChange(filePath: string) {
    if (filePath) {
      setCoverPath(filePath)
      setCoverRemoved(false)
    } else {
      // CoverPicker 内部点击了"移除"按钮
      setCoverPath('')
      setNewCoverPreview(undefined)
      setCoverRemoved(true)
    }
  }

  return createPortal(
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 bg-black/50 z-[60]" onClick={onClose} />

      {/* 弹窗 */}
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-full max-w-md bg-card border rounded-2xl shadow-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">编辑作品信息</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 封面选择 */}
          <div className="space-y-1">
            <label className="text-sm font-medium">封面</label>
            <CoverPicker
              value={displayCoverPreview}
              onChange={handleCoverChange}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">书名 <span className="text-destructive">*</span></label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="请输入书名"
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">作者</label>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="笔名 / 作者"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">简介</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
              placeholder="一句话介绍你的故事…"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">每日目标字数</label>
            <input
              type="number"
              min={0}
              value={dailyTarget}
              onChange={(e) => setDailyTarget(parseInt(e.target.value) || 0)}
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg border text-sm hover:bg-muted transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </>,
    document.body,
  )
}
