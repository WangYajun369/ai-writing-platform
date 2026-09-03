/**
 * 今日复习 Tab — SM-2 闪卡复习
 *
 * 流程：翻转卡片回忆 → 四键自评（忘记/模糊/记得/轻松）→ 后端按 SM-2 推进间隔。
 * 「忘记」的词会回到队列尾部再测一次；「已掌握」的词自动移出队列。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { LoaderIcon, SparklesIcon, PlayCircleIcon, CheckCircle2Icon, BookMarkedIcon, RotateCcwIcon } from 'lucide-react'
import { vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useVocabStore } from '@/stores/vocabStore'
import type { VocabRating, VocabWord } from '@/types'
import { RATING_META, meaningsSummary } from '../vocab-utils'
import VocabKnowledgeView from '../VocabKnowledgeView'
import SpeakButton from '../SpeakButton'

interface QueueItem {
  word: VocabWord
  /** 本轮已重测次数（忘记可重测 1 次） */
  revisit: number
}

export default function ReviewTab({ onGotoBook }: { onGotoBook: () => void }) {
  const due = useVocabStore((s) => s.due)
  const words = useVocabStore((s) => s.words)
  const refreshAll = useVocabStore((s) => s.refreshAll)

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [flipped, setFlipped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)
  const [finished, setFinished] = useState(false)
  const [sessionLabel, setSessionLabel] = useState('今日复习')
  const [counts, setCounts] = useState<Record<VocabRating, number>>({ 0: 0, 1: 0, 2: 0, 3: 0 })

  const current = queue[0]

  /** 需要首次学习的新词（今天收录/从未开始复习） */
  const freshWords = useMemo(
    () =>
      words
        .filter((w) => w.status === 'learning' && !w.lastReviewAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 9),
    [words],
  )

  const totalCount = useMemo(() => {
    // 近似总题量 = 已作答 + 剩余（含重测）
    return queue.length + done
  }, [queue.length, done])

  const startSession = useCallback((items: VocabWord[], label: string) => {
    setQueue(items.map((w) => ({ word: w, revisit: 0 })))
    setSessionLabel(label)
    setFlipped(false)
    setDone(0)
    setCounts({ 0: 0, 1: 0, 2: 0, 3: 0 })
    setFinished(false)
  }, [])

  // 队列为空且不是展示结果时，展示初始界面（由 startSession 触发）
  const idle = queue.length === 0 && !finished

  /** 提交自评 */
  const submitRating = useCallback(
    async (rating: VocabRating) => {
      if (!current || busy || !flipped) return
      setBusy(true)
      try {
        const updated = await vocabApi.review(current.word.id, rating)
        setCounts((c) => ({ ...c, [rating]: c[rating] + 1 }))
        const rest = queue.slice(1)
        if (updated.status === 'mastered') {
          // 自动掌握：移出队列
        } else if (rating === 0 && current.revisit < 1) {
          // 忘记：放回队尾再测一次
          rest.push({ word: updated, revisit: current.revisit + 1 })
        }
        setDone((d) => d + 1)
        if (rest.length === 0) {
          setQueue([])
          setFinished(true)
          void refreshAll()
        } else {
          setQueue(rest)
        }
        setFlipped(false)
      } catch (err) {
        toast.error(typeof err === 'string' ? err : '复习提交失败，请重试')
      } finally {
        setBusy(false)
      }
    },
    [current, queue, busy, flipped, refreshAll],
  )

  // 键盘：空格翻面；翻面后 1-4 键评分
  useEffect(() => {
    if (!current || finished) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault()
        if (!busy) setFlipped((f) => !f)
      } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
        void submitRating((Number(e.key) - 1) as VocabRating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, flipped, busy, finished, submitRating])

  // ───────────── 初始 / 空状态 ─────────────
  if (idle) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto vocab-scroll">
        <div className="w-full max-w-xl px-6 py-8">
          {due.length > 0 ? (
            <div className="flex flex-col items-center gap-5 rounded-2xl border border-white/10 bg-linear-to-b from-sky-500/10 to-transparent px-8 py-10 text-center">
              <div className="relative">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-linear-to-br from-sky-500 to-indigo-600 shadow-xl shadow-sky-900/40">
                  <PlayCircleIcon className="h-7 w-7 text-white" />
                </div>
                <span className="absolute -right-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500 px-1.5 text-[12px] font-bold text-white">
                  {due.length}
                </span>
              </div>
              <div>
                <div className="text-[17px] font-semibold">今日有 {due.length} 个单词等待复习</div>
                <div className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">
                  按艾宾浩斯遗忘曲线安排，及时复习可大幅提升记忆留存。
                  <br />
                  空格 / Enter 翻面，1-4 键快速自评。
                </div>
              </div>
              <button
                onClick={() => startSession(due, '今日复习')}
                className="flex items-center gap-2 rounded-xl bg-linear-to-r from-sky-500 to-indigo-500 px-8 py-2.5 text-[14px] font-semibold text-white shadow-lg shadow-sky-900/40 transition hover:opacity-90"
              >
                <PlayCircleIcon className="h-4.5 w-4.5" size={18} />
                开始复习
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
                <CheckCircle2Icon className="h-7 w-7 text-emerald-400" />
              </div>
              <div>
                <div className="text-[15px] font-semibold text-zinc-100">今日复习已全部完成</div>
                <div className="mt-1 text-[12.5px] text-zinc-500">
                  {words.length === 0 ? '去收录今天的第一个生词吧，明天开始第一次复习。' : '新词会在明天进入首次复习队列。'}
                </div>
              </div>
              {freshWords.length > 0 && (
                <div className="w-full">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    <SparklesIcon className="h-3.5 w-3.5" /> 先学今日新词（{freshWords.length}）
                  </div>
                  <div className="space-y-1.5">
                    {freshWords.map((w) => (
                      <button
                        key={w.id}
                        onClick={() => startSession([w], '学习新词')}
                        className="flex w-full items-center gap-3 rounded-xl border border-white/8 bg-white/3 px-4 py-2 text-left transition hover:border-sky-500/30 hover:bg-sky-500/5"
                      >
                        <BookMarkedIcon className="h-4 w-4 shrink-0 text-sky-400" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="font-semibold text-zinc-100">{w.word}</span>
                            {w.phonetic && <span className="text-[11px] text-zinc-500">{w.phonetic}</span>}
                          </div>
                          <div className="truncate text-[11.5px] text-zinc-500">{meaningsSummary(w)}</div>
                        </div>
                        <span className="shrink-0 text-[11px] text-sky-300">学习 →</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {words.length > 0 && freshWords.length === 0 && (
                <button
                  onClick={onGotoBook}
                  className="rounded-lg border border-sky-500/40 px-4 py-2 text-[12.5px] text-sky-300 transition hover:bg-sky-500/10"
                >
                  前往生词本
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ───────────── 完成结果 ─────────────
  if (finished) {
    const stillDue = due.length > 0
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto vocab-scroll">
        <div className="w-full max-w-lg px-6 py-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-linear-to-br from-emerald-500 to-teal-600 shadow-xl shadow-emerald-900/40">
            <CheckCircle2Icon className="h-7 w-7 text-white" />
          </div>
          <div className="mt-4 text-[17px] font-semibold">{sessionLabel}完成</div>
          <div className="mt-1 text-[12.5px] text-zinc-500">共复习 {done} 个单词，间隔已按记忆情况重新排期</div>

          <div className="mt-5 grid grid-cols-4 gap-2">
            {RATING_META.map((meta) => (
              <div
                key={meta.rating}
                className={cn(
                  'rounded-xl border px-2 py-2.5',
                  meta.rating === 0 && 'border-red-500/25 bg-red-500/5',
                  meta.rating === 1 && 'border-amber-500/25 bg-amber-500/5',
                  meta.rating === 2 && 'border-emerald-500/25 bg-emerald-500/5',
                  meta.rating === 3 && 'border-sky-500/25 bg-sky-500/5',
                )}
              >
                <div className="text-[20px] font-bold text-zinc-100">{counts[meta.rating]}</div>
                <div className="text-[10.5px] text-zinc-400">{meta.label}</div>
              </div>
            ))}
          </div>

          <p className="mt-4 text-[11.5px] leading-relaxed text-zinc-500">
            {counts[0] > 0 && '「忘记」的词已重排为短间隔，明天会再次出现。'}
            {counts[0] === 0 && '全部按计划推进，记得放松一下大脑。'}
          </p>

          <div className="mt-6 flex items-center justify-center gap-2.5">
            {stillDue && (
              <button
                onClick={() => startSession(due, '今日复习')}
                className="flex items-center gap-1.5 rounded-xl bg-linear-to-r from-sky-500 to-indigo-500 px-6 py-2 text-[13px] font-medium text-white shadow-lg shadow-sky-900/40 transition hover:opacity-90"
              >
                <RotateCcwIcon className="h-4 w-4" /> 还有 {due.length} 个待复习
              </button>
            )}
            <button
              onClick={() => {
                setFinished(false)
                void refreshAll()
              }}
              className="rounded-xl border border-white/10 px-5 py-2 text-[13px] text-zinc-300 transition hover:bg-white/5"
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ───────────── 复习卡片 ─────────────
  if (!current) return null
  const isFresh = !current.word.lastReviewAt

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto px-6 py-6 vocab-scroll">
      {/* 进度条 */}
      <div className="mb-4 w-full max-w-xl">
        <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500">
          <span className="flex items-center gap-1">
            {sessionLabel}
            {isFresh && <span className="rounded bg-violet-500/15 px-1.5 py-px text-[10px] text-violet-300">新词</span>}
          </span>
          <span>
            {done} / {totalCount}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full bg-linear-to-r from-sky-500 to-indigo-500 transition-all duration-300"
            style={{ width: totalCount > 0 ? `${(done / totalCount) * 100}%` : 0 }}
          />
        </div>
      </div>

      {/* 卡片 */}
      <div
        onClick={() => !busy && !flipped && setFlipped(true)}
        className={cn(
          'relative w-full max-w-xl select-none rounded-2xl border bg-linear-to-b from-white/6 to-white/2 p-7 shadow-2xl shadow-black/30 transition',
          flipped ? 'border-white/15' : 'cursor-pointer border-white/10 hover:border-sky-400/40',
        )}
      >
        {!flipped ? (
          /* 正面：单词 */
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
            <div className="text-[13px] text-zinc-500">
              {isFresh ? '首次学习 · 回忆一下' : '看到单词，先尝试回忆释义'}
            </div>
            <div className="flex items-center justify-center gap-2.5">
              <span className="text-[40px] font-bold tracking-tight text-zinc-50">{current.word.word}</span>
              <SpeakButton text={current.word.word} size={20} className="mt-1.5" />
            </div>
            {current.word.phonetic && <div className="text-[15px] text-zinc-400">{current.word.phonetic}</div>}
            <button
              onClick={(e) => {
                e.stopPropagation()
                setFlipped(true)
              }}
              className="mt-2 rounded-lg border border-white/15 bg-white/5 px-5 py-2 text-[12.5px] text-zinc-200 transition hover:bg-white/10"
            >
              显示释义 <span className="ml-1 text-[10px] text-zinc-500">空格</span>
            </button>
          </div>
        ) : (
          /* 背面：释义 + 自评 */
          <div className="min-h-52">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="text-[22px] font-bold text-zinc-50">{current.word.word}</span>
              <SpeakButton text={current.word.word} size={16} className="mt-0.5" />
              {current.word.phonetic && <span className="text-[13px] text-zinc-400">{current.word.phonetic}</span>}
            </div>

            <ol className="space-y-1">
              {current.word.meanings.length === 0 ? (
                <li className="italic text-zinc-500">暂无释义，可在生词本中补充</li>
              ) : (
                current.word.meanings.map((m, i) => (
                  <li key={i} className="flex gap-2 text-[14px] leading-relaxed text-zinc-100">
                    <span className="text-zinc-600">{i + 1}.</span>
                    {m.pos && <span className="shrink-0 font-medium text-violet-300">{m.pos}</span>}
                    <span>{m.def}</span>
                  </li>
                ))
              )}
            </ol>
            {current.word.example && (
              <div className="mt-2.5 rounded-lg border border-white/8 bg-white/3 px-3 py-2">
                <div className="flex items-start gap-1.5">
                  <p className="flex-1 text-[12px] italic leading-relaxed text-zinc-400">
                    “{current.word.example}”
                  </p>
                  <SpeakButton text={current.word.example} size={13} className="mt-0.5" />
                </div>
                {current.word.exampleZh && (
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">“{current.word.exampleZh}”</p>
                )}
              </div>
            )}

            {/* AI 词条精讲（词根词缀/近反义词/词组/动词变形/词性例句） */}
            {current.word.knowledge && <VocabKnowledgeView knowledge={current.word.knowledge} className="mt-3" />}

            <div className="mt-5 border-t border-white/8 pt-4">
              <div className="mb-2 text-center text-[11px] text-zinc-500">回忆得如何？</div>
              <div className="grid grid-cols-4 gap-2">
                {RATING_META.map((meta) => (
                  <button
                    key={meta.rating}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      void submitRating(meta.rating)
                    }}
                    title={meta.hint}
                    className={cn(
                      'flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2.5 text-[13px] font-medium transition disabled:opacity-50',
                      meta.className,
                    )}
                  >
                    {meta.label}
                    <span className="text-[9.5px] font-normal opacity-70">{meta.desc}</span>
                  </button>
                ))}
              </div>
              <div className="mt-2 text-center text-[10px] text-zinc-600">快捷键 1-4 · 忘记的词会再测一次</div>
            </div>
          </div>
        )}

        {/* 提交中遮罩 */}
        {busy && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-black/30 backdrop-blur-[1px]">
            <LoaderIcon className="h-6 w-6 animate-spin text-sky-400" />
          </div>
        )}
      </div>

      {!flipped && (
        <div className="mt-3 flex items-center gap-2 text-[10.5px] text-zinc-600">
          <span className="rounded border border-white/10 px-1.5 py-0.5">空格 / Enter</span> 翻面
          <span className="mx-1">·</span>
          <span className="rounded border border-white/10 px-1.5 py-0.5">1 - 4</span> 自评
        </div>
      )}
    </div>
  )
}
