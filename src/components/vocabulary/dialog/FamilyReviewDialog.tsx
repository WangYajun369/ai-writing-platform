/**
 * 词族复习选择弹层
 *
 * 后端把「学习中」生词按 ECDICT 原型 lemma 聚族（≥2 成员成族，按成员数降序），
 * 这里逐族展示成员，点「开始复习」把整族拉入一轮 SM-2 复习会话。
 */
import { useEffect, useState } from 'react'
import { XIcon, NetworkIcon, LoaderIcon, PlayCircleIcon } from 'lucide-react'
import { vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import type { VocabFamilyGroup, VocabWord } from '@/types'
import { meaningsSummary } from '../vocab-utils'

interface Props {
  open: boolean
  onClose: () => void
  /** 选定词族后回调：成员列表 + 会话标签 */
  onStart: (words: VocabWord[], label: string) => void
}

export default function FamilyReviewDialog({ open, onClose, onStart }: Props) {
  const [groups, setGroups] = useState<VocabFamilyGroup[]>([])
  const [loading, setLoading] = useState(false)

  // 每次打开重新聚族（学习状态可能已变化）
  useEffect(() => {
    if (!open) return
    setLoading(true)
    vocabApi
      .familyGroups()
      .then(setGroups)
      .catch((err) => {
        toast.error(errText(err, '加载词族失败'))
        setGroups([])
      })
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[80vh] w-[520px] max-w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d1526] shadow-2xl shadow-black/50">
        {/* 标题 */}
        <div className="flex items-center gap-2.5 border-b border-white/8 px-5 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-sky-600">
            <NetworkIcon className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-[14px] font-semibold">词族复习</div>
            <div className="text-[10.5px] text-zinc-500">同词典原型的学习中单词聚成一族，变形词一起过</div>
          </div>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* 词族列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 vocab-scroll">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[12.5px] text-zinc-500">
              <LoaderIcon className="h-4 w-4 animate-spin" /> 正在按词典原型聚族…
            </div>
          ) : groups.length === 0 ? (
            <p className="px-6 py-12 text-center text-[12.5px] leading-relaxed text-zinc-500">
              暂无可复习的词族。
              <br />
              需要 ≥2 个学习中单词拥有相同词典原型（如 work / worked / working），且已安装离线词库。
            </p>
          ) : (
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g.lemma} className="rounded-xl border border-white/8 bg-white/3 px-4 py-3">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-[13px] font-semibold text-zinc-100">{g.lemma} 族</span>
                    <span className="text-[11px] text-zinc-500">{g.words.length} 个成员</span>
                  </div>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {g.words.map((w) => (
                      <span
                        key={w.id}
                        title={meaningsSummary(w)}
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[12px] text-zinc-200"
                      >
                        {w.word}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => onStart(g.words, `词族复习 · ${g.lemma}`)}
                    className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-sky-500 to-indigo-500 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg shadow-sky-900/30 transition hover:opacity-90"
                  >
                    <PlayCircleIcon className="h-3.5 w-3.5" /> 开始复习（{g.words.length}）
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
