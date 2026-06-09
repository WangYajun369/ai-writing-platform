/**
 * 版本更新区块 —— 当前版本 / 检查更新 / 下载安装
 */
import { useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { GITHUB_REPO } from './constants'

type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'error'

/** 比较两个 semver 版本号，返回 1 表示 v1 > v2 */
function compareVersions(v1: string, v2: string): number {
  const a = v1.replace(/^v/, '').split('.').map(Number)
  const b = v2.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return 1
    if ((a[i] ?? 0) < (b[i] ?? 0)) return -1
  }
  return 0
}

/** 通过 GitHub Releases API 检查更新 */
async function checkViaGithub(appVersion: string): Promise<{ version: string; url: string; body: string } | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )
  if (!resp.ok) throw new Error(`GitHub API 返回 ${resp.status}`)
  const data = await resp.json()
  const remoteVer = data.tag_name ?? ''
  if (!remoteVer) return null
  if (compareVersions(remoteVer, appVersion) > 0) {
    return {
      version: remoteVer,
      url: data.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
      body: data.body ?? '',
    }
  }
  return null
}

/** 打开外部链接 */
async function openUrl(url: string) {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } catch {
    window.open(url, '_blank')
  }
}

export function VersionSection() {
  const [isChecking, setIsChecking] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [updateMessage, setUpdateMessage] = useState('')
  const [releaseUrl, setReleaseUrl] = useState('')

  const APP_VERSION = useAppStore((s) => s.appVersion)

  const handleCheckUpdate = async () => {
    setIsChecking(true)
    setUpdateStatus('checking')
    setUpdateMessage('')

    try {
      // 1) 优先使用 Tauri updater 插件
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()

      if (update) {
        setUpdateStatus('available')
        setUpdateMessage(`发现新版本 ${update.version}，当前版本 ${update.currentVersion}。\n${update.body ?? ''}`)
        setIsChecking(false)
        return
      }
      setUpdateStatus('up-to-date')
      setUpdateMessage('已是最新版本')
    } catch (updaterErr) {
      // 2) Tauri updater 失败 → 回退到 GitHub API
      console.warn('[Updater] Tauri updater 检查失败，尝试 GitHub API:', updaterErr)
      try {
        const release = await checkViaGithub(APP_VERSION)
        if (release) {
          setReleaseUrl(release.url)
          setUpdateStatus('available')
          setUpdateMessage(`发现新版本 ${release.version}，当前版本 v${APP_VERSION}。\n请前往 GitHub 下载安装。\n\n${release.body}`)
        } else {
          setUpdateStatus('up-to-date')
          setUpdateMessage('已是最新版本（通过 GitHub 检查）')
        }
      } catch (githubErr) {
        console.error('[Updater] GitHub API 检查也失败:', githubErr)
        const msg = githubErr instanceof Error ? githubErr.message : String(githubErr)
        setUpdateStatus('error')
        if (msg.includes('403') || msg.includes('rate limit')) {
          setUpdateMessage('GitHub API 请求频率限制，请稍后再试')
        } else if (msg.includes('404')) {
          setUpdateMessage('暂无发布版本，请等待后续更新')
        } else {
          setUpdateMessage(`检查更新失败：${msg}`)
        }
      }
    } finally {
      setIsChecking(false)
    }
  }

  const handleDownloadAndInstall = async () => {
    if (releaseUrl) {
      await openUrl(releaseUrl)
      return
    }

    setIsChecking(true)
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update) {
        await update.downloadAndInstall(() => {})
      }
    } catch (err) {
      console.error('[Updater] 下载安装失败:', err)
      setUpdateMessage(err instanceof Error ? err.message : '下载更新失败')
    } finally {
      setIsChecking(false)
    }
  }

  const statusStyles: Record<string, string> = {
    available: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400',
    error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400',
    'up-to-date': 'bg-muted text-muted-foreground',
    checking: 'bg-muted text-muted-foreground',
  }

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">版本更新</h2>

      {/* 当前版本信息 */}
      <div className="p-4 bg-muted rounded-lg">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">智写时光 TimeWrite</p>
            <p className="text-xs text-muted-foreground mt-0.5">跨平台小说创作工具</p>
          </div>
          <span className="px-3 py-1 bg-primary/10 text-primary text-sm font-mono rounded-full">
            v{APP_VERSION}
          </span>
        </div>
      </div>

      {/* 检查更新 */}
      <div className="space-y-3">
        <button
          onClick={handleCheckUpdate}
          disabled={isChecking}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCwIcon className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
          {isChecking ? '正在检查...' : '检查更新'}
        </button>

        {updateStatus !== 'idle' && (
          <div className={`p-3 rounded-lg text-sm ${statusStyles[updateStatus] ?? ''}`}>
            <p className="whitespace-pre-wrap">{updateMessage}</p>

            {updateStatus === 'available' && (
              <button
                onClick={handleDownloadAndInstall}
                disabled={isChecking}
                className="mt-3 flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCwIcon className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
                {releaseUrl ? '前往 GitHub 下载' : '立即更新'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 补充说明 */}
      <div className="p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground">
        <p>更新检查需要网络连接，优先使用应用内更新；如不可用则自动通过 GitHub API 检查。</p>
        {updateStatus === 'up-to-date' && (
          <span className="block mt-1 text-primary">你正在使用最新版本，感谢支持！</span>
        )}
      </div>
    </div>
  )
}
