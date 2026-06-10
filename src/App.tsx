/**
 * App 根组件 — TimeWrite（智写时光）
 *
 * 包裹 Jotai Provider 提供全局 UI 状态管理，承担主题与护眼模式初始化逻辑。
 * 同时检测是否为世界观资料库/调试控制台等独立窗口，若是则仅渲染对应面板。
 * 非调试窗口启动时拦截全局 console 输出并汇入调试日志系统。
 */
import { useEffect, useRef } from 'react'
import { Provider as JotaiProvider } from 'jotai'
import { invoke } from '@tauri-apps/api/core'
import AppRouter from './router'
import { useAppStore } from './stores/appStore'
import WorldbuildingPanel from './components/worldbuilding/WorldbuildingPanel'
import SnapshotPanel from './components/editor/SnapshotPanel'
import { ChapterSummaryPanel } from './components/editor/ChapterSummaryHeader'
import AiToolboxPanel from './components/ai/AiToolboxPanel'
import DebugPanel from './components/common/DebugPanel'

const STORAGE_KEY_THEME = 'timewrite-theme'
const STORAGE_KEY_EYECARE = 'timewrite-eyecare'
const STORAGE_KEY_FONT = 'timewrite-font'
const STORAGE_KEY_FONT_SIZE = 'timewrite-font-size'

const FONT_FAMILY_MAP: Record<string, string> = {
  yahei: "'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  simhei: "SimHei, 'Noto Sans SC', sans-serif",
  simsun: "SimSun, 'Noto Serif SC', serif",
  kaiti: "KaiTi, 'Noto Serif SC', serif",
}

/**
 * 应用初始化组件
 *
 * 根据当前主题与护眼模式切换 dark / eyecare class，并持久化到 localStorage。
 * 若检测到 worldwin=1 查询参数，仅渲染世界观资料库面板（独立窗口模式）。
 */
function AppInit() {
  const { setTheme, theme, eyeCareMode, setEyeCareMode, fontFamily, setFontFamily, fontSize, setFontSize, setAppVersion } = useAppStore()

  // 标记 console 拦截是否已设置（避免 StrictMode 重复设置）
  const logInterceptorSet = useRef(false)

  // 启动时从 Tauri 获取应用版本号（来自 tauri.conf.json）
  useEffect(() => {
    let cancelled = false
    import('@tauri-apps/api/app').then(({ getVersion }) => {
      getVersion().then((v) => {
        if (!cancelled) setAppVersion(v)
      }).catch(() => {
        // 非 Tauri 环境（如浏览器开发模式）回退
        if (!cancelled) setAppVersion('0.0.0-dev')
      })
    }).catch(() => {
      if (!cancelled) setAppVersion('0.0.0-dev')
    })
    return () => { cancelled = true }
  }, [])

  // 检测是否为世界观独立窗口（URL 参数仅在挂载时确定，不会变化）
  const worldWindowInfo = (() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('worldwin') === '1') {
      return { isWorld: true, bookId: params.get('bookId') }
    }
    return { isWorld: false, bookId: null }
  })()

  // 检测是否为版本历史独立窗口
  const historyWindowInfo = (() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('historywin') === '1') {
      return {
        isHistory: true,
        chapterId: params.get('chapterId'),
        bookId: params.get('bookId'),
        chapterTitle: params.get('chapterTitle'),
      }
    }
    return { isHistory: false, chapterId: null, bookId: null, chapterTitle: null }
  })()

  // 检测是否为章节总结独立窗口
  const summaryWindowInfo = (() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('summarywin') === '1') {
      return {
        isSummary: true,
        chapterId: params.get('chapterId'),
        bookId: params.get('bookId'),
        chapterTitle: params.get('chapterTitle'),
      }
    }
    return { isSummary: false, chapterId: null, bookId: null, chapterTitle: null }
  })()

  // 检测是否为 AI 工具箱独立窗口
  const aiToolboxWindowInfo = (() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('aitoolboxwin') === '1') {
      return { isAiToolbox: true }
    }
    return { isAiToolbox: false }
  })()

  // 检测是否为调试控制台独立窗口
  const debugWindowInfo = (() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('debugwin') === '1') {
      return { isDebug: true }
    }
    return { isDebug: false }
  })()

  // 非调试窗口：拦截全局 console 输出 → 汇入调试日志系统
  useEffect(() => {
    if (debugWindowInfo.isDebug || logInterceptorSet.current) return
    logInterceptorSet.current = true

    const origLog = console.log.bind(console)
    const origWarn = console.warn.bind(console)
    const origError = console.error.bind(console)

    // 批处理缓冲区：减少 invoke 调用频率，避免 StrictMode 下回调 ID 竞态
    type PendingLog = { level: string; message: string; file?: string; fileName?: string; line?: number }
    const buffer: PendingLog[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const FLUSH_INTERVAL = 500

    /** 从 Error.stack 提取调用者的文件路径、文件名和行号 */
    function extractCallerInfo(stack: string): { file?: string; fileName?: string; line?: number } {
      if (!stack) return {}
      // 跳过拦截器自身的帧（App.tsx 中的 enqueueLog / extractCallerInfo / console.log 等）
      const lines = stack.split('\n')
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i]
        if (line.includes('/App.tsx') || line.includes('/App.tsx?')) continue
        // 匹配: at ... (http://host:port/path/to/file.ext:line:col) 或 at path:line:col
        const match = line.match(/(?:https?:\/\/[^)]+?)?\/?([^/\s)]+\.\w+):(\d+):(\d+)/)
        if (match) {
          const fullPath = match[0].replace(/^https?:\/\/[^/]+\//, '') // 去掉协议+host
          const cleanPath = fullPath.replace(/\?[^:]*/, '')             // 去掉 URL query
          const fileName = match[1]                                     // 文件名
          const lineNum = parseInt(match[2], 10)                        // 行号
          return { file: cleanPath, fileName, line: lineNum }
        }
      }
      return {}
    }

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
      invoke('log_message', { entries }).catch(() => {})
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

    console.log = (...args: unknown[]) => {
      origLog(...args)
      enqueueLog('log', args)
    }
    console.warn = (...args: unknown[]) => {
      origWarn(...args)
      enqueueLog('warn', args)
    }
    console.error = (...args: unknown[]) => {
      origError(...args)
      enqueueLog('error', args)
    }

    return () => {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
      logInterceptorSet.current = false
      if (flushTimer !== null) clearTimeout(flushTimer)
      flushLogs() // 组件卸载时立即清空缓冲区
    }
  }, [debugWindowInfo.isDebug])

  // 启动时从 localStorage 恢复偏好
  useEffect(() => {
    const savedTheme = localStorage.getItem(STORAGE_KEY_THEME)
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      setTheme(savedTheme)
    }
    const savedEyeCare = localStorage.getItem(STORAGE_KEY_EYECARE)
    if (savedEyeCare === 'off' || savedEyeCare === 'warm' || savedEyeCare === 'green') {
      setEyeCareMode(savedEyeCare)
    }
    const savedFont = localStorage.getItem(STORAGE_KEY_FONT)
    if (savedFont && savedFont in FONT_FAMILY_MAP) {
      setFontFamily(savedFont as 'simhei' | 'simsun' | 'kaiti' | 'yahei')
    }
    const savedFontSize = localStorage.getItem(STORAGE_KEY_FONT_SIZE)
    if (savedFontSize) {
      const size = parseInt(savedFontSize, 10)
      if (size >= 12 && size <= 24) {
        setFontSize(size)
      }
    }
  }, [])

  // 主题 + 护眼模式应用
  useEffect(() => {
    const root = document.documentElement

    // 移除所有护眼模式 class
    root.classList.remove('eyecare-warm', 'eyecare-green')

    // 主题
    if (theme === 'dark') {
      root.classList.add('dark')
    } else if (theme === 'light') {
      root.classList.remove('dark')
    } else {
      // system
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) {
        root.classList.add('dark')
      } else {
        root.classList.remove('dark')
      }
    }

    // 护眼模式
    if (eyeCareMode === 'warm') {
      root.classList.add('eyecare-warm')
    } else if (eyeCareMode === 'green') {
      root.classList.add('eyecare-green')
    }

    // 持久化
    localStorage.setItem(STORAGE_KEY_THEME, theme)
    localStorage.setItem(STORAGE_KEY_EYECARE, eyeCareMode)
  }, [theme, eyeCareMode])

  // 字体应用
  useEffect(() => {
    document.documentElement.style.setProperty('--font-editor', FONT_FAMILY_MAP[fontFamily] ?? FONT_FAMILY_MAP.yahei)
    localStorage.setItem(STORAGE_KEY_FONT, fontFamily)
  }, [fontFamily])

  // 字体大小应用
  useEffect(() => {
    document.documentElement.style.setProperty('--font-editor-size', `${fontSize}px`)
    localStorage.setItem(STORAGE_KEY_FONT_SIZE, String(fontSize))
  }, [fontSize])

  // 版本历史独立窗口模式
  if (historyWindowInfo.isHistory && historyWindowInfo.chapterId && historyWindowInfo.bookId) {
    return (
      <div
        className="h-screen flex flex-col overflow-hidden bg-background"
        onContextMenu={(e) => e.preventDefault()}
      >
        <SnapshotPanel
          chapterId={historyWindowInfo.chapterId}
          bookId={historyWindowInfo.bookId}
          chapterTitle={historyWindowInfo.chapterTitle ?? undefined}
        />
      </div>
    )
  }

  // 章节总结独立窗口模式
  if (summaryWindowInfo.isSummary && summaryWindowInfo.chapterId && summaryWindowInfo.bookId) {
    return (
      <div
        className="h-screen flex flex-col overflow-hidden bg-background"
        onContextMenu={(e) => e.preventDefault()}
      >
        <ChapterSummaryPanel
          chapterId={summaryWindowInfo.chapterId}
          bookId={summaryWindowInfo.bookId}
          chapterTitle={summaryWindowInfo.chapterTitle ?? undefined}
        />
      </div>
    )
  }

  // AI 工具箱独立窗口模式
  if (aiToolboxWindowInfo.isAiToolbox) {
    return (
      <div
        className="h-screen flex flex-col overflow-hidden bg-background"
        onContextMenu={(e) => e.preventDefault()}
      >
        <AiToolboxPanel initialToolId="outline-generation" />
      </div>
    )
  }

  // 调试控制台独立窗口模式
  if (debugWindowInfo.isDebug) {
    return (
      <div
        className="h-screen flex flex-col overflow-hidden bg-background"
        onContextMenu={(e) => e.preventDefault()}
      >
        <DebugPanel />
      </div>
    )
  }

  // 世界观独立窗口模式
  if (worldWindowInfo.isWorld && worldWindowInfo.bookId) {
    const params = new URLSearchParams(window.location.search)
    const initialTab = (params.get('tab') === 'outline' ? 'outline' : undefined) as 'outline' | undefined
    return (
      <div
        className="h-screen flex flex-col overflow-hidden bg-background"
        onContextMenu={(e) => e.preventDefault()}
      >
        <WorldbuildingPanel bookId={worldWindowInfo.bookId} initialTab={initialTab} />
      </div>
    )
  }

  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-background"
      onContextMenu={(e) => e.preventDefault()}
    >
      <AppRouter />
    </div>
  )
}

export default function App() {
  return (
    <JotaiProvider>
      <AppInit />
    </JotaiProvider>
  )
}
