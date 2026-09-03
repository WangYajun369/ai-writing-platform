/**
 * 重复任务选择器（任务卡 P2）
 *
 * 值：recurrence JSON 字符串（'' = 不重复），与 Rust 端规则格式一致。
 * 支持：每天 / 每周（指定周几多选）/ 每月（指定日号）/ 每 N 间隔 / 结束日期。
 */
import { useState } from 'react'
import { CalendarX2Icon, RepeatIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  WEEKDAY_LABELS,
  defaultRule,
  describeRule,
  parseRule,
  serializeRule,
} from '@/lib/recurrence'
import type { RecurrenceRule } from '@/types'

type Freq = 'daily' | 'weekly' | 'monthly'

interface Props {
  value: string
  onChange: (json: string) => void
}

export default function RecurrencePicker({ value, onChange }: Props) {
  const [rule, setRule] = useState<RecurrenceRule | null>(() => parseRule(value))

  function commit(next: RecurrenceRule | null) {
    setRule(next)
    onChange(serializeRule(next))
  }

  function pickFreq(freq: Freq | null) {
    commit(freq ? defaultRule(freq) : null)
  }

  function patch(p: Partial<RecurrenceRule>) {
    if (!rule) return
    commit({ ...rule, ...p })
  }

  /** 每月日号点选 */
  function toggleMonthDay(d: number) {
    if (!rule) return
    const has = rule.monthDays.includes(d)
    patch({
      monthDays: has
        ? rule.monthDays.filter((x) => x !== d)
        : [...rule.monthDays, d].sort((a, b) => a - b),
    })
  }

  /** 切到「指定日期结束」时补一个默认日期 */
  function openEndDate() {
    if (!rule || rule.endDate) return
    const now = new Date()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    patch({ endDate: `${now.getFullYear()}-${m}-${d}` })
  }

  const freqOptions: { key: Freq | null; label: string }[] = [
    { key: null, label: '不重复' },
    { key: 'daily', label: '每天' },
    { key: 'weekly', label: '每周' },
    { key: 'monthly', label: '每月' },
  ]

  return (
    <div className="rounded-lg border border-white/8 bg-white/3 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[12.5px] text-zinc-300">
        <RepeatIcon className="h-4 w-4 text-sky-400" />
        重复
        {rule && <span className="text-[10.5px] text-sky-300/80">完成后自动生成下一次</span>}
      </div>

      <div className="flex flex-wrap gap-1">
        {freqOptions.map(({ key, label }) => (
          <button
            key={label}
            onClick={() => pickFreq(key)}
            className={cn(
              'rounded-md px-2 py-1 text-[11.5px] transition',
              (key === null ? !rule : rule?.freq === key)
                ? 'bg-linear-to-r from-sky-500/70 to-indigo-500/70 font-medium text-white'
                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {rule && (
        <div className="mt-2 space-y-2">
          {/* 间隔 */}
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-zinc-400">
            <span>每</span>
            <input
              type="number"
              min={1}
              max={365}
              value={rule.interval}
              onChange={(e) => patch({ interval: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
              className="w-14 rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-center text-[11.5px] text-zinc-200 outline-none scheme-dark focus:border-sky-400/60"
            />
            <span>{rule.freq === 'daily' ? '天' : rule.freq === 'weekly' ? '周' : '月'}</span>

            {/* 每周：周几多选 */}
            {rule.freq === 'weekly' && (
              <span className="flex items-center gap-1">
                {WEEKDAY_LABELS.map((label, i) => {
                  const iso = i + 1
                  const on = rule.weekdays.includes(iso)
                  return (
                    <button
                      key={iso}
                      onClick={() =>
                        patch({
                          weekdays: on
                            ? rule.weekdays.filter((d) => d !== iso)
                            : [...rule.weekdays, iso].sort(),
                        })
                      }
                      className={cn(
                        'h-6 w-6 rounded-full text-[11px] transition',
                        on
                          ? 'bg-sky-500/80 font-medium text-white'
                          : 'bg-white/5 text-zinc-500 hover:text-zinc-300',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </span>
            )}
          </div>

          {/* 每月：日号多选 */}
          {rule.freq === 'monthly' && (
            <div>
              <p className="mb-1 text-[10.5px] text-zinc-500">
                每月日期（可多选{rule.monthDays.length === 0 ? '；不选 = 每月同一天' : ''}）
              </p>
              <div className="grid grid-cols-8 gap-1">
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
                  const on = rule.monthDays.includes(d)
                  return (
                    <button
                      key={d}
                      onClick={() => toggleMonthDay(d)}
                      className={cn(
                        'h-6.5 rounded-md text-[11px] tabular-nums transition',
                        on
                          ? 'bg-sky-500/80 font-medium text-white'
                          : 'bg-white/5 text-zinc-500 hover:bg-white/10 hover:text-zinc-300',
                      )}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* 结束日期：每天 / 每周 / 每月均可无结束（长期重复） */}
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-zinc-500">
            <CalendarX2Icon className="h-3.5 w-3.5" />
            <div className="flex overflow-hidden rounded-lg border border-white/10 bg-black/20 p-0.5 text-[11px]">
              <button
                onClick={() => patch({ endDate: '' })}
                className={cn(
                  'rounded-md px-2 py-0.5 transition',
                  !rule.endDate
                    ? 'bg-linear-to-r from-sky-500/70 to-indigo-500/70 font-medium text-white'
                    : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                无结束日期（长期重复）
              </button>
              <button
                onClick={openEndDate}
                className={cn(
                  'rounded-md px-2 py-0.5 transition',
                  rule.endDate
                    ? 'bg-linear-to-r from-sky-500/70 to-indigo-500/70 font-medium text-white'
                    : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                到某天为止
              </button>
            </div>
            {rule.endDate && (
              <input
                type="date"
                value={rule.endDate}
                onChange={(e) => patch({ endDate: e.target.value })}
                className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[11.5px] text-zinc-200 outline-none scheme-dark focus:border-sky-400/60"
              />
            )}
          </div>

          <p className="text-[10.5px] leading-relaxed text-zinc-600">{describeRule(serializeRule(rule))}</p>
        </div>
      )}
    </div>
  )
}
