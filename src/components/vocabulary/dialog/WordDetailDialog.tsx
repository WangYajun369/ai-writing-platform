/**
 * 单词详情弹层：完整释义 / 例句 / SM-2 记忆参数 / 复习历史时间线
 */
import { useEffect, useState } from 'react'
import { XIcon, PencilIcon, HistoryIcon, Trash2Icon, CheckCircle2Icon, PauseIcon, PlayIcon } from 'lucide-react'
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
import { vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useVocabStore } from '@/stores/vocabStore'
import type { VocabReviewLog, VocabWord } from '@/types'
import { RATING_TEXT, STATUS_TEXT, formatNextReview } from '../vocab-utils'
import VocabKnowledgeView from '../VocabKnowledgeView'
import SpeakButton from '../SpeakButton'

interface Props {
  word: VocabWord | null
  onClose: () => void
  onEdit: (word: VocabWord) => void
}

export default function WordDetailDialog({ word, onClose, onEdit }: Props) {
  const refreshAll = useVocabStore((s) => s.refreshAll)
  const [logs, setLogs] = useState<VocabReviewLog[]>([])

  useEffect(() => {
    if (!word) return
    setLogs([])
    vocabApi
      .logs(word.id)
      .then(setLogs)
      .catch(() => setLogs([]))
  }, [word])

  if (!word) return null

  async function setStatus(status: VocabWord['status']) {
    if (!word) return
    try {
      await vocabApi.setStatus(word.id, status)
      toast.success(status === 'mastered' ? `「${word.word}」已标记为掌握` : `「${word.word}」已更新`)
      void refreshAll()
      onClose()
    } catch (err) {
      toast.error(errText(err, '操作失败'))
    }
  }

  async function handleDelete() {
    if (!word) return
    const ok = await confirmDialog(`确定删除「${word.word}」吗？\n其复习记录将一并清除，此操作不可撤销。`, {
      title: '删除生词',
      kind: 'warning',
      okLabel: '删除',
      cancelLabel: '取消',
    })
    if (!ok) return
    await vocabApi.delete(word.id)
    toast.success(`已删除「${word.word}」`)
    void refreshAll()
    onClose()
  }

  const mastered = word.status === 'mastered'
  const suspended = word.status === 'suspended'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[86vh] w-[600px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d1526] shadow-2xl shadow-black/50">
        {/* 头部 */}
        <div className="flex items-start gap-3 border-b border-white/8 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="text-[24px] font-bold tracking-wide text-zinc-50">{word.word}</span>
              <SpeakButton text={word.word} size={16} className="mt-1" />
              {word.phonetic && <span className="text-[13px] text-zinc-400">{word.phonetic}</span>}
              <span
                className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[10px]',
                  mastered && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
                  suspended && 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
                  !mastered && !suspended && 'border-sky-500/25 bg-sky-500/10 text-sky-300',
                )}
              >
                {STATUS_TEXT[word.status]}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-zinc-500">
              <span>下次复习：{formatNextReview(word.nextReviewAt)}</span>
              {word.lastReviewAt && <span>上次复习：{word.lastReviewAt.slice(0, 16).replace('T', ' ')}</span>}
              <span>来源：{word.source === 'editor' ? '写作标记' : '手动收录'}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => onEdit(word)}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-zinc-300 transition hover:bg-white/10"
            >
              <PencilIcon className="h-3.5 w-3.5" /> 编辑
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 vocab-scroll">
          {/* 释义 */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">释义</div>
            {word.meanings.length === 0 ? (
              <p className="text-[13px] italic text-zinc-500">暂无释义，点击编辑补充</p>
            ) : (
              <ol className="space-y-1">
                {word.meanings.map((m, i) => (
                  <li key={i} className="flex gap-2 text-[13.5px] leading-relaxed text-zinc-200">
                    <span className="shrink-0 text-zinc-500">{i + 1}.</span>
                    {m.pos && <span className="shrink-0 font-medium text-violet-300">{m.pos}</span>}
                    <span>{m.def}</span>
                  </li>
                ))}
              </ol>
            )}
            {word.example && (
              <div className="mt-2 rounded-lg border border-white/8 bg-white/4 px-3 py-2">
                <div className="flex items-start gap-1.5">
                  <p className="flex-1 text-[12.5px] italic leading-relaxed text-zinc-300">“{word.example}”</p>
                  <SpeakButton text={word.example} size={13} className="mt-0.5" />
                </div>
                {word.exampleZh && (
                  <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">“{word.exampleZh}”</p>
                )}
              </div>
            )}
          </div>

          {/* AI 词条精讲（词根词缀/近反义词/词组/动词变形/词性例句） */}
          {word.knowledge && <VocabKnowledgeView knowledge={word.knowledge} />}

          {/* SM-2 参数 */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">记忆进度（SM-2）</div>
            <div className="grid grid-cols-4 gap-2">
              <MetaCell label="复习次数" value={String(word.reviewCount)} />
              <MetaCell label="答对次数" value={`${word.correctCount}`} />
              <MetaCell label="连续答对" value={`${word.repetition} 次`} />
              <MetaCell label="当前间隔" value={word.intervalDays ? `${word.intervalDays} 天` : '—'} />
              <MetaCell label="难度系数" value={word.easeFactor.toFixed(2)} />
              <MetaCell label="掌握度" value={`${word.status === 'mastered' ? 100 : Math.min(99, Math.round((word.intervalDays / 60) * 55 + (word.repetition / 8) * 45))}%`} />
              <MetaCell label="收录时间" value={word.createdAt.slice(0, 10)} />
              <MetaCell label="来源" value={word.source === 'editor' ? '写作标记' : '手动'} />
            </div>
          </div>

          {/* 复习历史 */}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <HistoryIcon className="h-3.5 w-3.5" />
              复习历史
            </div>
            {logs.length === 0 ? (
              <p className="text-[12px] italic text-zinc-500">还没有复习记录（明天将首次复习）</p>
            ) : (
              <div className="space-y-1">
                {logs.map((log) => (
                  <div key={log.id} className="flex items-center gap-3 rounded-lg border border-white/6 bg-white/3 px-3 py-1.5 text-[12px]">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        log.rating === 0 && 'bg-red-500/15 text-red-300',
                        log.rating === 1 && 'bg-amber-500/15 text-amber-300',
                        log.rating === 2 && 'bg-emerald-500/15 text-emerald-300',
                        log.rating === 3 && 'bg-sky-500/15 text-sky-300',
                      )}
                    >
                      {RATING_TEXT[log.rating]}
                    </span>
                    <span className="shrink-0 text-zinc-400">{log.reviewDate}</span>
                    <span className="flex-1 text-zinc-500">
                      复习 #{log.repetition} · 间隔 {log.intervalDays} 天
                    </span>
                    <span className="text-zinc-500">EF {log.easeFactor.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 操作 */}
        <div className="flex items-center gap-2 border-t border-white/8 bg-black/20 px-5 py-3">
          {!mastered && (
            <button
              onClick={() => setStatus('mastered')}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-[12px] text-emerald-300 transition hover:bg-emerald-500/10"
            >
              <CheckCircle2Icon className="h-3.5 w-3.5" /> 标记为已掌握
            </button>
          )}
          {mastered && (
            <button
              onClick={() => setStatus('learning')}
              className="flex items-center gap-1.5 rounded-lg border border-sky-500/40 px-3 py-1.5 text-[12px] text-sky-300 transition hover:bg-sky-500/10"
            >
              <PlayIcon className="h-3.5 w-3.5" /> 恢复学习
            </button>
          )}
          {!suspended && (
            <button
              onClick={() => setStatus('suspended')}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 px-3 py-1.5 text-[12px] text-amber-300 transition hover:bg-amber-500/10"
            >
              <PauseIcon className="h-3.5 w-3.5" /> 暂停
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-1.5 text-[12px] text-red-300 transition hover:bg-red-500/10"
          >
            <Trash2Icon className="h-3.5 w-3.5" /> 删除
          </button>
        </div>
      </div>
    </div>
  )
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/6 bg-white/3 px-2.5 py-1.5">
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="mt-0.5 truncate text-[12.5px] font-medium text-zinc-200" title={value}>
        {value}
      </div>
    </div>
  )
}
