/**
 * AI（DeepSeek）词条精讲只读展示
 *
 * 渲染一个词条的学习知识：词根词缀、近义词、反义词、常用词组、
 * 动词变形与按词性例句。无知识或知识全空时返回 null。
 */
import type { ReactNode } from 'react'
import type { VocabKnowledge } from '@/types'
import { cn } from '@/lib/utils'
import SpeakButton from './SpeakButton'

const KIND_LABEL: Record<string, string> = { prefix: '前缀', root: '词根', suffix: '后缀' }

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
      {children}
    </div>
  )
}

interface Props {
  knowledge: VocabKnowledge | null | undefined
  className?: string
}

export default function VocabKnowledgeView({ knowledge, className }: Props) {
  if (!knowledge) return null
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

      {/* 近义词 / 反义词 */}
      {(knowledge.synonyms.length > 0 || knowledge.antonyms.length > 0) && (
        <div className="grid grid-cols-2 gap-3">
          {knowledge.synonyms.length > 0 && (
            <section>
              <SectionTitle>近义词</SectionTitle>
              <div className="flex flex-wrap gap-1">
                {knowledge.synonyms.map((s, i) => (
                  <span
                    key={i}
                    className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-200"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </section>
          )}
          {knowledge.antonyms.length > 0 && (
            <section>
              <SectionTitle>反义词</SectionTitle>
              <div className="flex flex-wrap gap-1">
                {knowledge.antonyms.map((a, i) => (
                  <span
                    key={i}
                    className="rounded-md border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-200"
                  >
                    {a}
                  </span>
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
