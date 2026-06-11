/**
 * TrashModal — 作品回收站弹窗
 *
 * 展示所有已软删除的作品，支持：
 * - 单个恢复（还原到书库）
 * - 单个彻底删除（不可恢复）
 * - 一键清空回收站
 */
import { useEffect, useState, useCallback } from 'react'
import { Trash2Icon, RotateCcwIcon, XIcon, AlertTriangleIcon, BookOpenIcon } from 'lucide-react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { bookApi } from '@/lib/tauri-bridge'
import { formatWordCount, formatRelativeTime } from '@/lib/utils'
import { resolveCoverSrc } from '@/lib/image-utils.ts'
import type { Book } from '@/types'

interface TrashModalProps {
  onClose: () => void
  onChanged: () => void
}

export default function TrashModal({ onClose, onChanged }: TrashModalProps) {
  const [deletedBooks, setDeletedBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [actioning, setActioning] = useState<string | null>(null)
  const [coverSrcs, setCoverSrcs] = useState<Record<string, string | undefined>>({})

  const loadDeleted = useCallback(async () => {
    setLoading(true)
    try {
      const list = await bookApi.listDeleted()
      setDeletedBooks(list)
    } catch (err) {
      console.error('加载回收站失败', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDeleted()
  }, [loadDeleted])

  // 异步解析封面为 data URL
  useEffect(() => {
    const controller = new AbortController()
    const newSrcs: Record<string, string | undefined> = {}
    Promise.all(
      deletedBooks.map(async (book) => {
        const src = await resolveCoverSrc(book.coverImage)
        newSrcs[book.id] = src
      })
    ).then(() => {
      if (!controller.signal.aborted) {
        setCoverSrcs(newSrcs)
      }
    })
    return () => { controller.abort() }
  }, [deletedBooks])

  /** 恢复单个作品 */
  async function handleRestore(book: Book) {
    setActioning(book.id)
    try {
      await bookApi.restore(book.id)
      setDeletedBooks((prev) => prev.filter((b) => b.id !== book.id))
      onChanged()
    } catch (err) {
      console.error('恢复失败', err)
    } finally {
      setActioning(null)
    }
  }

  /** 彻底删除单个作品 */
  async function handleHardDelete(book: Book) {
    const ok = await confirm(
      `确定彻底删除《${book.title}》？\n\n此操作将删除该作品的全部数据（卷、章节、快照、世界观卡片、AI 对话等），不可恢复！`,
      { title: '彻底删除', kind: 'warning' },
    )
    if (!ok) return
    setActioning(book.id)
    try {
      await bookApi.hardDelete(book.id)
      setDeletedBooks((prev) => prev.filter((b) => b.id !== book.id))
      onChanged()
    } catch (err) {
      console.error('彻底删除失败', err)
    } finally {
      setActioning(null)
    }
  }

  /** 一键清空回收站 */
  async function handleClearAll() {
    if (deletedBooks.length === 0) return
    const ok = await confirm(
      `确定清空回收站？\n\n将彻底删除全部 ${deletedBooks.length} 个作品及其所有数据，此操作不可恢复！`,
      { title: '清空回收站', kind: 'warning' },
    )
    if (!ok) return
    setActioning('__clear__')
    try {
      await bookApi.clearTrash()
      setDeletedBooks([])
      onChanged()
    } catch (err) {
      console.error('清空回收站失败', err)
    } finally {
      setActioning(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/40" />

      {/* 弹窗面板 */}
      <div
        className="relative bg-card rounded-2xl border shadow-2xl w-full max-w-lg max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Trash2Icon className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">作品回收站</h2>
            {deletedBooks.length > 0 && (
              <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                {deletedBooks.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
            </div>
          ) : deletedBooks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <BookOpenIcon className="w-12 h-12 text-muted-foreground/20" />
              <p className="text-sm">回收站为空</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {deletedBooks.map((book) => (
                <div
                  key={book.id}
                  className="flex items-center gap-3 px-3 py-3 rounded-xl bg-muted/50 border border-border/50 group"
                >
                  {/* 封面缩略图 */}
                  <div className="w-9 h-12 rounded bg-gradient-to-br from-muted-foreground/10 to-muted-foreground/5 flex-shrink-0 flex items-center justify-center overflow-hidden">
                    {coverSrcs[book.id] ? (
                      <img
                        src={coverSrcs[book.id]}
                        alt={book.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground/40 font-semibold">
                        {book.title.charAt(0)}
                      </span>
                    )}
                  </div>

                  {/* 作品信息 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{book.title}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      <span>{book.author || '未署名'}</span>
                      <span>·</span>
                      <span>{formatWordCount(book.wordCount)}</span>
                      {book.deletedAt && (
                        <>
                          <span>·</span>
                          <span>{formatRelativeTime(book.deletedAt)}删除</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleRestore(book)}
                      disabled={actioning === book.id}
                      className="p-1.5 rounded-lg hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                      title="恢复"
                    >
                      <RotateCcwIcon className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleHardDelete(book)}
                      disabled={actioning === book.id}
                      className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title="彻底删除"
                    >
                      <Trash2Icon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底栏：清空按钮 */}
        {deletedBooks.length > 0 && (
          <div className="px-5 py-3 border-t bg-muted/20">
            <button
              onClick={handleClearAll}
              disabled={actioning === '__clear__'}
              className="flex items-center gap-2 w-full justify-center px-4 py-2 text-sm text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              <AlertTriangleIcon className="w-4 h-4" />
              {actioning === '__clear__' ? '清空中…' : `一键清空回收站（${deletedBooks.length} 个作品）`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
