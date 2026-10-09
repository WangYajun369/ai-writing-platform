/**
 * 版本更新区块 —— 当前版本 / 检查更新 / 下载安装
 *
 * 更新链路与状态机集中在 useUpdateCheck（应用内 updater 优先，GitHub API 兜底），
 * 本组件只负责呈现：手动检查会清除「跳过此版本」记录，确保用户主动检查必有反馈。
 */
import { useAiStore } from '@/stores/aiStore'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { useUpdateCheck } from '@/hooks/useUpdateCheck'
import { clearSkippedVersion } from '@/lib/version'
import { RefreshCwIcon, RocketIcon, SkipForwardIcon, TerminalIcon } from 'lucide-react'

export function VersionSection() {
  const APP_VERSION = useAiStore((s) => s.appVersion)
  const { status, message, update, progress, installing, installed, check, skip, install } =
    useUpdateCheck()
  const developerMode = usePreferencesStore((s) => s.developerMode)
  const setDeveloperMode = usePreferencesStore((s) => s.setDeveloperMode)

  const handleCheckUpdate = () => {
    // 主动检查视为用户想了解最新情况：清除跳过记录
    clearSkippedVersion()
    void check()
  }

  // 不同检查结果对应的结果条底色/文字色
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

      {/* 检查更新 + 开发者模式 */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleCheckUpdate}
            disabled={status === 'checking'}
            className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCwIcon className={`w-4 h-4 ${status === 'checking' ? 'animate-spin' : ''}`} />
            {status === 'checking' ? '正在检查...' : '检查更新'}
          </button>

          {/* 开发者模式开关：开启后显示「系统检查」设置项与首页「调试控制台」 */}
          <button
            onClick={() => setDeveloperMode(!developerMode)}
            role="switch"
            aria-checked={developerMode}
            title={
              developerMode
                ? '关闭后隐藏「系统检查」设置项与首页「调试控制台」'
                : '开启后显示「系统检查」设置项与首页「调试控制台」'
            }
            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
              developerMode
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            <TerminalIcon className="w-4 h-4" />
            开发者模式
            <span
              className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                developerMode ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                  developerMode ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          {developerMode
            ? '开发者模式已开启：设置页新增「系统检查」标签页，首页显示「调试控制台」入口。'
            : '开启开发者模式后可查看「系统检查」与首页「调试控制台」。'}
        </p>

        {status !== 'idle' && (
          <div className={`p-3 rounded-lg text-sm ${statusStyles[status] ?? ''}`}>
            <p className="whitespace-pre-wrap">{message}</p>

            {/* 下载进度 */}
            {installing && (
              <div className="mt-3">
                <div className="h-1.5 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-green-600 transition-[width] duration-300"
                    style={{ width: `${progress ?? 0}%` }}
                  />
                </div>
                <p className="mt-1 text-xs opacity-80">
                  {progress !== null ? `已下载 ${progress}%` : '正在准备下载…'}
                </p>
              </div>
            )}

            {/* 操作区 */}
            {status === 'available' && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {installed ? (
                  <span className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium">
                    <RocketIcon className="w-4 h-4" />
                    请重启应用以完成更新
                  </span>
                ) : (
                  <button
                    onClick={install}
                    disabled={installing}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCwIcon className={`w-4 h-4 ${installing ? 'animate-spin' : ''}`} />
                    {update?.source === 'github'
                      ? '前往 GitHub 下载'
                      : installing
                        ? '正在下载…'
                        : '立即更新'}
                  </button>
                )}

                {!installed && (
                  <button
                    onClick={skip}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    title="本版本不再提示；发布更新的版本时会重新提示"
                  >
                    <SkipForwardIcon className="w-3.5 h-3.5" />
                    跳过此版本
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 补充说明 */}
      <div className="p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground">
        <p>更新检查需要网络连接，优先使用应用内更新；如不可用则自动通过 GitHub API 检查。</p>
        {status === 'up-to-date' && (
          <span className="block mt-1 text-primary">你正在使用最新版本，感谢支持！</span>
        )}
      </div>
    </div>
  )
}
