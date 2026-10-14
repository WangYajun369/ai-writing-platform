/**
 * 单词关联面板：近义 / 反义 / 派生 / 变形家族 / 手动关联 分组展示
 *
 * - 详情弹层（完整模式）：展示 + 手动增删 + 未收录关联词「＋」一键入词库 + ECDICT 变形家族建议；
 * - 复习卡片翻面后（readonly）：只读展示 + 未收录关联词「＋」入词库，不影响评分流程。
 *
 * 数据随 wordId/word 变化即时重取；收录动作后同步刷新生词本 store。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2Icon, PlusIcon, XIcon, LoaderIcon, SparklesIcon, ListPlusIcon } from 'lucide-react'
import { vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useVocabStore } from '@/stores/vocabStore'
import type { VocabRelationType, VocabRelationView, VocabRelatedCandidate } from '@/types'
import { STATUS_TEXT } from './vocab-utils'

/** 分组展示顺序与中文名 */
const GROUPS: { type: VocabRelationType; label: string }[] = [
  { type: 'synonym', label: '近义词' },
  { type: 'antonym', label: '反义词' },
  { type: 'derived', label: '派生词' },
  { type: 'inflection', label: '变形词' },
  { type: 'manual', label: '手动关联' },
]

interface Props {
  /** 属主生词 id */
  wordId: string
  /** 属主单词文本（变形家族建议查询用） */
  word: string
  /** 只读模式（复习场景）：隐藏删除与手动添加，仅保留「＋收录」 */
  readonly?: boolean
  /** 复习场景：把「在库·学习中」的关联词拉入本轮复习队列（传入才显示按钮） */
  onPullIntoSession?: (vocabWordId: string, wordText: string) => void
  className?: string
}

export default function VocabRelationsPanel({ wordId, word, readonly = false, onPullIntoSession, className }: Props) {
  const refreshAll = useVocabStore((s) => s.refreshAll)
  const [relations, setRelations] = useState<VocabRelationView[]>([])
  const [suggestions, setSuggestions] = useState<VocabRelatedCandidate[]>([])
  const [loading, setLoading] = useState(true)
  // 手动添加表单状态
  const [draft, setDraft] = useState('')
  const [draftType, setDraftType] = useState<VocabRelationType>('synonym')
  const [busy, setBusy] = useState(false)

  /** 拉取关联与变形家族建议（建议中剔除已建立关联的词） */
  const reload = useCallback(async () => {
    try {
      const [rels, cands] = await Promise.all([
        vocabApi.relationsList(wordId),
        vocabApi.relationsSuggest(word),
      ])
      setRelations(rels)
      const linked = new Set(rels.map((r) => r.relatedWord))
      setSuggestions(cands.filter((c) => !linked.has(c.word)))
    } catch {
      setRelations([])
      setSuggestions([])
    } finally {
      setLoading(false)
    }
  }, [wordId, word])

  useEffect(() => {
    setLoading(true)
    void reload()
  }, [reload])

  /** 按类型分组（仅保留非空组） */
  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: relations.filter((r) => r.relationType === g.type),
      })).filter((g) => g.items.length > 0),
    [relations],
  )

  /** 一键收录关联词进生词库（来源标记 related，明日进入首次复习） */
  async function collectWord(w: string) {
    if (busy) return
    setBusy(true)
    try {
      await vocabApi.add({ word: w, source: 'related' })
      toast.success(`已收录「${w}」，明天进入首次复习`)
      void refreshAll()
      await reload()
    } catch (err) {
      toast.error(errText(err, '收录失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 删除一条关联 */
  async function removeRelation(v: VocabRelationView) {
    if (busy) return
    setBusy(true)
    try {
      await vocabApi.relationsRemove(v.id)
      await reload()
    } catch (err) {
      toast.error(errText(err, '删除关联失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 把已在库的建议词正式建立变形关联 */
  async function linkSuggestion(cand: VocabRelatedCandidate) {
    if (busy) return
    setBusy(true)
    try {
      await vocabApi.relationsAdd(wordId, cand.word, 'inflection')
      await reload()
    } catch (err) {
      toast.error(errText(err, '建立关联失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 手动添加关联 */
  async function addManual() {
    const w = draft.trim()
    if (!w || busy) return
    setBusy(true)
    try {
      await vocabApi.relationsAdd(wordId, w, draftType)
      setDraft('')
      await reload()
    } catch (err) {
      toast.error(errText(err, '添加关联失败'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className={cn('flex items-center gap-1.5 py-2 text-[11.5px] text-zinc-500', className)}>
        <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> 加载关联…
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        <Link2Icon className="h-3.5 w-3.5" />
        关联词{relations.length > 0 && <span className="normal-case">（{relations.length}）</span>}
      </div>

      {grouped.length === 0 && suggestions.length === 0 && (
        <p className="text-[12px] italic text-zinc-500">
          暂无关联{readonly ? '' : '，可在下方手动添加；收录时若使用 AI 翻译会自动建立近反义关联'}
        </p>
      )}

      {/* 分组关联 */}
      <div className="space-y-2">
        {grouped.map((g) => (
          <div key={g.type}>
            <div className="mb-1 text-[10.5px] text-zinc-500">{g.label}</div>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((v) => (
                <span
                  key={v.id}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/8 bg-white/3 px-2 py-1 text-[12px] text-zinc-200"
                >
                  <span>{v.relatedWord}</span>
                  {v.inVocab ? (
                    <span
                      className={cn(
                        'rounded px-1 py-px text-[9.5px]',
                        v.vocabStatus === 'mastered' && 'bg-emerald-500/15 text-emerald-300',
                        v.vocabStatus === 'suspended' && 'bg-zinc-500/15 text-zinc-400',
                        v.vocabStatus === 'learning' && 'bg-sky-500/15 text-sky-300',
                      )}
                    >
                      {v.vocabStatus ? STATUS_TEXT[v.vocabStatus] : '已收录'}
                    </span>
                  ) : (
                    <button
                      onClick={() => collectWord(v.relatedWord)}
                      disabled={busy}
                      title="收录该词进生词本"
                      className="flex items-center gap-0.5 rounded px-1 py-px text-[9.5px] text-amber-300 transition hover:bg-amber-500/15 disabled:opacity-50"
                    >
                      <PlusIcon className="h-2.5 w-2.5" /> 收录
                    </button>
                  )}
                  {onPullIntoSession && v.vocabStatus === 'learning' && v.vocabWordId && (
                    <button
                      onClick={() => onPullIntoSession(v.vocabWordId as string, v.relatedWord)}
                      disabled={busy}
                      title="拉入本轮复习队列尾部"
                      className="flex items-center gap-0.5 rounded px-1 py-px text-[9.5px] text-emerald-300 transition hover:bg-emerald-500/15 disabled:opacity-50"
                    >
                      <ListPlusIcon className="h-2.5 w-2.5" /> 顺带复习
                    </button>
                  )}
                  {!readonly && (
                    <button
                      onClick={() => removeRelation(v)}
                      disabled={busy}
                      title="删除该关联"
                      className="text-zinc-500 transition hover:text-red-300 disabled:opacity-50"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ECDICT 变形家族建议（未建立关联的） */}
      {!readonly && suggestions.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-1 text-[10.5px] text-zinc-500">
            <SparklesIcon className="h-3 w-3" /> 词典变形家族
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((c) => (
              <span
                key={c.word}
                className="inline-flex items-center gap-1 rounded-lg border border-dashed border-white/12 px-2 py-1 text-[12px] text-zinc-400"
              >
                <span>{c.word}</span>
                {c.inVocab ? (
                  <button
                    onClick={() => linkSuggestion(c)}
                    disabled={busy}
                    title="与该词建立变形关联"
                    className="rounded px-1 py-px text-[9.5px] text-sky-300 transition hover:bg-sky-500/15 disabled:opacity-50"
                  >
                    关联
                  </button>
                ) : (
                  <button
                    onClick={() => collectWord(c.word)}
                    disabled={busy}
                    title="收录该词进生词本"
                    className="flex items-center gap-0.5 rounded px-1 py-px text-[9.5px] text-amber-300 transition hover:bg-amber-500/15 disabled:opacity-50"
                  >
                    <PlusIcon className="h-2.5 w-2.5" /> 收录
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 手动添加 */}
      {!readonly && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addManual()
            }}
            placeholder="手动添加关联词"
            className="h-7 w-36 rounded-lg border border-white/10 bg-white/5 px-2 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-500/40"
          />
          <select
            value={draftType}
            onChange={(e) => setDraftType(e.target.value as VocabRelationType)}
            className="h-7 rounded-lg border border-white/10 bg-white/5 px-1.5 text-[11.5px] text-zinc-300 outline-none focus:border-sky-500/40"
          >
            {GROUPS.map((g) => (
              <option key={g.type} value={g.type} className="bg-zinc-900">
                {g.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => void addManual()}
            disabled={busy || !draft.trim()}
            className="flex h-7 items-center gap-1 rounded-lg border border-sky-500/40 px-2.5 text-[11.5px] text-sky-300 transition hover:bg-sky-500/10 disabled:opacity-40"
          >
            <PlusIcon className="h-3 w-3" /> 添加
          </button>
        </div>
      )}
    </div>
  )
}
