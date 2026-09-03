/**
 * 任务卡时间工具
 *
 * 后端业务时间字段采用本地时间紧凑字符串 `YYYY-MM-DDTHH:MM:SS`
 * （见 src-tauri utils.rs local_now），前端可直接按前缀比较日期。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 今日本地日期 YYYY-MM-DD */
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 取字符串日期前缀（YYYY-MM-DD） */
export function dayOf(s?: string | null): string {
  return s ? s.slice(0, 10) : ''
}

/** 是否今天 */
export function isToday(s?: string | null): boolean {
  return !!s && dayOf(s) === localToday()
}

/** 是否已逾期（未完成任务） */
export function isOverdue(dueTime?: string | null, status?: string): boolean {
  if (!dueTime || status === 'done') return false
  return dayOf(dueTime) < localToday()
}

/** 目标日期与今天相差天数（正=未来，负=过去） */
export function dateDiffDays(date: string): number {
  const target = new Date(date + 'T00:00:00').getTime()
  const today = new Date(localToday() + 'T00:00:00').getTime()
  return Math.round((target - today) / 86400000)
}

/** 友好展示日期时间：今天/明天/昨天/周X/MM/DD */
export function fmtDateTime(s?: string | null): string {
  if (!s) return ''
  const day = dayOf(s)
  const hm = s.slice(11, 16)
  const diff = dateDiffDays(day)
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  if (diff === -1) return `昨天 ${hm}`
  if (diff > 1 && diff < 7) {
    const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `${weeks[new Date(day + 'T00:00:00').getDay()]} ${hm}`
  }
  return `${day.slice(5).replace('-', '/')} ${hm}`
}

/** datetime-local input value（去掉秒） */
export function toInputValue(s?: string | null): string {
  return s ? s.slice(0, 16) : ''
}

/** 由 datetime-local value 生成业务值 */
export function fromInputValue(v: string): string | undefined {
  const t = v.trim()
  return t ? t : undefined
}

/** 截止时间展示：文本 + 配色（逾期红 / 今日琥珀 / 未来灰 / 已完成淡化） */
export function fmtDueText(dueTime?: string | null, done = false): { text: string; cls: string } {
  if (!dueTime) return { text: '无截止', cls: 'text-zinc-600' }
  if (done) return { text: fmtDateTime(dueTime), cls: 'text-zinc-600' }
  if (isOverdue(dueTime)) return { text: `已逾期 · ${fmtDateTime(dueTime)}`, cls: 'text-red-300' }
  if (isToday(dueTime)) return { text: fmtDateTime(dueTime), cls: 'text-amber-300' }
  return { text: fmtDateTime(dueTime), cls: 'text-zinc-500' }
}
