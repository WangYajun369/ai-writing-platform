/**
 * useUpdateCheck — 更新检查统一入口
 *
 * 链路（与 VersionSection / 启动静默检查共用）：
 * 1. 优先 Tauri updater 插件：可应用内静默下载安装（需 capabilities 授予 updater:default）
 * 2. 插件不可用 → GitHub Releases API 兜底：仅提示并引导跳转下载页
 *
 * 关键行为：
 * - `skip()` 记录「跳过此版本」（localStorage），后续静默检查不再打扰；
 *   出现更新的版本时会重新提示；用户手动检查时忽略跳过记录（clearSkipped）。
 * - `install()` 输出下载进度（0-100），完成安装后给出「重启生效」提示。
 * - 启动静默检查不会覆盖用户主动检查的结果文案（见 quiet 分支）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import { useAiStore } from '@/stores/aiStore'
import { availableUpdateAtom, updateCheckedAtom, type AvailableUpdate } from '@/stores/updateAtoms'
import { checkViaGithub, openExternalUrl } from '@/lib/updateApi'
import { clearSkippedVersion, setSkippedVersion, shouldNotifyUpdate } from '@/lib/version'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'error'

export interface UseUpdateCheckOptions {
  /** 静默模式：不设置 loading 文案与错误提示（供启动检查使用） */
  quiet?: boolean
}

export interface UseUpdateCheckResult {
  status: UpdateStatus
  message: string
  /** 已发现的可用更新（含版本号 / 说明 / 来源） */
  update: AvailableUpdate | null
  /** 下载进度 0-100；非下载中为 null */
  progress: number | null
  /** 是否正在下载安装 */
  installing: boolean
  /** 安装完成，等待用户重启 */
  installed: boolean
  check: (opts?: UseUpdateCheckOptions) => Promise<void>
  /** 跳过当前发现的版本 */
  skip: () => void
  /** 下载并安装（Tauri updater 路径）/ 跳转下载页（GitHub 兜底路径） */
  install: () => Promise<void>
}

/** 解析 Tauri updater 下载事件为进度百分比 */
function readProgressPercent(event: unknown): number | null {
  const total = Number((event as { data?: { contentLength?: number } })?.data?.contentLength ?? 0)
  const chunk = Number((event as { data?: { chunkLength?: number } })?.data?.chunkLength ?? 0)
  if (!total || !chunk) return null
  return Math.min(100, Math.round((chunk / total) * 100))
}

export function useUpdateCheck(): UseUpdateCheckResult {
  const appVersion = useAiStore((s) => s.appVersion)
  const setAvailableUpdate = useSetAtom(availableUpdateAtom)
  const setUpdateChecked = useSetAtom(updateCheckedAtom)

  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [message, setMessage] = useState('')
  const [update, setUpdate] = useState<AvailableUpdate | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  /** 当前检查是否为静默（启动）模式：决定文案与错误是否上抛到 UI */
  const quietRef = useRef(false)

  const check = useCallback(
    async (opts: UseUpdateCheckOptions = {}) => {
      const quiet = opts.quiet ?? false
      quietRef.current = quiet

      if (!quiet) {
        setStatus('checking')
        setMessage('')
      }
      setInstalled(false)

      try {
        // 1) Tauri updater 插件（应用内可静默安装）
        const { check: checkUpdater } = await import('@tauri-apps/plugin-updater')
        const found = await checkUpdater()

        if (found) {
          const info: AvailableUpdate = {
            version: found.version,
            currentVersion: found.currentVersion ?? appVersion,
            body: found.body ?? '',
            url: '',
            source: 'updater',
          }
          setUpdate(info)
          setAvailableUpdate(info)
          setStatus('available')
          setMessage(
            `发现新版本 ${info.version}，当前版本 ${info.currentVersion}。\n${info.body}`.trim(),
          )
        } else {
          setUpdate(null)
          setAvailableUpdate(null)
          if (!quiet) {
            setStatus('up-to-date')
            setMessage('已是最新版本')
          }
        }
      } catch (updaterErr) {
        // 2) 应用内更新器不可用（Web 预览 / 权限缺失 / 签名不匹配）→ GitHub API 兜底
        if (!quiet) {
          console.warn('[Updater] 应用内更新器不可用，回退 GitHub API:', updaterErr)
        }
        try {
          const release = await checkViaGithub(appVersion)
          if (release) {
            // 静默检查时尊重「跳过此版本」
            if (quiet && !shouldNotifyUpdate(release.version, appVersion)) {
              setUpdateChecked(true)
              return
            }
            const info: AvailableUpdate = { ...release, currentVersion: appVersion, source: 'github' }
            setUpdate(info)
            setAvailableUpdate(info)
            setStatus('available')
            setMessage(
              `发现新版本 ${release.version}，当前版本 v${appVersion}。\n请前往 GitHub 下载安装。\n\n${release.body}`.trim(),
            )
          } else {
            setUpdate(null)
            setAvailableUpdate(null)
            if (!quiet) {
              setStatus('up-to-date')
              setMessage('已是最新版本（通过 GitHub 检查）')
            }
          }
        } catch (githubErr) {
          const msg = githubErr instanceof Error ? githubErr.message : String(githubErr)
          if (quiet) {
            // 静默检查失败不打扰用户（无网络/未登录隐私模式等属正常）
            console.warn('[Updater] 启动静默检查失败:', msg)
          } else {
            console.error('[Updater] GitHub API 检查也失败:', githubErr)
            setStatus('error')
            if (msg.includes('403') || msg.includes('rate limit')) {
              setMessage('GitHub API 请求频率限制，请稍后再试')
            } else if (msg.includes('404')) {
              setMessage('暂无发布版本，请等待后续更新')
            } else {
              setMessage(`检查更新失败：${msg}`)
            }
          }
        }
      } finally {
        setUpdateChecked(true)
        if (!quiet) setStatus((s) => (s === 'checking' ? 'up-to-date' : s))
      }
    },
    [appVersion, setAvailableUpdate, setUpdateChecked],
  )

  const skip = useCallback(() => {
    if (!update) return
    setSkippedVersion(update.version)
    setUpdate(null)
    setAvailableUpdate(null)
    setStatus('idle')
    setMessage('')
  }, [update, setAvailableUpdate])

  const install = useCallback(async () => {
    if (!update) return

    // GitHub 兜底路径：跳转下载页
    if (update.source === 'github') {
      await openExternalUrl(update.url)
      return
    }

    setInstalling(true)
    setProgress(0)
    setMessage('正在下载更新…')
    try {
      const { check: checkUpdater } = await import('@tauri-apps/plugin-updater')
      const found = await checkUpdater()
      if (!found) {
        setMessage('未找到可安装的更新，请重新检查')
        setStatus('error')
        return
      }
      await found.downloadAndInstall((event) => {
        const pct = readProgressPercent(event)
        if (pct !== null) setProgress(pct)
        if ((event as { event?: string })?.event === 'Finished') setProgress(100)
      })
      setInstalled(true)
      setStatus('available')
      setMessage('新版本已下载安装完成，重启应用后生效。')
    } catch (err) {
      console.error('[Updater] 下载安装失败:', err)
      setStatus('error')
      setMessage(
        `下载更新失败：${err instanceof Error ? err.message : String(err)}\n可前往 GitHub Releases 手动下载。`,
      )
    } finally {
      setInstalling(false)
    }
  }, [update])

  return { status, message, update, progress, installing, installed, check, skip, install }
}

/** 用户主动检查时清除跳过记录（供设置页调用） */
export { clearSkippedVersion }

/** 启动静默检查延迟（ms）：让首屏渲染与数据加载先完成，避免与启动请求抢带宽 */
const STARTUP_CHECK_DELAY_MS = 4000

/**
 * 启动静默检查 —— 供 AppInit 在主窗口挂载时调用一次。
 *
 * - 延迟启动，非阻塞，不改变界面 loading 文案
 * - 版本号有效（已从 Tauri 读取且非 dev 占位）后才检查，避免用 '0.0.0-dev' 误判
 * - 尊重「跳过此版本」；检查失败静默忽略（离线/隐私模式属正常）
 * - enabled=false（独立窗口）时不做任何请求
 */
export function useStartupUpdateCheck(enabled: boolean): void {
  const appVersion = useAiStore((s) => s.appVersion)
  const { check } = useUpdateCheck()
  const ranRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    // 版本号未就绪或为 Web 预览占位时等待（appVersion 变化会重新触发本 effect）
    if (!appVersion || appVersion.startsWith('0.0.0')) return
    if (ranRef.current) return
    ranRef.current = true

    const timer = setTimeout(() => {
      void check({ quiet: true })
    }, STARTUP_CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled, appVersion, check])
}
