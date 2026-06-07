/**
 * SettingsPage — 设置页面
 *
 * 提供五个设置标签页：
 * - AI 配置（服务商/API/模型/Temperature）
 * - 外观（浅色/深色/跟随系统）
 * - 编辑（编辑器显示宽度）
 * - 存储（占位，后续版本推出统计功能）
 * - 版本（当前版本 / 检查更新）
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftIcon, BotIcon, PaletteIcon, DatabaseIcon, RefreshCwIcon, ArrowUpCircleIcon, MinusIcon, PlusIcon, PenLineIcon, ZapIcon, CircleCheckIcon, CircleAlertIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'

type Tab = 'ai' | 'appearance' | 'editor' | 'storage' | 'version'

export default function SettingsPage() {
  const navigate = useNavigate()
  const { aiConfig, setAiConfig, aiConnectionStatus, aiConnectionDetail, setAiConnectionStatus, theme, setTheme, eyeCareMode, setEyeCareMode, fontFamily, setFontFamily, fontSize, setFontSize, gridSize, setGridSize, editorWidth, setEditorWidth } = useAppStore()
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
            { id: 'editor', label: '编辑', icon: PenLineIcon },
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
            <AiConfigSection
              config={aiConfig}
              onChange={setAiConfig}
              connectionStatus={aiConnectionStatus}
              connectionDetail={aiConnectionDetail}
              onTestConnection={async () => {
                setAiConnectionStatus('testing')
                try {
                  const { aiApi } = await import('@/lib/tauri-bridge')
                  const result = await aiApi.testConnection(
                    aiConfig.provider,
                    aiConfig.endpoint,
                    aiConfig.apiKey,
                  )
                  setAiConnectionStatus(result.ok ? 'connected' : 'error', result.detail)
                } catch (err) {
                  setAiConnectionStatus('error', String(err))
                }
              }}
            />
          )}
          {activeTab === 'appearance' && (
            <AppearanceSection
              theme={theme}
              eyeCareMode={eyeCareMode}
              fontFamily={fontFamily}
              fontSize={fontSize}
              gridSize={gridSize}
              onThemeChange={setTheme}
              onEyeCareChange={setEyeCareMode}
              onFontFamilyChange={setFontFamily}
              onFontSizeChange={setFontSize}
              onGridSizeChange={setGridSize}
            />
          )}
          {activeTab === 'editor' && (
            <EditorConfigSection
              editorWidth={editorWidth}
              onEditorWidthChange={setEditorWidth}
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
 * 提供智谱 BigModel / 自定义两种服务商选择，
 * 以及 API 地址、对话模型、Embedding 模型、Temperature 滑杆、API Key 配置。
 */
function AiConfigSection({
  config,
  onChange,
  connectionStatus,
  connectionDetail,
  onTestConnection,
}: {
    // @ts-ignore
    config: ReturnType<typeof useAppStore>['aiConfig']
  onChange: (c: Partial<typeof config>) => void
  connectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  connectionDetail: string
  onTestConnection: () => Promise<void>
}) {
  /** 切换服务商时自动填充默认 endpoint 和 model */
  const handleProviderChange = (provider: typeof config.provider) => {
    const defaults: Record<string, { endpoint: string; model: string; embeddingModel: string }> = {
      bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1', embeddingModel: 'embedding-3' },
      custom: { endpoint: '', model: '', embeddingModel: '' },
    }
    const d = defaults[provider]
    onChange({ provider, endpoint: d.endpoint, model: d.model, embeddingModel: d.embeddingModel })
  }

  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold">AI 服务配置</h2>

      <div className="space-y-1">
        <label className="text-sm font-medium">服务商</label>
        <select
          value={config.provider}
          onChange={(e) => handleProviderChange(e.target.value as typeof config.provider)}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="bigmodel">智谱 BigModel</option>
          <option value="custom">自定义</option>
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">API 地址</label>
        <input
          value={config.endpoint}
          onChange={(e) => onChange({ endpoint: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="https://open.bigmodel.cn/api/paas/v4"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">对话模型</label>
        <input
          value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="glm-4-flash"
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

      <div className="space-y-1">
        <label className="text-sm font-medium">最大输出 Token 数</label>
        <input
          type="number"
          min={1}
          max={262144}
          step={1024}
          value={config.maxTokens}
          onChange={(e) => onChange({ maxTokens: Math.max(1, parseInt(e.target.value) || 65536) })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          1 万汉字约需 15000 tokens。推理模型（GLM-5.1/DeepSeek-R1 等）的思考过程也计入此上限，建议设置 ≥ 131072。
        </p>
      </div>

      {/* 测试连接 */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <button
            onClick={onTestConnection}
            disabled={connectionStatus === 'testing'}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ZapIcon className={`w-4 h-4 ${connectionStatus === 'testing' ? 'animate-pulse' : ''}`} />
            {connectionStatus === 'testing' ? '检测中…' : '测试连接'}
          </button>
        </div>

        {/* 连接状态提示 */}
        {connectionStatus !== 'idle' && (
          <div
            className={`flex items-start gap-2 p-3 rounded-lg text-sm ${
              connectionStatus === 'connected'
                ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                : connectionStatus === 'error'
                  ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                  : 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
            }`}
          >
            {connectionStatus === 'connected' ? (
              <CircleCheckIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
            ) : connectionStatus === 'error' ? (
              <CircleAlertIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
            ) : (
              <RefreshCwIcon className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" />
            )}
            <p className="whitespace-pre-wrap text-xs">{connectionDetail}</p>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">API Key</label>
        <input
          type="password"
          value={config.apiKey ?? ''}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder={config.provider === 'bigmodel' ? '填写智谱 API Key' : 'sk-...'}
        />
      </div>
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
  fontSize,
  gridSize,
  onThemeChange,
  onEyeCareChange,
  onFontFamilyChange,
  onFontSizeChange,
  onGridSizeChange,
}: {
  theme: string
  eyeCareMode: string
  fontFamily: string
  fontSize: number
  gridSize: 'small' | 'medium' | 'large'
  onThemeChange: (t: 'light' | 'dark' | 'system') => void
  onEyeCareChange: (m: 'off' | 'warm' | 'green') => void
  onFontFamilyChange: (f: 'serif' | 'simhei' | 'simsun' | 'kaiti' | 'yahei') => void
  onFontSizeChange: (s: number) => void
  onGridSizeChange: (s: 'small' | 'medium' | 'large') => void
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

      {/* 字体大小 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">字体大小</label>
        <p className="text-xs text-muted-foreground">
          调整编辑器字体大小（12px - 24px）
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onFontSizeChange(Math.max(12, fontSize - 1))}
            disabled={fontSize <= 12}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-muted hover:bg-muted/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <MinusIcon className="w-4 h-4" />
          </button>
          <span className="text-sm font-mono min-w-[3rem] text-center">{fontSize}px</span>
          <button
            onClick={() => onFontSizeChange(Math.min(24, fontSize + 1))}
            disabled={fontSize >= 24}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-muted hover:bg-muted/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <PlusIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 作品列表网格大小 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">作品列表网格大小</label>
        <p className="text-xs text-muted-foreground">
          调整作品列表页网格视图的卡片大小和间距
        </p>
        <div className="flex gap-3">
          {([
            { value: 'small', label: '紧凑', desc: '更多列更密' },
            { value: 'medium', label: '标准', desc: '默认大小' },
            { value: 'large', label: '宽松', desc: '更大更敞' },
          ] as const).map(({ value, label, desc }) => (
            <button
              key={value}
              onClick={() => onGridSizeChange(value)}
              className={`flex flex-col items-start gap-0.5 px-4 py-2 rounded-lg text-sm transition-colors ${
                gridSize === value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              <span className="font-medium">{label}</span>
              <span className="text-xs opacity-70">{desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 编辑配置区块
 *
 * 编辑器显示宽度：手机宽度 / 标准宽度 / 宽幅宽度。
 */
function EditorConfigSection({
  editorWidth,
  onEditorWidthChange,
}: {
  editorWidth: string
  onEditorWidthChange: (w: 'mobile' | 'standard' | 'wide') => void
}) {
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">编辑设置</h2>

      {/* 编辑器显示宽度 */}
      <div className="space-y-2">
        <label className="text-sm font-medium">编辑器显示宽度</label>
        <p className="text-xs text-muted-foreground">
          调整编辑区域的最大显示宽度，适配不同屏幕和写作习惯
        </p>
        <div className="flex gap-3">
          {([
            { value: 'mobile', label: '手机宽度', desc: '约 448px', icon: '📱' },
            { value: 'standard', label: '标准宽度', desc: '约 768px', icon: '💻' },
            { value: 'wide', label: '宽幅宽度', desc: '约 1024px', icon: '🖥️' },
          ] as const).map(({ value, label, desc, icon }) => (
            <button
              key={value}
              onClick={() => onEditorWidthChange(value)}
              className={`flex flex-col items-start gap-0.5 px-4 py-2 rounded-lg text-sm transition-colors ${
                editorWidth === value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <span>{icon}</span>
                {label}
              </span>
              <span className="text-xs opacity-70">{desc}</span>
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
  const [releaseUrl, setReleaseUrl] = useState('')

  const APP_VERSION = useAppStore((s) => s.appVersion)
  const GITHUB_REPO = 'WangYajun369/ai-writing-platform'

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
            <p className="text-sm font-medium">智写时光 TimeWrite</p>
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
