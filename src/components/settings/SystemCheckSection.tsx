/**
 * 系统检查区块 —— 检测运行环境（Python/Node/Rust 版本、系统信息、安装路径）
 */
import { useState, useEffect } from 'react'
import { RefreshCwIcon, CheckCircleIcon, AlertTriangleIcon, XCircleIcon } from 'lucide-react'

interface CheckItem {
  name: string
  value: string
  status: string // "ok" | "warning" | "error"
  detail?: string | null
}

interface SystemCheckResult {
  items: CheckItem[]
  ok: boolean
}

type LoadingState = 'idle' | 'loading' | 'done' | 'error'

const statusConfig: Record<string, { icon: React.FC<{ className?: string }>; color: string; bg: string }> = {
  ok: { icon: CheckCircleIcon, color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-900/20' },
  warning: { icon: AlertTriangleIcon, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20' },
  error: { icon: XCircleIcon, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20' },
}

export function SystemCheckSection() {
  const [state, setState] = useState<LoadingState>('idle')
  const [result, setResult] = useState<SystemCheckResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  // 进入页面自动检查
  useEffect(() => {
    runCheck()
  }, [])

  const runCheck = async () => {
    setState('loading')
    setErrorMsg('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const data = await invoke<SystemCheckResult>('system_check')
      setResult(data)
      setState('done')
    } catch (err) {
      console.error('[SystemCheck] 检查失败:', err)
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">系统检查</h2>
          <p className="text-xs text-muted-foreground mt-0.5">检测运行环境中的工具链版本与安装信息</p>
        </div>
        <button
          onClick={runCheck}
          disabled={state === 'loading'}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCwIcon className={`w-4 h-4 ${state === 'loading' ? 'animate-spin' : ''}`} />
          {state === 'loading' ? '检查中...' : '重新检查'}
        </button>
      </div>

      {/* 整体状态 */}
      {state === 'done' && result && (
        <div
          className={`flex items-center gap-3 p-4 rounded-xl ${
            result.ok
              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
              : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
          }`}
        >
          {result.ok ? (
            <CheckCircleIcon className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
          ) : (
            <AlertTriangleIcon className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          <div>
            <p className="text-sm font-medium">
              {result.ok ? '所有检查项均正常' : '部分检查项需要关注'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              共 {result.items.length} 项检查，{result.items.filter((i) => i.status === 'ok').length} 项通过
              {result.items.filter((i) => i.status === 'warning').length > 0 &&
                `，${result.items.filter((i) => i.status === 'warning').length} 项警告`}
              {result.items.filter((i) => i.status === 'error').length > 0 &&
                `，${result.items.filter((i) => i.status === 'error').length} 项异常`}
            </p>
          </div>
        </div>
      )}

      {/* 错误状态 */}
      {state === 'error' && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <XCircleIcon className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-700 dark:text-red-400">检查执行失败</p>
            <p className="text-xs text-muted-foreground mt-0.5">{errorMsg}</p>
          </div>
        </div>
      )}

      {/* 详细检查列表 */}
      {state === 'done' && result && (
        <div className="space-y-3">
          {result.items.map((item, idx) => {
            const config = statusConfig[item.status] ?? statusConfig.error
            const Icon = config.icon
            return (
              <div
                key={idx}
                className={`p-4 rounded-xl border transition-colors ${
                  item.status === 'error'
                    ? 'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10'
                    : item.status === 'warning'
                      ? 'border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10'
                      : 'border-border bg-card'
                }`}
              >
                <div className="flex items-start gap-3">
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${config.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{item.name}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          item.status === 'ok'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : item.status === 'warning'
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        }`}
                      >
                        {item.status === 'ok' ? '正常' : item.status === 'warning' ? '警告' : '异常'}
                      </span>
                    </div>
                    <p className="text-sm font-mono mt-1 break-all">{item.value}</p>
                    {item.detail && (
                      <p className="text-xs text-muted-foreground mt-1.5 whitespace-pre-wrap">
                        {item.detail}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 加载占位 */}
      {state === 'loading' && (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="p-4 rounded-xl border border-border bg-card animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-24 bg-muted rounded" />
                  <div className="h-3 w-64 bg-muted rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部说明 */}
      <div className="p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground">
        <p>
          系统检查会检测本地开发环境中 Python、Node.js、Rust
          等工具链的安装状态与版本信息，帮助你排查运行问题。
        </p>
      </div>
    </div>
  )
}
