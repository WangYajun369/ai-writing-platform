/**
 * 重复任务规则（任务卡 P2）工具
 *
 * rule JSON 格式与 Rust 端 `next_recur_date` 保持兼容：
 * { "freq":"daily|weekly|monthly", "interval":1, "weekdays":[1..7],
 *   "monthDays":[1..31], "endDate":"YYYY-MM-DD"|"" }
 * （旧版单日字段 monthDay 在解析时自动迁移为 monthDays）
 */
import type { RecurrenceRule } from '@/types'

/** 周几显示（1=周一 … 7=周日） */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** JS Date.getDay()（0=周日）→ ISO 序号（1=周一） */
export function jsDayToIso(jsDay: number): number {
  return ((jsDay + 6) % 7) + 1
}

/** ISO 序号（1=周一）→ JS Date.getDay() */
export function isoDayToJs(isoDay: number): number {
  return isoDay % 7
}

/** 今天（本地）的 ISO 周几序号 */
export function todayIsoWeekday(): number {
  return jsDayToIso(new Date().getDay())
}

/** 规整数字数组（min..max 区间、去重升序）；raw 为单数字或数组 */
function normNums(raw: unknown, min: number, max: number): number[] {
  if (raw == null || raw === '') return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out: number[] = []
  for (const item of list) {
    const n = Math.trunc(Number(item))
    if (n >= min && n <= max && !out.includes(n)) out.push(n)
  }
  return out.sort((a, b) => a - b)
}

/** 解析规则 JSON；无效返回 null */
export function parseRule(json: string): RecurrenceRule | null {
  if (!json || json.trim() === '{}') return null
  try {
    const r = JSON.parse(json) as {
      freq?: unknown
      interval?: unknown
      weekdays?: unknown
      monthDays?: unknown
      monthDay?: unknown
      endDate?: unknown
    }
    if (
      !r ||
      !r.freq ||
      !['daily', 'weekly', 'monthly'].includes(r.freq as string)
    ) {
      return null
    }
    return {
      freq: r.freq as RecurrenceRule['freq'],
      interval: Math.max(1, Math.trunc(Number(r.interval) || 1)),
      // 月度日号兼容旧版单日 monthDay
      weekdays: normNums(r.weekdays, 1, 7),
      monthDays: normNums(r.monthDays ?? r.monthDay, 1, 31),
      endDate: typeof r.endDate === 'string' ? r.endDate : '',
    }
  } catch {
    return null
  }
}

/** 序列化为 JSON 字符串（'' 表示不重复） */
export function serializeRule(rule: RecurrenceRule | null): string {
  if (!rule) return ''
  return JSON.stringify(rule)
}

/** 规则说明文案（用于详情展示） */
export function describeRule(json: string): string {
  const r = parseRule(json)
  if (!r) return ''
  const end = r.endDate ? `，截止 ${r.endDate}` : ''
  switch (r.freq) {
    case 'daily':
      return r.interval <= 1 ? `每天${end}` : `每 ${r.interval} 天${end}`
    case 'weekly': {
      if (r.weekdays.length > 0) {
        const days = r.weekdays.map((d) => `周${WEEKDAY_LABELS[d - 1]}`).join('、')
        return r.interval <= 1 ? `每周 ${days}${end}` : `每 ${r.interval} 周（${days}）${end}`
      }
      return r.interval <= 1 ? `每周${end}` : `每 ${r.interval} 周${end}`
    }
    case 'monthly': {
      const ds =
        r.monthDays.length > 0 ? r.monthDays.map((d) => `${d} 日`).join('、') : '同一天'
      return `每月 ${ds}${end}`
    }
  }
}

/** 新建规则：依据给定频率与「每 N」返回默认规则对象 */
export function defaultRule(
  freq: 'daily' | 'weekly' | 'monthly',
  opts?: { interval?: number; weekday?: number; day?: number; endDate?: string },
): RecurrenceRule {
  return {
    freq,
    interval: opts?.interval ?? 1,
    weekdays: freq === 'weekly' ? [opts?.weekday ?? todayIsoWeekday()] : [],
    monthDays: freq === 'monthly' ? [opts?.day ?? new Date().getDate()] : [],
    endDate: opts?.endDate ?? '',
  }
}
