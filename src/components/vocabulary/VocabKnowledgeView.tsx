/**
 * AI（DeepSeek）词条精讲展示 + 可选「加入关联」
 *
 * 渲染一个词条的学习知识：词根词缀、近义词、反义词、常用词组、
 * 动词变形与按词性例句。
 *
 * 传入 wordId 时，近义词 / 反义词标签多出「＋加入关联」按钮
 * （调用 vocabApi.relationsAdd 写入 vocab_word_relations 表，
 *  让关联图谱和 VocabRelationsPanel 自动同步）。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { PlusIcon } from 'lucide-react'
import type { VocabKnowledge, VocabRelationType } from '@/types'
import { cn } from '@/lib/utils'
import { errText } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { vocabApi } from '@/lib/tauri-bridge'
import SpeakButton from './SpeakButton'

/** 构词单元类型 → 中文标签：前缀 / 词根 / 后缀（未知类型回退「构词」） */
const KIND_LABEL: Record<string, string> = { prefix: '前缀', root: '词根', suffix: '后缀' }

/** 从 AI 近 / 反义词条目提取英文词（剥离中文小注、括号、连字符），
 *  与后端 vocab_relation_service::extract_english_word 逻辑保持一致。
 *  条目形如 "happy（高兴的）" / "well-known"；取首个非 [a-zA-Z-'] 字符前的部分。
 *  词组（含空格）返回 null，避免建出 take off → take 之类的错关联。 */
function extractEnglishWord(entry: string): string | null {
  const trimmed = entry.trim()
  if (!trimmed || trimmed.includes(' ')) return null
  let end = trimmed.length
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && c !== '-' && c !== "'") {
      end = i
      break
    }
  }
  let w = trimmed.slice(0, end).replace(/^[-']+|[-']+$/g, '').toLowerCase()
  return w || null
}

interface Props {
  /** 词条精讲数据；null/undefined 或六类内容全空时整块不渲染 */
  knowledge: VocabKnowledge | null | undefined
  /** 传入时近 / 反义词可一键加入关联表（详情弹层场景传，收录预览场景不传） */
  wordId?: string
  /** 手动加入关联成功后通知上层刷新关联面板 */
  onRelationChanged?: () => void
  className?: string
}

/** 单条近 / 反义词标签：可纯展示或带「＋加入关联」 */
function WordTag({
  entry,
  wordId,
  relationType,
  onRelationChanged,
}: {
  entry: string
  wordId?: string
  relationType: VocabRelationType
  onRelationChanged?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const word = extractEnglishWord(entry)

  async function handleAdd() {
    if (!wordId || !word || busy) return
    setBusy(true)
    try {
      await vocabApi.relationsAdd(wordId, word, relationType)
      toast.success(`已加入${relationType === 'synonym' ? '近义' : relationType === 'antonym' ? '反义' : '关联'}：${word}`)
      onRelationChanged?.()
    } catch (err) {
      toast.error(errText(err, '加入关联失败'))
    } finally {
      setBusy(false)
    }
  }

  const color =
    relationType === 'synonym'
      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
      : 'border-rose-500/20 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[11px] transition',
        color,
      )}
    >
      <span>{entry}</span>
      {wordId && word && (
        <button
          onClick={() => void handleAdd()}
          disabled={busy}
          title={`加入${relationType === 'synonym' ? '近义' : '反义'}关联：${word}`}
          className="ml-0.5 flex items-center gap-px rounded px-0.5 text-[9.5px] opacity-60 transition hover:opacity-100 hover:bg-white/10 disabled:opacity-40"
        >
          <PlusIcon className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  )
}

/** 板块小标题：统一大写字距排版，使六类内容在视觉上层次分明 */
function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </div>
  )
}

interface Props {
  /** 词条精讲数据；null/undefined 或六类内容全空时整块不渲染 */
  knowledge: VocabKnowledge | null | undefined
  /** 附加样式类 */
  className?: string
}

export default function VocabKnowledgeView({ knowledge, wordId, onRelationChanged, className }: Props) {
  if (!knowledge) return null
  // 六类板块（词根词缀/近反义词/词组/动词变形/例句）全部为空时隐藏整个卡片
  const isEmpty =
    !knowledge.morphology.length &&
    !knowledge.synonyms.length &&
    !knowledge.antonyms.length &&
    !knowledge.phrases.length &&
    !knowledge.verbForms.length &&
    !knowledge.examples.length
  if (isEmpty) return null

  return (
    <div
      className={cn(
        'space-y-3 rounded-xl border border-violet-500/15 bg-violet-500/5 p-3.5',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-violet-300/80">
        <SparklesDot />
        DeepSeek 词条精讲 · 随词保存，复习时可见
      </div>

      {/* 词根词缀 */}
      {knowledge.morphology.length > 0 && (
        <section>
          <SectionTitle>词根词缀</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {knowledge.morphology.map((m, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/5 px-2 py-1 text-[11.5px]"
              >
                <em className="rounded bg-amber-500/15 px-1 py-px text-[10px] font-semibold not-italic text-amber-300">
                  {KIND_LABEL[m.kind] || m.kind || '构词'}
                </em>
                <span className="font-semibold text-zinc-100">{m.part}</span>
                {m.meaning && <span className="text-zinc-400">{m.meaning}</span>}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 近义词 / 反义词（传 wordId 时带「＋加入关联」按钮） */}
      {(knowledge.synonyms.length > 0 || knowledge.antonyms.length > 0) && (
        <div className="grid grid-cols-2 gap-3">
          {knowledge.synonyms.length > 0 && (
            <section>
              <SectionTitle>近义词</SectionTitle>
              <div className="flex flex-wrap gap-1">
                {knowledge.synonyms.map((s, i) => (
                  <WordTag key={i} entry={s} wordId={wordId} relationType="synonym" onRelationChanged={onRelationChanged} />
                ))}
              </div>
            </section>
          )}
          {knowledge.antonyms.length > 0 && (
            <section>
              <SectionTitle>反义词</SectionTitle>
              <div className="flex flex-wrap gap-1">
                {knowledge.antonyms.map((a, i) => (
                  <WordTag key={i} entry={a} wordId={wordId} relationType="antonym" onRelationChanged={onRelationChanged} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* 常用词组短语 */}
      {knowledge.phrases.length > 0 && (
        <section>
          <SectionTitle>常用词组</SectionTitle>
          <ul className="space-y-1">
            {knowledge.phrases.map((p, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]">
                <span className="flex items-center gap-1">
                  <span className="font-medium text-sky-200">{p.phrase}</span>
                  <SpeakButton text={p.phrase} size={12} />
                </span>
                {p.meaning && <span className="mt-px text-zinc-400">{p.meaning}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 动词变形 */}
      {knowledge.verbForms.length > 0 && (
        <section>
          <SectionTitle>动词变形</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {knowledge.verbForms.map((f, i) => (
              <span
                key={i}
                className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-200"
              >
                {f}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 按词性例句 */}
      {knowledge.examples.length > 0 && (
        <section>
          <SectionTitle>词性例句</SectionTitle>
          <ul className="space-y-1.5">
            {knowledge.examples.map((e, i) => (
              <li key={i} className="rounded-lg border border-white/6 bg-white/3 px-2.5 py-1.5">
                <div className="flex items-start gap-2">
                  <span className="mt-px shrink-0 rounded bg-indigo-500/15 px-1 py-px text-[10px] font-semibold text-indigo-300">
                    {e.pos}
                  </span>
                  <div className="space-y-0.5">
                    <div className="flex items-start gap-1.5">
                      <p className="text-[12.5px] italic leading-relaxed text-zinc-200">{e.sentence}</p>
                      <SpeakButton text={e.sentence} size={12} className="mt-0.5" />
                    </div>
                    {e.translation && <p className="text-[11.5px] text-zinc-500">{e.translation}</p>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function SparklesDot() {
  return <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-linear-to-r from-violet-400 to-fuchsia-400" />
}
