import { useEffect, useRef } from 'react'
import { debugApi } from '@/lib/tauri-bridge'

type PendingLog = { level: string; message: string; file?: string; fileName?: string; line?: number }

const FLUSH_INTERVAL = 500

/** 从 Error.stack 提取调用者的文件路径、文件名和行号 */
function extractCallerInfo(stack: string): { file?: string; fileName?: string; line?: number } {
  if (!stack) return {}
  const lines = stack.split('\n')
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('/App.tsx') || line.includes('/App.tsx?')) continue
    const match = line.match(/(?:https?:\/\/[^)]+?)?\/?([^/\s)]+\.\w+):(\d+):(\d+)/)
    if (match) {
      const fullPath = match[0].replace(/^https?:\/\/[^/]+\//, '')
      const cleanPath = fullPath.replace(/\?[^:]*/, '')
      const fileName = match[1]
      const lineNum = parseInt(match[2], 10)
      return { file: cleanPath, fileName, line: lineNum }
    }
  }
  return {}
}

/**
 * 非调试窗口：拦截全局 console 输出 → 批处理汇入调试日志系统
 * @param disabled 是否禁用拦截器（调试窗口本身传 true）
 */
export function useConsoleInterceptor(disabled: boolean) {
  const logInterceptorSet = useRef(false)

  useEffect(() => {
    if (disabled || logInterceptorSet.current) return
    logInterceptorSet.current = true

    const origLog = console.log.bind(console)
    const origWarn = console.warn.bind(console)
    const origError = console.error.bind(console)

    const buffer: PendingLog[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    function flushLogs() {
      if (buffer.length === 0) return
      const batch = buffer.splice(0)
      const entries = batch.map((l) => ({
        level: l.level,
        message: l.message,
        file: l.file ?? null,
        fileName: l.fileName ?? null,
        line: l.line ?? null,
      }))
      debugApi.logMessage(entries).catch(() => {})
    }

    function enqueueLog(level: string, args: unknown[]) {
      const message = args
        .map((a) => {
          if (a === null || a === undefined) return String(a)
          if (a instanceof Error) return a.stack || a.message
          if (typeof a === 'string') return a
          if (typeof a === 'object') {
            try { return JSON.stringify(a, null, 2) } catch { return String(a) }
          }
          return String(a)
        })
        .filter(Boolean)
        .join(' ')

      const { file, fileName, line } = extractCallerInfo(new Error().stack ?? '')
      buffer.push({ level, message, file, fileName, line })
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          flushLogs()
        }, FLUSH_INTERVAL)
      }
    }

    console.log = (...args: unknown[]) => { origLog(...args); enqueueLog('log', args) }
    console.warn = (...args: unknown[]) => { origWarn(...args); enqueueLog('warn', args) }
    console.error = (...args: unknown[]) => { origError(...args); enqueueLog('error', args) }

    return () => {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
      logInterceptorSet.current = false
      if (flushTimer !== null) clearTimeout(flushTimer)
      flushLogs()
    }
  }, [disabled])
}
