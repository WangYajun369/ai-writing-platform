/**
 * 生词本 Tab — 检索、筛选、收录、查看生词
 */
import { useMemo, useState } from 'react'
import {
  PlusIcon,
  SearchIcon,
  BookMarkedIcon,
  Trash2Icon,
  PauseIcon,
  PlayIcon,
  CheckCircle2Icon,
  PencilIcon,
} from 'lucide-react'
import { useVocabStore } from '@/stores/vocabStore'
import { cn } from '@/lib/utils'
import type { VocabStatus, VocabWord } from '@/types'
import { meaningsSummary, STATUS_TEXT, formatNextReview, masteryPercent } from '../vocab-utils'
import AddWordDialog from '../dialog/AddWordDialog'
import WordDetailDialog from '../dialog/WordDetailDialog'
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
import { vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'

type Filter = VocabStatus | 'all'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'learning', label: '学习中' },
  { key: 'mastered', label: '已掌握' },
  { key: 'suspended', label: '暂停' },
]

export default function WordBookTab() {
  const words = useVocabStore((s) => s.words)
  const stats = useVocabStore((s) => s.stats)
  const refreshAll = useVocabStore((s) => s.refreshAll)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<VocabWord | null>(null)
  const [detail, setDetail] = useState<VocabWord | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return words.filter((w) => {
      if (filter !== 'all' && w.status !== filter) return false
      if (!q) return true
      return (
        w.word.toLowerCase().includes(q) ||
        w.phonetic.toLowerCase().includes(q) ||
        w.meanings.some((m) => m.def.toLowerCase().includes(q))
      )
    })
  }, [words, query, filter])

  async function handleDelete(target: VocabWord) {
    await vocabApi.delete(target.id)
    toast.success(`已删除「${target.word}」`)
    void refreshAll()
  }

  const counts: Record<Filter, number> = useMemo(
    () => ({
      all: stats?.total ?? 0,
      learning: stats?.learning ?? 0,
      mastered: stats?.mastered ?? 0,
      suspended: stats?.suspended ?? 0,
    }),
    [stats],
  )

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0">
        <div className="relative flex-1 max-w-xs">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索单词 / 音标 / 释义…"
            className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-[13px] text-zinc-100 placeholder-zinc-500 outline-none transition focus:border-sky-500/60 focus:bg-white/8"
          />
        </div>

        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-[12px] transition',
                filter === f.key
                  ? 'bg-sky-500/20 text-sky-200 border border-sky-500/30'
                  : 'text-zinc-400 border border-transparent hover:bg-white/5 hover:text-zinc-200',
              )}
            >
              {f.label}
              <span className="ml-1 text-[10px] opacity-70">{counts[f.key]}</span>
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <button
          onClick={() => {
            setEditing(null)
            setAddOpen(true)
          }}
          className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-sky-500 to-indigo-500 px-3.5 py-1.5 text-[13px] font-medium text-white shadow-lg shadow-sky-900/30 transition hover:opacity-90"
        >
          <PlusIcon className="h-4 w-4" />
          收录新词
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 vocab-scroll">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 border border-white/10">
              <BookMarkedIcon className="h-6 w-6 text-zinc-400" />
            </div>
            <div className="text-sm">
              {words.length === 0 ? '还没有收录生词' : '没有符合条件的单词'}
            </div>
            {words.length === 0 && (
              <button
                onClick={() => setAddOpen(true)}
                className="mt-1 flex items-center gap-1.5 rounded-lg border border-sky-500/40 px-3 py-1.5 text-[12.5px] text-sky-300 transition hover:bg-sky-500/10"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                收录第一个单词
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((w) => (
              <WordRow
                key={w.id}
                word={w}
                onOpen={() => setDetail(w)}
                onEdit={() => {
                  setEditing(w)
                  setAddOpen(true)
                }}
                onTogglePause={async () => {
                  const next = w.status === 'suspended' ? 'learning' : 'suspended'
                  await vocabApi.setStatus(w.id, next)
                  toast.success(next === 'suspended' ? `已暂停「${w.word}」` : `已恢复「${w.word}」`)
                  void refreshAll()
                }}
                onMaster={async () => {
                  const next = w.status === 'mastered' ? 'learning' : 'mastered'
                  await vocabApi.setStatus(w.id, next)
                  toast.success(next === 'mastered' ? `已将「${w.word}」标记为掌握` : `已将「${w.word}」恢复学习`)
                  void refreshAll()
                }}
                onDelete={async () => {
                  const ok = await confirmDialog(`确定删除「${w.word}」吗？其复习记录将一并清除。`, {
                    title: '删除生词',
                    kind: 'warning',
                    okLabel: '删除',
                    cancelLabel: '取消',
                  })
                  if (ok) await handleDelete(w)
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 弹层 */}
      <AddWordDialog open={addOpen} editing={editing} onClose={() => setAddOpen(false)} />
      <WordDetailDialog
        word={detail}
        onClose={() => setDetail(null)}
        onEdit={(w) => {
          setDetail(null)
          setEditing(w)
          setAddOpen(true)
        }}
      />
    </div>
  )
}

/** 单行词条 */
function WordRow({
  word,
  onOpen,
  onEdit,
  onTogglePause,
  onMaster,
  onDelete,
}: {
  word: VocabWord
  onOpen: () => void
  onEdit: () => void
  onTogglePause: () => void
  onMaster: () => void
  onDelete: () => void
}) {
  const percent = masteryPercent(word)
  return (
    <div
      onClick={onOpen}
      className="group flex cursor-pointer items-center gap-3 rounded-xl border border-transparent px-3 py-2 transition hover:border-white/10 hover:bg-white/5"
    >
      {/* 掌握度圆环简化：进度条 */}
      <div className="flex w-10 shrink-0 flex-col items-center gap-0.5" title="掌握度">
        <div className="h-1 w-8 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              'h-full rounded-full',
              word.status === 'mastered' ? 'bg-emerald-400' : percent > 60 ? 'bg-sky-400' : 'bg-indigo-400',
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-[9.5px] text-zinc-500">{percent}%</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold text-zinc-100">{word.word}</span>
          {word.phonetic && <span className="shrink-0 text-[11px] text-zinc-500">{word.phonetic}</span>}
        </div>
        <div className="truncate text-[12px] text-zinc-400">{meaningsSummary(word)}</div>
      </div>

      <div className="shrink-0 text-[10.5px] text-zinc-500" title="下次复习">
        {formatNextReview(word.nextReviewAt)}
      </div>

      {/* 状态标 */}
      <span
        className={cn(
          'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] border',
          word.status === 'mastered' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
          word.status === 'suspended' && 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
          word.status === 'learning' && 'border-sky-500/25 bg-sky-500/10 text-sky-300',
        )}
      >
        {STATUS_TEXT[word.status]}
      </span>

      {/* 操作（hover 显示） */}
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
        <IconBtn title="编辑" onClick={onEdit}>
          <PencilIcon className="h-3.5 w-3.5" />
        </IconBtn>
        {word.status !== 'mastered' ? (
          <IconBtn title="标记为已掌握" onClick={onMaster}>
            <CheckCircle2Icon className="h-3.5 w-3.5 text-emerald-400/80" />
          </IconBtn>
        ) : (
          <IconBtn title="恢复学习" onClick={onMaster}>
            <PlayIcon className="h-3.5 w-3.5 text-sky-400/80" />
          </IconBtn>
        )}
        <IconBtn title={word.status === 'suspended' ? '恢复' : '暂停'} onClick={onTogglePause}>
          <PauseIcon className="h-3.5 w-3.5 text-amber-400/80" />
        </IconBtn>
        <IconBtn title="删除" onClick={onDelete}>
          <Trash2Icon className="h-3.5 w-3.5 text-red-400/80" />
        </IconBtn>
      </div>
    </div>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
    >
      {children}
    </button>
  )
}
