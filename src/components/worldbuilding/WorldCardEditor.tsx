/**
 * WorldCardEditor — 世界观卡片编辑弹窗
 *
 * 支持新建/编辑/删除世界观卡片。包含类型选择、
 * 标题、内容、标签字段，保存后触发父组件刷新。
 */
import { useState } from 'react'
import { XIcon } from 'lucide-react'
import type { WorldCard, WorldCardType } from '@/types'
import { worldCardApi } from '@/lib/tauri-bridge'
import { WORLD_CARD_TYPE_CONFIG } from '@/lib/utils'

interface WorldCardEditorProps {
  bookId: string
  card: WorldCard | null
  onClose: () => void
  onSaved: () => void
}

export default function WorldCardEditor({ bookId, card, onClose, onSaved }: WorldCardEditorProps) {
  const [type, setType] = useState<WorldCardType>(card?.type ?? 'character')
  const [title, setTitle] = useState(card?.title ?? '')
  const [content, setContent] = useState(card?.content ?? '')
  const [tags, setTags] = useState(card?.tags.join('、') ?? '')
  const [submitting, setSubmitting] = useState(false)

  async function handleSave() {
    if (!title.trim()) return
    setSubmitting(true)
    try {
      const tagList = tags.split(/[，、,]+/).map((t) => t.trim()).filter(Boolean)
      if (card) {
        await worldCardApi.update(card.id, { type, title, content, contentHtml: content, tags: tagList })
      } else {
        await worldCardApi.create({ bookId, type, title, content, contentHtml: content, tags: tagList })
      }
      onSaved()
      onClose()
    } catch (err) {
      console.error('保存失败', err)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!card || !confirm(`确认删除「${card.title}」？`)) return
    await worldCardApi.delete(card.id)
    onSaved()
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-card border rounded-2xl shadow-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{card ? '编辑设定' : '新建设定'}</h3>
          <button onClick={onClose}><XIcon className="w-5 h-5" /></button>
        </div>

        <div className="space-y-3">
          {/* 类型选择 */}
          <div className="flex gap-2 flex-wrap">
            {(Object.keys(WORLD_CARD_TYPE_CONFIG) as WorldCardType[]).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                  type === t ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
                }`}
              >
                {WORLD_CARD_TYPE_CONFIG[t].icon} {WORLD_CARD_TYPE_CONFIG[t].label}
              </button>
            ))}
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题 *"
            className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="设定详情…"
            rows={6}
            className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
          />

          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="标签（用逗号分隔）"
            className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex gap-3 mt-5">
          {card && (
            <button
              onClick={handleDelete}
              className="px-4 py-2 rounded-lg text-sm text-destructive border border-destructive/30 hover:bg-destructive/10 transition-colors"
            >
              删除
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 rounded-lg border text-sm hover:bg-muted">取消</button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || submitting}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
          >
            {submitting ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </>
  )
}
