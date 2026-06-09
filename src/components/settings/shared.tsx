/**
 * 设置页共享 UI 组件 —— API Key 字段、连接状态、选项按钮组
 */
import { useState, useRef, useEffect } from 'react'
import { CircleCheckIcon, CircleAlertIcon, RefreshCwIcon } from 'lucide-react'

// ──────────────── API Key 字段（点击编辑 / 掩码显示） ────────────────

interface ApiKeyFieldProps {
  label: string
  hint?: string
  value: string | undefined
  placeholder: string
  onChange: (value: string) => void
}

/** 掩码显示：前4后4，中间用 * 填充，短 key 全掩 */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '*'.repeat(key.length)
  return key.slice(0, 4) + '****' + key.slice(-4)
}

export function ApiKeyField({ label, hint, value, placeholder, onChange }: ApiKeyFieldProps) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {hint && <p className="text-xs text-muted-foreground mb-1">{hint}</p>}
      {editing ? (
        <input
          ref={inputRef}
          type="password"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false) }}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder={placeholder}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm text-left font-mono flex items-center justify-between group hover:bg-muted/80 transition-colors"
          title="点击编辑 API Key"
        >
          <span className={value ? 'text-foreground tracking-wider' : 'text-muted-foreground'}>
            {value ? maskApiKey(value) : placeholder}
          </span>
          <span className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors text-xs">
            ✎
          </span>
        </button>
      )}
    </div>
  )
}

// ──────────────── 连接测试状态徽标 ────────────────

export type ConnectionStatus = 'idle' | 'testing' | 'connected' | 'error'

interface ConnectionStatusBadgeProps {
  status: ConnectionStatus
  detail: string
}

export function ConnectionStatusBadge({ status, detail }: ConnectionStatusBadgeProps) {
  if (status === 'idle') return null

  const styles: Record<Exclude<ConnectionStatus, 'idle'>, string> = {
    connected: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400',
    error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400',
    testing: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
  }

  const icons: Record<Exclude<ConnectionStatus, 'idle'>, React.ReactNode> = {
    connected: <CircleCheckIcon className="w-4 h-4 mt-0.5 shrink-0" />,
    error: <CircleAlertIcon className="w-4 h-4 mt-0.5 shrink-0" />,
    testing: <RefreshCwIcon className="w-4 h-4 mt-0.5 shrink-0 animate-spin" />,
  }

  return (
    <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${styles[status]}`}>
      {icons[status]}
      <p className="whitespace-pre-wrap text-xs">{detail}</p>
    </div>
  )
}

// ──────────────── 选项按钮组 ────────────────

export interface OptionItem {
  value: string
  label: string
  desc?: string
  color?: string
  icon?: string
}

interface OptionGroupProps {
  options: readonly OptionItem[]
  value: string
  onChange: (value: string) => void
}

export function OptionGroup({ options, value, onChange }: OptionGroupProps) {
  return (
    <div className="flex flex-wrap gap-3">
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex flex-col items-start gap-0.5 px-4 py-2 rounded-lg text-sm transition-colors ${
              active ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
            }`}
          >
            <span className="flex items-center gap-1.5 font-medium">
              {opt.icon && <span>{opt.icon}</span>}
              {opt.color && (
                <span className={`inline-block w-4 h-4 rounded border border-border ${opt.color}`} />
              )}
              {opt.label}
            </span>
            {opt.desc && <span className="text-xs opacity-70">{opt.desc}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ──────────────── Toggle 开关 ────────────────

interface ToggleProps {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function Toggle({ enabled, onChange }: ToggleProps) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${
        enabled ? 'bg-primary' : 'bg-muted-foreground/25'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition-transform ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}
