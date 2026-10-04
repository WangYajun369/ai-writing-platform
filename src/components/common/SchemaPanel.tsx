/**
 * SchemaPanel — Schema 演进工具调试面板
 *
 * 调试控制台(?debugwin=1)的子面板,展示:
 * - 当前 schema 版本 vs 应用支持的最高版本
 * - 已应用迁移历史(version / name / applied_at / checksum / down_sql)
 * - 待应用迁移(代码注册但库中未应用)
 * - PRAGMA table_info vs 代码 TABLE_SCHEMA 声明的列差异
 *
 * 与 DebugPanel 的 ValidationPanel 互补:后者做 integrity_check + 外键孤儿检测,
 * 本面板提供版本化视角与代码侧声明 diff,用于排查"代码与库结构漂移"类问题。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  DatabaseIcon,
  Loader2Icon,
  RefreshCwIcon,
  CheckCircle2Icon,
  AlertTriangleIcon,
  XIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from 'lucide-react'
import { schemaApi, type SchemaStatus, type SchemaDiff } from '@/lib/tauri-bridge'
import { errText } from '@/lib/errors'

type Tab = 'status' | 'diff'

/** 组件:Schema 演进工具调试面板 */
export default function SchemaPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('status')
  const [status, setStatus] = useState<SchemaStatus | null>(null)
  const [diff, setDiff] = useState<SchemaDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'status') {
        setStatus(await schemaApi.status())
      } else {
        setDiff(await schemaApi.diff())
      }
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggleRow = (i: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <div className="absolute inset-0 z-20 bg-background flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-card shrink-0">
        <DatabaseIcon className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Schema 演进工具</span>
        <div className="flex-1" />
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors disabled:opacity-50"
          title="刷新"
        >
          {loading ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <RefreshCwIcon className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          title="关闭 Schema 面板"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex border-b bg-card shrink-0">
        <button
          onClick={() => setTab('status')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === 'status' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          版本与迁移
        </button>
        <button
          onClick={() => setTab('diff')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === 'diff' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          结构 Diff
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-3">
        {loading && !status && !diff ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2Icon className="w-4 h-4 animate-spin" />
            加载中…
          </div>
        ) : error ? (
          <div className="text-sm text-red-600 dark:text-red-400 py-2">加载失败: {error}</div>
        ) : tab === 'status' && status ? (
          <StatusView status={status} />
        ) : tab === 'diff' && diff ? (
          <DiffView diff={diff} expandedRows={expandedRows} toggleRow={toggleRow} />
        ) : null}
      </div>
    </div>
  )
}

/** 版本与迁移视图 */
function StatusView({ status }: { status: SchemaStatus }) {
  return (
    <div className="space-y-3">
      {/* 状态总览 */}
      <div
        className={`flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-md ${
          status.upToDate
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
        }`}
      >
        {status.upToDate ? <CheckCircle2Icon className="w-4 h-4" /> : <AlertTriangleIcon className="w-4 h-4" />}
        <span>
          {status.upToDate
            ? `Schema 已是最新 — v${status.currentVersion}`
            : `Schema 待升级 — 当前 v${status.currentVersion},目标 v${status.latestVersion}`}
        </span>
      </div>

      {/* 已应用迁移 */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground mb-1.5 px-1">
          已应用迁移 ({status.appliedMigrations.length})
        </h3>
        <div className="space-y-1 border rounded-md overflow-hidden">
          {status.appliedMigrations.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/30">暂无迁移记录</div>
          ) : (
            status.appliedMigrations.map((m) => (
              <div key={m.version} className="flex items-start gap-2 text-xs px-3 py-1.5 bg-card odd:bg-muted/20">
                <span className="shrink-0 font-mono font-semibold text-primary">v{m.version}</span>
                <span className="shrink-0 text-foreground">{m.name}</span>
                <span className="flex-1" />
                <span className="shrink-0 font-mono text-muted-foreground/70 text-[10px]">{m.appliedAt}</span>
                <span
                  className="shrink-0 font-mono text-muted-foreground/50 text-[10px]"
                  title={m.downSql ? `down: ${m.downSql}` : '无 down_sql(不可回滚)'}
                >
                  {m.downSql ? '⤵' : '·'}
                </span>
              </div>
            ))
          )}
        </div>
        {/* checksum 折叠区 */}
        {status.appliedMigrations.length > 0 && (
          <details className="mt-1 text-[10px] text-muted-foreground/70">
            <summary className="cursor-pointer hover:text-foreground select-none px-1 py-0.5">
              查看 checksum
            </summary>
            <div className="space-y-0.5 px-1 py-1">
              {status.appliedMigrations.map((m) => (
                <div key={m.version} className="font-mono break-all">
                  v{m.version} {m.name}: <span className="text-muted-foreground/80">{m.checksum}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* 待应用迁移 */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground mb-1.5 px-1">
          待应用迁移 ({status.pendingMigrations.length})
        </h3>
        {status.pendingMigrations.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/30 border rounded-md">
            无待应用迁移 — 启动时 `AppDb::migrate` 会自动应用所有 v2+ 迁移
          </div>
        ) : (
          <div className="space-y-1 border rounded-md overflow-hidden">
            {status.pendingMigrations.map((m) => (
              <div key={m.version} className="flex items-center gap-2 text-xs px-3 py-1.5 bg-amber-500/5">
                <span className="shrink-0 font-mono font-semibold text-amber-600 dark:text-amber-400">v{m.version}</span>
                <span className="shrink-0 text-foreground">{m.name}</span>
                <span className="flex-1" />
                <span className="shrink-0 font-mono text-muted-foreground/50 text-[10px]">{m.checksum.slice(0, 8)}…</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 结构 diff 视图 */
function DiffView({
  diff,
  expandedRows,
  toggleRow,
}: {
  diff: SchemaDiff
  expandedRows: Set<number>
  toggleRow: (i: number) => void
}) {
  const issueStyle: Record<string, { label: string; color: string }> = {
    missing_table: { label: '缺表', color: 'text-red-500 bg-red-500/10' },
    missing_column: { label: '缺列', color: 'text-orange-500 bg-orange-500/10' },
    extra_column: { label: '多列', color: 'text-blue-500 bg-blue-500/10' },
  }

  return (
    <div className="space-y-3">
      <div
        className={`flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-md ${
          diff.ok
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
        }`}
      >
        {diff.ok ? <CheckCircle2Icon className="w-4 h-4" /> : <AlertTriangleIcon className="w-4 h-4" />}
        <span>
          {diff.ok
            ? `Schema 一致 — 声明 ${diff.declaredTablesCount} 张表,实际 ${diff.actualTablesCount} 张`
            : `Schema 有差异 — 声明 ${diff.declaredTablesCount} 张,实际 ${diff.actualTablesCount} 张,${diff.issues.length} 个问题`}
        </span>
      </div>

      {diff.issues.length > 0 && (
        <div className="space-y-1 border rounded-md overflow-hidden">
          {diff.issues.map((issue, i) => {
            const style = issueStyle[issue.issueType] ?? { label: issue.issueType, color: 'text-muted-foreground bg-muted' }
            const isExpanded = expandedRows.has(i)
            return (
              <div key={i} className={`text-xs bg-card ${i % 2 === 0 ? 'odd:bg-muted/20' : ''}`}>
                <button
                  onClick={() => toggleRow(i)}
                  className="w-full flex items-start gap-2 px-3 py-1.5 hover:bg-muted/50 transition-colors text-left"
                >
                  <span className={`shrink-0 px-1.5 py-px rounded text-[10px] font-semibold ${style.color}`}>
                    {style.label}
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground">{issue.table}</span>
                  {issue.missingColumn && (
                    <span className="shrink-0 text-foreground/80 font-mono">.{issue.missingColumn}</span>
                  )}
                  {issue.extraColumn && (
                    <span className="shrink-0 text-blue-500 font-mono">+{issue.extraColumn}</span>
                  )}
                  <span className="flex-1 text-muted-foreground truncate">{issue.detail}</span>
                  {isExpanded ? <ChevronUpIcon className="w-3 h-3 shrink-0" /> : <ChevronDownIcon className="w-3 h-3 shrink-0" />}
                </button>
                {isExpanded && (
                  <div className="px-3 pb-2 pt-0.5 text-[11px] text-muted-foreground/80 font-mono break-all">
                    {issue.detail}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="text-[10px] text-muted-foreground/60 px-1">
        提示:diff 对比 PRAGMA table_info 与代码 <code className="font-mono">db::schema::TABLE_SCHEMA</code> 声明。
        新增列未同步声明时会出现"多列"提示;启动时由 <code className="font-mono">AppDb::migrate</code> 自动补齐。
      </div>
    </div>
  )
}
