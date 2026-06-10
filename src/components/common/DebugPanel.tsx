/**
 * DebugPanel — 调试控制台组件
 *
 * 调试独立窗口（?debugwin=1）的核心面板，负责：
 * - 加载历史日志（get_debug_logs）
 * - 实时监听全局日志事件（debug-log）
 * - 按日志级别过滤（全部 / 信息 / 警告 / 错误）
 * - 一键清空日志
 * - 自动滚动到底部
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { Trash2Icon, BugIcon, DatabaseIcon, CheckCircle2Icon, AlertTriangleIcon, XIcon, Loader2Icon } from 'lucide-react'
import type { LogEntry, ValidationResult } from '@/lib/tauri-bridge'

/** 日志级别对应的颜色样式 */
const LEVEL_STYLES: Record<string, { text: string; badge: string }> = {
  log: { text: 'text-foreground', badge: 'bg-muted text-muted-foreground' },
  warn: { text: 'text-yellow-600 dark:text-yellow-400', badge: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400' },
  error: { text: 'text-red-600 dark:text-red-400', badge: 'bg-red-500/10 text-red-600 dark:text-red-400' },
}

type Filter = 'all' | 'log' | 'warn' | 'error'

const FILTER_OPTIONS: { label: string; value: Filter }[] = [
  { label: '全部', value: 'all' },
  { label: '信息', value: 'log' },
  { label: '警告', value: 'warn' },
  { label: '错误', value: 'error' },
]

export default function DebugPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // 数据库校验状态
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [showValidation, setShowValidation] = useState(false)

  // 启动时加载历史日志 + 监听实时日志
  useEffect(() => {
    let cancelled = false

    invoke<LogEntry[]>('get_debug_logs').then((data) => {
      if (!cancelled) setLogs(data)
    }).catch(console.error)

    let unlistenFn: (() => void) | undefined
    listen<LogEntry>('debug-log', (event) => {
      if (!cancelled) setLogs((prev) => [...prev, event.payload])
    }).then((fn) => {
      if (cancelled) fn()
      else unlistenFn = fn
    })

    return () => {
      cancelled = true
      unlistenFn?.()
    }
  }, [])

  // 日志更新时自动滚动到底部
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  // 用户手动滚动时检测是否在底部，决定是否保持自动滚动
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  // 清空日志
  const handleClear = useCallback(async () => {
    try {
      await invoke('clear_debug_logs')
      setLogs([])
    } catch (e) {
      console.error('清空日志失败', e)
    }
  }, [])

  // 校验数据库
  const handleValidate = useCallback(async () => {
    setValidating(true)
    setShowValidation(true)
    try {
      const result = await invoke<ValidationResult>('validate_database')
      console.log('[validate_database] 返回结果:', JSON.stringify(result, null, 2))
      setValidationResult(result)
    } catch (e) {
      console.error('[validate_database] 执行失败:', e)
      setValidationResult({
        ok: false,
        tablesCount: 0,
        issues: [{ table: '-', issueType: 'integrity_error', detail: `校验执行失败: ${String(e)}` }],
      })
    } finally {
      setValidating(false)
    }
  }, [])

  // 过滤后的日志
  const filteredLogs = filter === 'all' ? logs : logs.filter((l) => l.level === filter)

  const errorCount = logs.filter((l) => l.level === 'error').length
  const warnCount = logs.filter((l) => l.level === 'warn').length

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* 顶栏：标题 + 统计 + 过滤 + 清空 */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0 select-none">
        <BugIcon className="w-4.5 h-4.5 text-primary" />
        <h1 className="text-sm font-semibold">调试控制台</h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{logs.length} 条日志</span>
          {errorCount > 0 && (
            <span className="text-red-500 font-medium">{errorCount} 错误</span>
          )}
          {warnCount > 0 && (
            <span className="text-yellow-500 font-medium">{warnCount} 警告</span>
          )}
        </div>
        <div className="flex-1" />

        {/* 级别过滤按钮 */}
        <div className="flex rounded-md overflow-hidden border text-xs">
          {FILTER_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`px-2.5 py-1 transition-colors ${
                filter === value
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 清空按钮 */}
        <button
          onClick={handleClear}
          disabled={logs.length === 0}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md hover:bg-muted text-muted-foreground transition-colors disabled:opacity-40"
          title="清空全部日志"
        >
          <Trash2Icon className="w-3.5 h-3.5" />
          清空
        </button>

        {/* 校验数据库 */}
        <button
          onClick={handleValidate}
          disabled={validating}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50"
          title="校验本地 SQLite 数据库表结构和数据完整性"
        >
          {validating ? (
            <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <DatabaseIcon className="w-3.5 h-3.5" />
          )}
          校验数据库
        </button>
      </header>

      {/* 校验结果面板 */}
      {showValidation && (
        <ValidationPanel
          result={validationResult}
          loading={validating}
          onClose={() => setShowValidation(false)}
        />
      )}

      {/* 日志列表 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs leading-relaxed"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground select-none">
            <BugIcon className="w-10 h-10 opacity-20" />
            <span className="text-sm">{logs.length === 0 ? '暂无日志，等待输出…' : '当前过滤条件下无匹配日志'}</span>
          </div>
        ) : (
          filteredLogs.map((entry, i) => {
            const style = LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.log
            const source = entry.fileName
              ? `${entry.fileName}${entry.line ? `:${entry.line}` : ''}`
              : entry.file
                ? entry.file.replace(/^.*\//, '')
                : ''
            return (
              <div
                key={i}
                className={`flex gap-2 px-3 py-0.5 items-start ${i % 2 === 0 ? 'bg-muted/25' : ''}`}
              >
                <span className="text-muted-foreground/60 shrink-0 select-none">
                  {entry.timestamp}
                </span>
                <span className={`shrink-0 text-[10px] px-1 py-px rounded font-semibold select-none ${style.badge}`}>
                  {entry.level === 'log' ? 'INFO' : entry.level === 'warn' ? 'WARN' : 'ERROR'}
                </span>
                {source && (
                  <span className="shrink-0 text-[10px] text-muted-foreground/70 font-mono select-none">
                    {source}
                  </span>
                )}
                <span className={`break-all whitespace-pre-wrap ${style.text}`}>
                  {entry.message}
                </span>
              </div>
            )
          })
        )}
      </div>

      {/* 底栏：自动滚动提示 */}
      {!autoScrollRef.current && filteredLogs.length > 0 && (
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

/** 校验结果面板 */
function ValidationPanel({
  result,
  loading,
  onClose,
}: {
  result: ValidationResult | null
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
      {/* 标题栏 */}
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

      {/* 内容 */}
      <div className="px-4 pb-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2Icon className="w-4 h-4 animate-spin" />
            正在校验数据库…
          </div>
        ) : result ? (
          <div className="space-y-2">
            {/* 总体状态 */}
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

            {/* 问题列表 */}
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
