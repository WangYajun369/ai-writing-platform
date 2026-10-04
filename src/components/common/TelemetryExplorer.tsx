/**
 * TelemetryExplorer — 统一可观测性事件查看器
 *
 * 整合 4+1 套通道:SQL / Agent / IO / Error / System,替代单一 LogEntry 视图。
 *
 * - 启动加载内存缓冲(`telemetryApi.list({ fromBuffer: true })`)
 * - 实时监听 `telemetry-event` 事件(主通道)+ `debug-log` 别名(向后兼容)
 * - 按 kind tab 聚合 + 按 level 过滤
 * - payload 详情展开(JSON)
 * - 一键清空 + 自动滚动
 *
 * v1.9 可观测性体系收敛:替代原 DebugPanel 的纯 LogEntry 列表视图。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  Trash2Icon,
  DatabaseIcon,
  CheckCircle2Icon,
  AlertTriangleIcon,
  XIcon,
  Loader2Icon,
  BugIcon,
  CpuIcon,
  LockIcon,
  AlertOctagonIcon,
  ActivityIcon,
} from 'lucide-react'
import { telemetryApi } from '@/lib/tauri-bridge'
import type { TelemetryEvent, TelemetryKind } from '@/lib/tauri-bridge'

/** kind → { label, icon, color } */
const KIND_META: Record<TelemetryKind | 'all', { label: string; icon: typeof BugIcon; color: string }> = {
  all: { label: '全部', icon: ActivityIcon, color: 'text-foreground' },
  sql: { label: 'SQL', icon: DatabaseIcon, color: 'text-blue-500' },
  agent: { label: 'Agent', icon: CpuIcon, color: 'text-purple-500' },
  io: { label: 'IO', icon: LockIcon, color: 'text-amber-500' },
  error: { label: '错误', icon: AlertOctagonIcon, color: 'text-red-500' },
  system: { label: '系统', icon: BugIcon, color: 'text-muted-foreground' },
}

const KIND_TABS: (TelemetryKind | 'all')[] = ['all', 'sql', 'agent', 'io', 'error', 'system']

const LEVEL_STYLES: Record<string, { text: string; badge: string }> = {
  info: { text: 'text-foreground', badge: 'bg-muted text-muted-foreground' },
  warn: { text: 'text-yellow-600 dark:text-yellow-400', badge: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400' },
  error: { text: 'text-red-600 dark:text-red-400', badge: 'bg-red-500/10 text-red-600 dark:text-red-400' },
}

type KindFilter = TelemetryKind | 'all'
type LevelFilter = 'all' | 'info' | 'warn' | 'error'

const LEVEL_OPTIONS: { label: string; value: LevelFilter }[] = [
  { label: '全部', value: 'all' },
  { label: '信息', value: 'info' },
  { label: '警告', value: 'warn' },
  { label: '错误', value: 'error' },
]

export default function TelemetryExplorer() {
  const [events, setEvents] = useState<TelemetryEvent[]>([])
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [broadcasting, setBroadcasting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // 启动加载 + 实时监听
  useEffect(() => {
    let cancelled = false
    // 1. 加载内存缓冲
    telemetryApi.list({ fromBuffer: true }).then((data) => {
      if (!cancelled) setEvents(data)
    }).catch(console.error)
    // 2. 查询广播状态
    telemetryApi.isBroadcasting().then((b) => {
      if (!cancelled) setBroadcasting(b)
    }).catch(() => {})
    // 3. 启用广播(调试窗口打开时)
    telemetryApi.enableBroadcast().catch(() => {})

    // 4. 实时监听 telemetry-event(主通道)
    let unlistenTelemetry: (() => void) | undefined
    listen<TelemetryEvent>('telemetry-event', (e) => {
      if (!cancelled) setEvents((prev) => [...prev, e.payload])
    }).then((fn) => {
      if (cancelled) fn()
      else unlistenTelemetry = fn
    })

    // 5. 兼容:监听旧 debug-log 事件(SQL 审计别名,避免重复推 telemetry-event)
    //    注:Rust 端 bus::emit_sql 同时 emit telemetry-event 与 debug-log,
    //    所以前端只监听 telemetry-event 即可;这里监听 debug-log 仅为过渡期
    //    兼容未迁移组件上报的纯 LogEntry(不携带 kind 字段)。
    let unlistenLegacy: (() => void) | undefined
    listen<TelemetryEvent & { level: string; message: string; timestamp: string }>('debug-log', (e) => {
      // 仅有 kind 字段缺失时才作为 legacy 接收(SQL 别名已在 telemetry-event 收到)
      const payload = e.payload as Partial<TelemetryEvent>
      if (payload.kind) return // 已通过 telemetry-event 收到,跳过
      if (!cancelled) {
        setEvents((prev) => [
          ...prev,
          {
            kind: 'system',
            level: payload.level ?? 'info',
            timestamp: payload.timestamp ?? '',
            message: payload.message ?? '',
            file: payload.file,
            fileName: payload.fileName,
            line: payload.line,
          },
        ])
      }
    }).then((fn) => {
      if (cancelled) fn()
      else unlistenLegacy = fn
    })

    return () => {
      cancelled = true
      unlistenTelemetry?.()
      unlistenLegacy?.()
      // 关闭窗口时禁用广播
      telemetryApi.disableBroadcast().catch(() => {})
    }
  }, [])

  // 日志更新时自动滚动
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const handleClear = useCallback(async () => {
    try {
      await telemetryApi.clear()
      setEvents([])
    } catch (e) {
      console.error('清空 telemetry 事件失败', e)
    }
  }, [])

  const toggleExpand = useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  // 过滤逻辑
  const filtered = events.filter((e) => {
    if (kindFilter !== 'all' && e.kind !== kindFilter) return false
    if (levelFilter !== 'all' && e.level !== levelFilter) return false
    return true
  })

  const counts = {
    all: events.length,
    sql: events.filter((e) => e.kind === 'sql').length,
    agent: events.filter((e) => e.kind === 'agent').length,
    io: events.filter((e) => e.kind === 'io').length,
    error: events.filter((e) => e.kind === 'error').length,
    system: events.filter((e) => e.kind === 'system').length,
  }

  const errorCount = counts.error
  const warnCount = events.filter((e) => e.level === 'warn').length

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* 顶栏:标题 + 统计 + 广播指示 + 清空 */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0 select-none">
        <BugIcon className="w-4.5 h-4.5 text-primary" />
        <h1 className="text-sm font-semibold">调试控制台</h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{events.length} 事件</span>
          {errorCount > 0 && (
            <span className="text-red-500 font-medium">{errorCount} 错误</span>
          )}
          {warnCount > 0 && (
            <span className="text-yellow-500 font-medium">{warnCount} 警告</span>
          )}
        </div>
        {/* 广播状态 */}
        <div className="flex items-center gap-1 text-xs">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              broadcasting ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/40'
            }`}
            title={broadcasting ? '事件总线广播中' : '广播已关闭'}
          />
          <span className="text-muted-foreground">{broadcasting ? '实时' : '关闭'}</span>
        </div>
        <div className="flex-1" />

        {/* 级别过滤 */}
        <div className="flex rounded-md overflow-hidden border text-xs">
          {LEVEL_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setLevelFilter(value)}
              className={`px-2.5 py-1 transition-colors ${
                levelFilter === value
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 清空 */}
        <button
          onClick={handleClear}
          disabled={events.length === 0}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md hover:bg-muted text-muted-foreground transition-colors disabled:opacity-40"
          title="清空全部事件"
        >
          <Trash2Icon className="w-3.5 h-3.5" />
          清空
        </button>
      </header>

      {/* Kind Tab */}
      <div className="flex items-center gap-1 px-4 py-1.5 border-b bg-muted/30 shrink-0 overflow-x-auto">
        {KIND_TABS.map((kind) => {
          const meta = KIND_META[kind]
          const count = counts[kind as keyof typeof counts]
          const active = kindFilter === kind
          const Icon = meta.icon
          return (
            <button
              key={kind}
              onClick={() => setKindFilter(kind)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted text-muted-foreground'
              }`}
            >
              <Icon className={`w-3 h-3 ${active ? '' : meta.color}`} />
              {meta.label}
              {count > 0 && (
                <span className={`px-1.5 py-px rounded text-[10px] ${active ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* 事件列表 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs leading-relaxed"
      >
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground select-none">
            <BugIcon className="w-10 h-10 opacity-20" />
            <span className="text-sm">
              {events.length === 0 ? '暂无事件，等待输出…' : '当前过滤条件下无匹配事件'}
            </span>
          </div>
        ) : (
          filtered.map((entry, i) => {
            const kindMeta = KIND_META[entry.kind] ?? KIND_META.system
            const levelStyle = LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.info
            const source =
              entry.fileName
                ? `${entry.fileName}${entry.line ? `:${entry.line}` : ''}`
                : entry.file
                ? entry.file.replace(/^.*\//, '')
                : entry.source ?? ''
            const KindIcon = kindMeta.icon
            const isExpanded = expanded.has(i)
            const hasPayload = entry.payload != null
            return (
              <div
                key={i}
                className={`flex flex-col px-3 py-0.5 ${i % 2 === 0 ? 'bg-muted/25' : ''}`}
              >
                <div className="flex gap-2 items-start">
                  <span className="text-muted-foreground/60 shrink-0 select-none">
                    {entry.timestamp}
                  </span>
                  <KindIcon className={`w-3 h-3 shrink-0 mt-0.5 ${kindMeta.color}`} />
                  <span
                    className={`shrink-0 text-[10px] px-1 py-px rounded font-semibold select-none ${levelStyle.badge}`}
                  >
                    {entry.level === 'log' ? 'INFO' : (entry.level?.toUpperCase() ?? 'INFO')}
                  </span>
                  <span className={`shrink-0 text-[10px] px-1 py-px rounded font-medium select-none bg-muted ${kindMeta.color}`}>
                    {kindMeta.label}
                  </span>
                  {source && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/70 font-mono select-none">
                      {source}
                    </span>
                  )}
                  <span className={`break-all whitespace-pre-wrap flex-1 ${levelStyle.text}`}>
                    {entry.message}
                  </span>
                  {hasPayload && (
                    <button
                      onClick={() => toggleExpand(i)}
                      className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                      title={isExpanded ? '收起' : '展开 payload'}
                    >
                      {isExpanded ? '▾' : '▸'}
                    </button>
                  )}
                </div>
                {isExpanded && hasPayload && (
                  <pre className="ml-12 mt-0.5 mb-1 p-1.5 text-[10px] bg-muted/50 rounded overflow-x-auto text-muted-foreground">
                    {JSON.stringify(entry.payload, null, 2)}
                  </pre>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 底栏:暂停自动滚动提示 */}
      {!autoScrollRef.current && filtered.length > 0 && (
        <footer className="border-t px-4 py-1.5 text-xs text-muted-foreground bg-card shrink-0 flex items-center gap-2">
          <span>已暂停自动滚动</span>
          <button
            onClick={() => {
              autoScrollRef.current = true
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
            }}
            className="text-primary hover:underline"
          >
            回到底部
          </button>
        </footer>
      )}
    </div>
  )
}

/** 占位:保留以兼容原 DebugPanel 的数据库校验功能(后续可挪到 TelemetryExplorer 的工具栏) */
export function TelemetryPlaceholder() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
      <Loader2Icon className="w-4 h-4 animate-spin" />
      正在加载 telemetry…
    </div>
  )
}

/** 校验结果面板(沿用原 DebugPanel 结构,后续可独立为 TelemetryExplorer 的工具栏子区) */
export function ValidationPanel({
  result,
  loading,
  onClose,
}: {
  result: { ok: boolean; tablesCount: number; issues: { table: string; column?: string; issueType: string; detail: string }[] } | null
  loading: boolean
  onClose: () => void
}) {
  const issueTypeLabel: Record<string, { label: string; color: string }> = {
    missing_table: { label: '缺表', color: 'text-red-500 bg-red-500/10' },
    missing_column: { label: '缺列', color: 'text-orange-500 bg-orange-500/10' },
    integrity_error: { label: '完整性', color: 'text-red-500 bg-red-500/10' },
    orphan_record: { label: '孤儿记录', color: 'text-yellow-500 bg-yellow-500/10' },
  }

  return (
    <div className="border-b bg-card shrink-0">
      <div className="flex items-center gap-2 px-4 py-2 select-none">
        <DatabaseIcon className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">数据库校验</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          title="关闭校验面板"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-4 pb-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2Icon className="w-4 h-4 animate-spin" />
            正在校验数据库…
          </div>
        ) : result ? (
          <div className="space-y-2">
            <div
              className={`flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-md ${
                result.ok
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-red-500/10 text-red-600 dark:text-red-400'
              }`}
            >
              {result.ok ? (
                <CheckCircle2Icon className="w-4 h-4" />
              ) : (
                <AlertTriangleIcon className="w-4 h-4" />
              )}
              {result.ok
                ? `校验通过 — 共 ${result.tablesCount} 张表，数据完整`
                : `校验未通过 — ${result.tablesCount} 张表，${result.issues.length} 个问题`}
            </div>
            {result.issues.length > 0 && (
              <div className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2 bg-muted/30">
                {result.issues.map((issue, i) => {
                  const style = issueTypeLabel[issue.issueType] ?? { label: issue.issueType, color: 'text-muted-foreground bg-muted' }
                  return (
                    <div key={i} className="flex items-start gap-2 text-xs py-1">
                      <span className={`shrink-0 px-1.5 py-px rounded text-[10px] font-semibold ${style.color}`}>
                        {style.label}
                      </span>
                      <span className="font-mono text-muted-foreground">{issue.table}</span>
                      {issue.column && (
                        <span className="text-foreground/80 font-mono">.{issue.column}</span>
                      )}
                      <span className="text-muted-foreground">— {issue.detail}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground py-2">暂无校验结果</div>
        )}
      </div>
    </div>
  )
}
