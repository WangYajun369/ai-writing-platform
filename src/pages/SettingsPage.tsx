/**
 * SettingsPage — 设置页面
 *
 * 提供四个设置标签页：
 * - AI 配置（服务商/API/模型/Temperature）
 * - 外观（浅色/深色/跟随系统）
 * - 存储（占位，后续版本推出统计功能）
 * - 版本（当前版本 / 检查更新）
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftIcon, BotIcon, PaletteIcon, DatabaseIcon, RefreshCwIcon, ArrowUpCircleIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'

type Tab = 'ai' | 'appearance' | 'storage' | 'version'

export default function SettingsPage() {
  const navigate = useNavigate()
  const { aiConfig, setAiConfig, theme, setTheme, eyeCareMode, setEyeCareMode, fontFamily, setFontFamily } = useAppStore()
  const [activeTab, setActiveTab] = useState<Tab>('ai')

  return (
    <div className="min-h-screen bg-background">
      {/* 顶栏 */}
      <header className="border-b bg-card px-6 py-4 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg hover:bg-muted transition-colors"
        >
          <ArrowLeftIcon className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="max-w-3xl mx-auto p-6 flex gap-6">
        {/* 侧边选项卡 */}
        <nav className="w-48 flex flex-col gap-1 flex-shrink-0">
          {([
            { id: 'ai', label: 'AI 配置', icon: BotIcon },
            { id: 'appearance', label: '外观', icon: PaletteIcon },
            { id: 'storage', label: '存储', icon: DatabaseIcon },
            { id: 'version', label: '版本', icon: ArrowUpCircleIcon },
          ] as { id: Tab; label: string; icon: React.FC<{ className?: string }> }[]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                activeTab === id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>

        {/* 内容区 */}
        <div className="flex-1 bg-card border rounded-xl p-6">
          {activeTab === 'ai' && (
            <AiConfigSection config={aiConfig} onChange={setAiConfig} />
          )}
          {activeTab === 'appearance' && (
            <AppearanceSection
              theme={theme}
              eyeCareMode={eyeCareMode}
              fontFamily={fontFamily}
              onThemeChange={setTheme}
              onEyeCareChange={setEyeCareMode}
              onFontFamilyChange={setFontFamily}
            />
          )}
          {activeTab === 'storage' && (
            <StorageSection />
          )}
          {activeTab === 'version' && (
            <VersionSection />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * AI 配置区块
 *
 * 提供 Ollama/OpenAI/自定义三种服务商选择，
 * 以及 API 地址、对话模型、Embedding 模型、Temperature 滑杆、API Key 配置。
 */
function AiConfigSection({
  config,
  onChange,
}: {
    // @ts-ignore
    config: ReturnType<typeof useAppStore>['aiConfig']
  onChange: (c: Partial<typeof config>) => void
}) {
  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold">AI 服务配置</h2>

      <div className="space-y-1">
        <label className="text-sm font-medium">服务商</label>
        <select
          value={config.provider}
          onChange={(e) => onChange({ provider: e.target.value as typeof config.provider })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="ollama">Ollama（本地）</option>
          <option value="openai">OpenAI</option>
          <option value="custom">自定义</option>
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">API 地址</label>
        <input
          value={config.endpoint}
          onChange={(e) => onChange({ endpoint: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="http://127.0.0.1:11434"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">对话模型</label>
        <input
          value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="qwen2.5:7b"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Embedding 模型</label>
        <input
          value={config.embeddingModel}
          onChange={(e) => onChange({ embeddingModel: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="bge-m3"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Temperature: {config.temperature}</label>
        <input
          type="range"
          min={0} max={1} step={0.1}
          value={config.temperature}
          onChange={(e) => onChange({ temperature: parseFloat(e.target.value) })}
          className="w-full"
        />
      </div>

      {config.provider !== 'ollama' && (
        <div className="space-y-1">
          <label className="text-sm font-medium">API Key</label>
          <input
            type="password"
            value={config.apiKey ?? ''}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="sk-..."
          />
        </div>
      )}
    </div>
  )
}

/**
 * 外观配置区块
 *
 * 主题切换：浅色 / 深色 / 跟随系统。
 * 护眼模式：关闭 / 暖黄色 / 豆沙绿。
 */
function AppearanceSection({
  theme,
  eyeCareMode,
  fontFamily,
  onThemeChange,
  onEyeCareChange,
  onFontFamilyChange,
}: {
  theme: string
  eyeCareMode: string
  fontFamily: string
  onThemeChange: (t: 'light' | 'dark' | 'system') => void
  onEyeCareChange: (m: 'off' | 'warm' | 'green') => void
  onFontFamilyChange: (f: 'serif' | 'simhei' | 'simsun' | 'kaiti' | 'yahei') => void
}) {
  const fontOptions = [
    { value: 'serif', label: '默认衬线' },
    { value: 'simhei', label: '黑体' },
    { value: 'simsun', label: '宋体' },
    { value: 'kaiti', label: '楷体' },
    { value: 'yahei', label: '微软雅黑' },
  ] as const
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">外观设置</h2>

      {/* 主题 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">主题</label>
        <div className="flex gap-3">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              onClick={() => onThemeChange(t)}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                theme === t ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
              }`}
            >
              {{ light: '浅色', dark: '深色', system: '跟随系统' }[t]}
            </button>
          ))}
        </div>
      </div>

      {/* 护眼模式 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">护眼模式</label>
        <p className="text-xs text-muted-foreground">
          选择舒适的背景色，减轻长时间写作的视觉疲劳
        </p>
        <div className="flex gap-3">
          {([
            { value: 'off', label: '关闭' },
            { value: 'warm', label: '暖黄色', color: 'bg-[#f5efdb]' },
            { value: 'green', label: '豆沙绿', color: 'bg-[#d7e8d0]' },
          ] as const).map(({ value, label, ...rest }) => (
            <button
              key={value}
              onClick={() => onEyeCareChange(value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
                eyeCareMode === value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              {'color' in rest && rest.color && (
                <span
                  className={`inline-block w-4 h-4 rounded border border-border ${rest.color}`}
                />
              )}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 字体 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">写作字体</label>
        <p className="text-xs text-muted-foreground">
          选择编辑器中使用的字体，营造不同的写作氛围
        </p>
        <div className="flex flex-wrap gap-3">
          {fontOptions.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => onFontFamilyChange(value)}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                fontFamily === value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 存储信息区块
 *
 * 说明数据库文件存储方式，占位等待统计功能。
 */
function StorageSection() {
  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold">存储管理</h2>
      <p className="text-sm text-muted-foreground">
        每部作品以独立 <code className="bg-muted px-1 rounded text-xs">.db</code> 文件存储，包含文本、媒体、向量索引与版本历史。
      </p>
      <div className="p-4 bg-muted rounded-lg text-sm text-muted-foreground">
        存储统计功能将在后续版本中推出。
      </div>
    </div>
  )
}

/**
 * 版本更新区块
 *
 * 展示当前版本号并提供检查更新功能。
 * 优先通过 Tauri updater 插件检查；失败时回退到直接请求 GitHub Releases API。
 */
function VersionSection() {
  const [isChecking, setIsChecking] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'up-to-date' | 'error'>('idle')
  const [updateMessage, setUpdateMessage] = useState('')
  const [latestVersion, setLatestVersion] = useState('')
  const [releaseUrl, setReleaseUrl] = useState('')

  const APP_VERSION = '0.1.0'
  const GITHUB_REPO = 'ukcoder/mirage-ink'

  /** 比较两个 semver 版本号，返回 1 表示 v1 > v2 */
  const compareVersions = (v1: string, v2: string): number => {
    const a = v1.replace(/^v/, '').split('.').map(Number)
    const b = v2.replace(/^v/, '').split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) > (b[i] ?? 0)) return 1
      if ((a[i] ?? 0) < (b[i] ?? 0)) return -1
    }
    return 0
  }

  /** 通过 GitHub Releases API 检查更新（不需要 Tauri updater 配置） */
  const checkViaGithub = async (): Promise<{ version: string; url: string; body: string } | null> => {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' } },
    )
    if (!resp.ok) {
      throw new Error(`GitHub API 返回 ${resp.status}`)
    }
    const data = await resp.json()
    const remoteVer = data.tag_name ?? ''
    if (!remoteVer) return null
    if (compareVersions(remoteVer, APP_VERSION) > 0) {
      return {
        version: remoteVer,
        url: data.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
        body: data.body ?? '',
      }
    }
    return null
  }

  /** 打开外部链接 */
  const openUrl = async (url: string) => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
    } catch {
      window.open(url, '_blank')
    }
  }

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
        setLatestVersion(update.version)
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
        const release = await checkViaGithub()
        if (release) {
          setLatestVersion(release.version)
          setReleaseUrl(release.url)
          setUpdateStatus('available')
          setUpdateMessage(
            `发现新版本 ${release.version}，当前版本 v${APP_VERSION}。\n请前往 GitHub 下载安装。\n\n${release.body}`,
          )
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
    // 如果有 releaseUrl，说明是通过 GitHub API 发现的 → 打开浏览器下载
    if (releaseUrl) {
      await openUrl(releaseUrl)
      return
    }

    // 否则走 Tauri updater 下载安装
    setIsChecking(true)
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update) {
        await update.downloadAndInstall((event) => {
          if (event.event === 'Progress') {
            // event.data: { downloaded, contentLength }
          }
        })
      }
    } catch (err) {
      console.error('[Updater] 下载安装失败:', err)
      setUpdateMessage(err instanceof Error ? err.message : '下载更新失败')
    } finally {
      setIsChecking(false)
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">版本更新</h2>

      {/* 当前版本信息 */}
      <div className="p-4 bg-muted rounded-lg">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">幻境水墨 MirageInk</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              跨平台小说创作工具
            </p>
          </div>
          <span className="px-3 py-1 bg-primary/10 text-primary text-sm font-mono rounded-full">
            v{APP_VERSION}
          </span>
        </div>
      </div>

      {/* 检查更新区域 */}
      <div className="space-y-3">
        <button
          onClick={handleCheckUpdate}
          disabled={isChecking}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCwIcon className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />
          {isChecking ? '正在检查...' : '检查更新'}
        </button>

        {/* 状态提示 */}
        {updateStatus !== 'idle' && (
          <div
            className={`p-3 rounded-lg text-sm ${
              updateStatus === 'available'
                ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                : updateStatus === 'error'
                  ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
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
