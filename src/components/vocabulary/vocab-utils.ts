/**
 * 生词本 UI 工具函数
 */
import type { DictHit, VocabMeaning, VocabRating, VocabWord } from '@/types'

/** 复习自评四档元信息 */
export const RATING_META: {
  rating: VocabRating
  label: string
  desc: string
  hint: string
  className: string
  activeClassName: string
}[] = [
  {
    rating: 0,
    label: '忘记',
    desc: '重学',
    hint: '没想起来，将重新按短间隔复习',
    className: 'border-red-500/30 text-red-300 hover:border-red-500/60 hover:bg-red-500/10',
    activeClassName: 'bg-red-500/15 border-red-400/70 text-red-200',
  },
  {
    rating: 1,
    label: '模糊',
    desc: '困难',
    hint: '想起来了但不稳，间隔增长放缓',
    className: 'border-amber-500/30 text-amber-300 hover:border-amber-500/60 hover:bg-amber-500/10',
    activeClassName: 'bg-amber-500/15 border-amber-400/70 text-amber-200',
  },
  {
    rating: 2,
    label: '记得',
    desc: '良好',
    hint: '能回忆起来，按计划推进',
    className: 'border-emerald-500/30 text-emerald-300 hover:border-emerald-500/60 hover:bg-emerald-500/10',
    activeClassName: 'bg-emerald-500/15 border-emerald-400/70 text-emerald-200',
  },
  {
    rating: 3,
    label: '轻松',
    desc: '完美',
    hint: '秒答，间隔会拉长',
    className: 'border-sky-500/30 text-sky-300 hover:border-sky-500/60 hover:bg-sky-500/10',
    activeClassName: 'bg-sky-500/15 border-sky-400/70 text-sky-200',
  },
]

/** 复习记录评分对应的中文描述 */
export const RATING_TEXT: Record<VocabRating, string> = {
  0: '忘记',
  1: '模糊',
  2: '记得',
  3: '轻松',
}

/** 状态中文 */
export const STATUS_TEXT: Record<string, string> = {
  learning: '学习中',
  mastered: '已掌握',
  suspended: '暂停',
}

/** 复习到期日期的人类可读描述 */
export function formatNextReview(date: string | null): string {
  if (!date) return '未排期'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  const target = new Date(y, m - 1, d)
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  if (diff < 0) return `已逾期 ${-diff} 天`
  if (diff === 0) return '今天到期'
  if (diff === 1) return '明天'
  if (diff < 30) return `${diff} 天后`
  const mm = Math.round(diff / 30)
  if (diff < 365) return `${mm} 个月后`
  return `${(diff / 365).toFixed(1)} 年后`
}

/** 常见词性标记正则（含可选点号和后续空白） */
export const POS_PREFIX_RE =
  /^(n|v|vt|vi|adj|adv|prep|conj|pron|art|aux|modal|num|int|det|abbr|phr|sentence)\.?\s+(.*)$/i

/** 把 AI 返回的释义做兜底拆分：模型有时把 "n. 释义" 全写进 pos，def 为空 */
export function normalizeAiMeaning(m: VocabMeaning): VocabMeaning {
  const def = (m.def || '').trim()
  if (def) {
    return { pos: (m.pos || '').trim(), def }
  }
  const pos = (m.pos || '').trim()
  const match = pos.match(POS_PREFIX_RE)
  if (match) {
    return { pos: `${match[1].toLowerCase()}.`, def: match[2].trim() || pos }
  }
  return { pos, def }
}

/** 将 ECDICT translation 多行文本解析为可编辑释义列表 */
export function parseDictTranslation(hit: DictHit): VocabMeaning[] {
  const out: VocabMeaning[] = []
  const lines = (hit.translation || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  // 常见词性标记
  const posRegex = /^(n|v|vt|vi|adj|adv|prep|conj|pron|art|aux|modal|num|int|det|abbr|phr|sentence)\.?\s/
  for (const line of lines) {
    // 去掉 [网络]/[经管] 等来源前缀
    const cleaned = line.replace(/^\[[^\]]*\]\s*/, '').trim()
    if (!cleaned) continue
    const posMatch = cleaned.match(posRegex)
    if (posMatch) {
      out.push({ pos: `${posMatch[1]}.`, def: cleaned.slice(posMatch[0].length).trim() || cleaned })
    } else {
      out.push({ pos: '', def: cleaned })
    }
    if (out.length >= 8) break
  }
  return out
}

/** 词条一行中的释义摘要 */
export function meaningsSummary(word: VocabWord, max = 2): string {
  const parts = word.meanings.map((m) => (m.pos ? `${m.pos} ${m.def}` : m.def)).filter(Boolean)
  if (parts.length === 0) return word.example ? word.example : '—'
  return parts.slice(0, max).join('；')
}

/** 掌握度百分比：以 repetition 与 intervalDays 综合估算（SM-2 成熟度） */
export function masteryPercent(word: VocabWord): number {
  if (word.status === 'mastered') return 100
  const p = Math.min(100, Math.round((word.intervalDays / 60) * 55 + (word.repetition / 8) * 45))
  return p
}
