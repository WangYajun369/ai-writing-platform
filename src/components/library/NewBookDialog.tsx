/**
 * NewBookDialog — 新建作品弹窗
 *
 * 包含书名、作者、简介、每日目标字数、封面图片等字段的表单弹窗。
 * 创建成功后将书籍加入全局状态并触发回调。
 */
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from 'lucide-react'
import { bookApi } from '@/lib/tauri-bridge'
import { useAppStore } from '@/stores/appStore'
import CoverPicker from './CoverPicker'
import { isRenderableSrc } from '@/lib/image-utils.ts'
import type { Book } from '@/types'

interface NewBookDialogProps {
  onClose: () => void
  onCreated: (book: Book) => void
}

export default function NewBookDialog({ onClose, onCreated }: NewBookDialogProps) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [description, setDescription] = useState('')
  const [dailyTarget, setDailyTarget] = useState(1000)
  const [coverDataUrl, setCoverDataUrl] = useState('') // 裁剪后的 Base64 data URL
  const [coverPreview, setCoverPreview] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const { addBook } = useAppStore()

  // 同步预览：data URL 可直接渲染
  useEffect(() => {
    setCoverPreview(coverDataUrl && isRenderableSrc(coverDataUrl) ? coverDataUrl : undefined)
  }, [coverDataUrl])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      const book = await bookApi.create({
        title: title.trim(),
        author: author.trim() || '未署名',
        description: description.trim(),
        dailyTarget,
        tags: [],
      })

      // 如果选择了封面，通过 setCoverData 直接保存 data URL
      if (coverDataUrl) {
        const updated = await bookApi.setCoverData(book.id, coverDataUrl)
        addBook(updated)
        onCreated(updated)
      } else {
        addBook(book)
        onCreated(book)
      }
    } catch (err) {
      console.error('创建书籍失败', err)
      alert('创建失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 bg-black/50 z-[60]" onClick={onClose} />

      {/* 弹窗 */}
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-full max-w-md bg-card border rounded-2xl shadow-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">新建作品</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 封面选择（可选） */}
          <div className="space-y-1">
            <label className="text-sm font-medium">封面（可选）</label>
            <CoverPicker
              value={coverPreview}
              onChange={setCoverDataUrl}
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
              {submitting ? '创建中…' : '开始创作'}
            </button>
          </div>
        </form>
      </div>
    </>,
    document.body,
  )
}
