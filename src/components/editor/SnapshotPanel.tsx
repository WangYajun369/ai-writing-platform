import { useState, useEffect } from 'react'
import { useAtom } from 'jotai'
import {
  PlusIcon,
  Trash2Icon,
  RotateCcwIcon,
  StarIcon,
  ClockIcon,
  XIcon,
  LoaderIcon,
} from 'lucide-react'
import { snapshotApi } from '@/lib/tauri-bridge'
import { useCurrentChapter, useAppStore } from '@/stores/appStore'
import { contentRefreshAtom } from '@/stores/uiAtoms'
import { cn, formatWordCount, formatRelativeTime } from '@/lib/utils'
import type { Snapshot } from '@/types'

export default function SnapshotPanel() {
  const currentChapter = useCurrentChapter()
  const { updateChapter } = useAppStore()
  const [, setContentRefresh] = useAtom(contentRefreshAtom)
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [labelInput, setLabelInput] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)

  useEffect(() => {
    loadSnapshots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter?.id])

  async function loadSnapshots() {
    if (!currentChapter) return
    setLoading(true)
    try {
      const data = await snapshotApi.list(currentChapter.id)
      setSnapshots(data)
    } catch (err) {
      console.error('加载快照失败', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(label?: string) {
    if (!currentChapter) return
    try {
      const snap = await snapshotApi.create(currentChapter.id, label)
      setSnapshots((prev) => [snap, ...prev])
      setShowCreate(false)
      setLabelInput('')
    } catch (err) {
      console.error('创建快照失败', err)
    }
  }

  async function handleRestore(snap: Snapshot) {
    if (!currentChapter) return
    setRestoring(snap.id)
    try {
      await snapshotApi.restore(snap.id)
      updateChapter(currentChapter.id, {
        contentHtml: snap.contentHtml,
        wordCount: snap.wordCount,
        updatedAt: new Date().toISOString(),
      })
      setContentRefresh((v) => v + 1)
    } catch (err) {
      console.error('恢复快照失败', err)
    } finally {
      setRestoring(null)
    }
  }

  async function handleDelete(snap: Snapshot) {
    try {
      await snapshotApi.delete(snap.id)
      setSnapshots((prev) => prev.filter((s) => s.id !== snap.id))
      if (previewId === snap.id) {
        setPreviewId(null)
        setPreviewHtml('')
      }
    } catch (err) {
      console.error('删除快照失败', err)
    }
  }

  async function handlePreview(snap: Snapshot) {
    if (previewId === snap.id) {
      setPreviewId(null)
      setPreviewHtml('')
      return
    }
    setPreviewLoading(true)
    setPreviewId(snap.id)
    setPreviewHtml('')
    try {
      const html = await snapshotApi.getContent(snap.id)
      setPreviewHtml(html)
    } catch (err) {
      console.error('加载快照内容失败', err)
      setPreviewId(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  if (!currentChapter) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">版本历史</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          请先选择章节
        </div>
      </div>
    )
  }

  // 预览弹窗
  const previewSnap = previewId ? snapshots.find((s) => s.id === previewId) ?? null : null

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="px-3 py-2 border-b">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">版本历史</span>
          <button
            onClick={() => setShowCreate(true)}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title="创建里程碑快照"
          >
            <PlusIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 创建里程碑快照输入框 */}
        {showCreate && (
          <div className="flex gap-1.5 mb-2">
            <input
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate(labelInput.trim() || undefined)
                if (e.key === 'Escape') { setShowCreate(false); setLabelInput('') }
              }}
              placeholder="快照标签（可选）…"
              autoFocus
              className="flex-1 px-2 py-1 text-xs bg-muted rounded-lg outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={() => handleCreate(labelInput.trim() || undefined)}
              className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
            >
              创建
            </button>
            <button
              onClick={() => { setShowCreate(false); setLabelInput('') }}
              className="px-2 py-1 text-xs bg-muted rounded-lg hover:bg-muted/80"
            >
              取消
            </button>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          {currentChapter.title} · {snapshots.length} 个快照
        </div>
      </div>

      {/* 快照列表 */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {loading ? (
          <div className="text-xs text-muted-foreground text-center py-8">加载中…</div>
        ) : snapshots.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">
            还没有版本快照，点击 + 创建
          </div>
        ) : (
          snapshots.map((snap) => (
            <div
              key={snap.id}
              className="p-3 rounded-lg border bg-card hover:border-primary/40 transition-colors"
            >
              {/* 标题行 */}
              <div className="flex items-center gap-2 mb-1">
                {snap.type === 'milestone' ? (
                  <StarIcon className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />
                ) : (
                  <ClockIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                )}
                <span className="text-sm font-medium truncate flex-1">
                  {snap.label || (snap.type === 'milestone' ? '里程碑' : '自动快照')}
                </span>
              </div>

              {/* 元信息 */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                <span>{formatRelativeTime(snap.createdAt)}</span>
                <span className="text-[10px]">{new Date(snap.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span>·</span>
                <span>{formatWordCount(snap.wordCount)}</span>
                {snap.type === 'milestone' && (
                  <span className="px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 text-xs">
                    里程碑
                  </span>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-1.5">
                <button
                  onClick={() => handlePreview(snap)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-muted hover:bg-muted/80 text-muted-foreground"
                >
                  预览
                </button>
                <button
                  onClick={() => handleRestore(snap)}
                  disabled={restoring === snap.id}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 text-xs rounded-md',
                    restoring === snap.id
                      ? 'bg-primary/20 text-primary cursor-wait'
                      : 'bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                >
                  <RotateCcwIcon className={cn('w-3 h-3', restoring === snap.id && 'animate-spin')} />
                  恢复
                </button>
                <button
                  onClick={() => handleDelete(snap)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <Trash2Icon className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 预览弹窗 */}
      {previewId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* 遮罩 */}
          <div className="absolute inset-0 bg-black/50" onClick={() => { setPreviewId(null); setPreviewHtml('') }} />
          {/* 弹窗 */}
          <div className="relative z-10 w-full max-w-3xl max-h-[80vh] flex flex-col bg-card rounded-xl border shadow-2xl mx-4">
            {/* 弹窗头部 */}
            <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0">
              <div className="flex items-center gap-2">
                {previewSnap?.type === 'milestone' ? (
                  <StarIcon className="w-4 h-4 text-yellow-500" />
                ) : (
                  <ClockIcon className="w-4 h-4 text-muted-foreground" />
                )}
                <span className="text-sm font-medium">
                  {previewSnap?.label || (previewSnap?.type === 'milestone' ? '里程碑' : '自动快照')}
                </span>
                {previewSnap && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(previewSnap.createdAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    {' · '}{formatWordCount(previewSnap.wordCount)}
                  </span>
                )}
              </div>
              <button
                onClick={() => { setPreviewId(null); setPreviewHtml('') }}
                className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
            {/* 弹窗内容 */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {previewLoading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <LoaderIcon className="w-5 h-5 animate-spin mr-2" />
                  <span className="text-sm">加载中…</span>
                </div>
              ) : (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none tiptap-editor"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
