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
import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftIcon, BotIcon, PaletteIcon, DatabaseIcon, RefreshCwIcon, ArrowUpCircleIcon, MinusIcon, PlusIcon, PenLineIcon, ZapIcon, CircleCheckIcon, CircleAlertIcon, BrainIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import type { AiConfig, AiChatConfig, RagConfig, RagProvider } from '@/types'
import { getChatApiKey, getRagApiKey } from '@/types'

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
              onTestConnection={async (endpoint: string, apiKey?: string) => {
                setAiConnectionStatus('testing')
                try {
                  const { aiApi } = await import('@/lib/tauri-bridge')
                  const result = await aiApi.testConnection(
                    aiConfig.chat.provider,
                    endpoint,
                    apiKey,
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
 * AI 配置区块（对话与 RAG 解耦）
 *
 * 对话配置：智谱 / DeepSeek 双服务商切换，DeepSeek 模型下拉选择，思考模式开关。
 * RAG 配置：独立开关，仅支持智谱 Embedding API。
 */
function AiConfigSection({
  config,
  onChange,
  connectionStatus,
  connectionDetail,
  onTestConnection,
}: {
  config: AiConfig
  onChange: (c: Partial<AiConfig>) => void
  connectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  connectionDetail: string
  onTestConnection: (endpoint: string, apiKey?: string) => Promise<void>
}) {
  if (!config.chat || !config.rag) {
    return <div className="p-4 text-sm text-muted-foreground">AI 配置数据异常，请尝试清除浏览器缓存后重试。</div>
  }
  return (
    <div className="space-y-6">
      {/* ======== 对话配置 ======== */}
      <ChatConfigSection
        config={config.chat}
        onChange={(partial) => onChange({ chat: { ...config.chat, ...partial } })}
        connectionStatus={connectionStatus}
        connectionDetail={connectionDetail}
        onTestConnection={onTestConnection}
      />

      <hr className="border-border/40" />

      {/* ======== RAG 配置 ======== */}
      <RagConfigSection
        config={config.rag}
        onChange={(partial) => onChange({ rag: { ...config.rag, ...partial } })}
      />
    </div>
  )
}

/** 对话配置子区块 */
function ChatConfigSection({
  config,
  onChange,
  connectionStatus,
  connectionDetail,
  onTestConnection,
}: {
  config: AiChatConfig
  onChange: (c: Partial<AiChatConfig>) => void
  connectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  connectionDetail: string
  onTestConnection: (endpoint: string, apiKey?: string) => Promise<void>
}) {
  /** 智谱可选模型 */
  const BIGMODEL_MODELS = ['glm-5.1'] as const
  /** DeepSeek 可选模型 */
  const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const

  /** 切换服务商时自动填充默认值，同时保留各自的 API Key */
  const handleProviderChange = (provider: typeof config.provider) => {
    const defaults: Record<string, { endpoint: string; model: string }> = {
      bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1' },
      deepseek: { endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    }
    const d = defaults[provider]
    onChange({ provider, endpoint: d.endpoint, model: d.model })
  }

  /** 当前服务商的 API Key */
  const currentApiKey = getChatApiKey(config)

  /** API Key 输入框编辑状态 */
  const [editingApiKey, setEditingApiKey] = useState(false)
  const apiKeyInputRef = useRef<HTMLInputElement>(null)

  // 进入编辑时自动聚焦
  useEffect(() => {
    if (editingApiKey) {
      apiKeyInputRef.current?.focus()
    }
  }, [editingApiKey])

  /** 更新当前服务商的 API Key */
  const handleApiKeyChange = (value: string) => {
    if (config.provider === 'bigmodel') {
      onChange({ bigmodelApiKey: value || undefined })
    } else {
      onChange({ deepseekApiKey: value || undefined })
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">AI 对话</h2>

      {/* 服务商 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">服务商</label>
        <select
          value={config.provider}
          onChange={(e) => handleProviderChange(e.target.value as typeof config.provider)}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="bigmodel">智谱 BigModel</option>
          <option value="deepseek">DeepSeek</option>
        </select>
      </div>

      {/* API 地址（根据服务商自动填充，不可修改） */}
      <div className="space-y-1">
        <label className="text-sm font-medium">API 地址</label>
        <p className="text-xs text-muted-foreground mb-1">根据所选服务商自动填充，暂不支持修改</p>
        <input
          value={config.endpoint}
          readOnly
          className="w-full bg-muted/50 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed opacity-60"
          placeholder={
            config.provider === 'bigmodel'
              ? 'https://open.bigmodel.cn/api/paas/v4'
              : 'https://api.deepseek.com/v1'
          }
        />
      </div>

      {/* 对话模型 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">对话模型</label>
        <select
          value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          {(config.provider === 'deepseek' ? DEEPSEEK_MODELS : BIGMODEL_MODELS).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* 思考模式（仅 DeepSeek 时显示） */}
      {config.provider === 'deepseek' && (
        <div className="space-y-1">
          <label className="text-sm font-medium">思考模式</label>
          <p className="text-xs text-muted-foreground">
            启用后，模型会先进行深度推理再输出回答，思考过程可在 AI 助手中查看
          </p>
          <div className="flex gap-3 mt-1">
            {([{ value: true, label: '启用' }, { value: false, label: '禁用' }] as const).map(
              ({ value, label }) => (
                <button
                  key={label}
                  onClick={() => onChange({ thinkingEnabled: value })}
                  className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                    config.thinkingEnabled === value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted hover:bg-muted/80'
                  }`}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        </div>
      )}

      {/* Temperature */}
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

      {/* 最大输出 Token */}
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
          1 万汉字约需 15000 tokens。推理模型的思考过程也计入此上限，建议设置 ≥ 131072。
        </p>
      </div>

      {/* API Key（各服务商独立存储，点击可编辑） */}
      <div className="space-y-1">
        <label className="text-sm font-medium">API Key</label>
        <p className="text-xs text-muted-foreground mb-1">
          每个服务商的 API Key 独立保存，切换服务商不会丢失
        </p>
        {editingApiKey ? (
          <input
            ref={apiKeyInputRef}
            type="password"
            value={currentApiKey ?? ''}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            onBlur={() => setEditingApiKey(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingApiKey(false) }}
            className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={config.provider === 'bigmodel' ? '填写智谱 API Key' : '填写 DeepSeek API Key'}
          />
        ) : (
          <button
            onClick={() => setEditingApiKey(true)}
            className="w-full bg-muted rounded-lg px-3 py-2 text-sm text-left font-mono flex items-center justify-between group hover:bg-muted/80 transition-colors"
            title="点击编辑 API Key"
          >
            <span className={currentApiKey ? 'text-foreground tracking-wider' : 'text-muted-foreground'}>
              {currentApiKey ? maskApiKeyStr(currentApiKey) : (config.provider === 'bigmodel' ? '填写智谱 API Key' : '填写 DeepSeek API Key')}
            </span>
            <span className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors text-xs">
              ✎
            </span>
          </button>
        )}
      </div>

      {/* 测试连接 */}
      <div className="space-y-2">
        <button
          onClick={() => onTestConnection(config.endpoint, currentApiKey)}
          disabled={connectionStatus === 'testing'}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ZapIcon className={`w-4 h-4 ${connectionStatus === 'testing' ? 'animate-pulse' : ''}`} />
          {connectionStatus === 'testing' ? '检测中…' : '测试连接'}
        </button>

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
    </div>
  )
}

/** 掩码显示：前4后4，中间用 * 填充，短 key 全掩 */
function maskApiKeyStr(key: string | undefined): string {
  if (!key) return ''
  if (key.length <= 8) return '*'.repeat(key.length)
  return key.slice(0, 4) + '****' + key.slice(-4)
}

/** RAG Embedding 可选模型 */
const RAG_BIGMODEL_MODELS = ['embedding-3'] as const

/** RAG 检索配置子区块 */
function RagConfigSection({
  config,
  onChange,
}: {
  config: RagConfig
  onChange: (c: Partial<RagConfig>) => void
}) {
  const [ragEditingApiKey, setRagEditingApiKey] = useState(false)
  const ragApiKeyInputRef = useRef<HTMLInputElement>(null)

  // RAG 连接测试状态
  const [ragTestStatus, setRagTestStatus] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle')
  const [ragTestDetail, setRagTestDetail] = useState('')

  useEffect(() => {
    if (ragEditingApiKey) {
      ragApiKeyInputRef.current?.focus()
    }
  }, [ragEditingApiKey])

  /** 切换 RAG 服务商时自动填充默认值和地址 */
  const handleRagProviderChange = (provider: RagProvider) => {
    const defaults: Record<string, { endpoint: string; embeddingModel: string }> = {
      bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', embeddingModel: 'embedding-3' },
    }
    const d = defaults[provider]
    onChange({ provider, endpoint: d.endpoint, embeddingModel: d.embeddingModel })
  }

  /** 当前 RAG 服务商的 API Key */
  const currentRagApiKey = getRagApiKey(config)

  /** 更新 RAG API Key */
  const handleRagApiKeyChange = (value: string) => {
    onChange({ bigmodelApiKey: value || undefined })
  }

  /** 测试 RAG Embedding 连接 */
  const handleTestRag = async () => {
    const apiKey = currentRagApiKey
    if (!apiKey) {
      setRagTestStatus('error')
      setRagTestDetail('请先填写 API Key')
      return
    }
    setRagTestStatus('testing')
    setRagTestDetail('')
    try {
      const { aiApi } = await import('@/lib/tauri-bridge')
      const result = await aiApi.testRagConnection(config.endpoint, apiKey, config.embeddingModel)
      setRagTestStatus(result.ok ? 'connected' : 'error')
      setRagTestDetail(result.detail)
    } catch (err) {
      setRagTestStatus('error')
      setRagTestDetail(String(err))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">RAG 检索</h2>
        {/* 启用/禁用开关 */}
        <button
          onClick={() => onChange({ enabled: !config.enabled })}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
            config.enabled ? 'bg-primary' : 'bg-muted-foreground/25'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition-transform ${
              config.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        {config.enabled
          ? '开启后 AI 对话将自动检索相关上下文，提升回答质量。'
          : '关闭后 AI 对话不检索章节背景。'}
      </p>

      {config.enabled && (
        <>
          {/* 服务商选择 */}
          <div className="space-y-1">
            <label className="text-sm font-medium">服务商</label>
            <p className="text-xs text-muted-foreground mb-1">DeepSeek 暂不支持 Embeddings API，目前仅提供智谱 BigModel</p>
            <select
              value={config.provider}
              onChange={(e) => handleRagProviderChange(e.target.value as RagProvider)}
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="bigmodel">智谱 BigModel</option>
            </select>
          </div>

          {/* API 地址（根据服务商自动填充） */}
          <div className="space-y-1">
            <label className="text-sm font-medium">API 地址</label>
            <p className="text-xs text-muted-foreground mb-1">根据所选服务商自动填充，暂不支持修改</p>
            <input
              value={config.endpoint}
              readOnly
              className="w-full bg-muted/50 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed opacity-60"
              placeholder="https://open.bigmodel.cn/api/paas/v4"
            />
          </div>

          {/* Embedding 模型选择 */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Embedding 模型</label>
            <select
              value={config.embeddingModel}
              onChange={(e) => onChange({ embeddingModel: e.target.value })}
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {RAG_BIGMODEL_MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div className="space-y-1">
            <label className="text-sm font-medium">API Key</label>
            <p className="text-xs text-muted-foreground mb-1">留空则复用对话设置的智谱 API Key</p>
            {ragEditingApiKey ? (
              <input
                ref={ragApiKeyInputRef}
                type="password"
                value={currentRagApiKey ?? ''}
                onChange={(e) => handleRagApiKeyChange(e.target.value)}
                onBlur={() => setRagEditingApiKey(false)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setRagEditingApiKey(false) }}
                className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="填写智谱 API Key（可选，留空则复用对话 Key）"
              />
            ) : (
              <button
                onClick={() => setRagEditingApiKey(true)}
                className="w-full bg-muted rounded-lg px-3 py-2 text-sm text-left font-mono flex items-center justify-between group hover:bg-muted/80 transition-colors"
                title="点击编辑 API Key"
              >
                <span className={currentRagApiKey ? 'text-foreground tracking-wider' : 'text-muted-foreground'}>
                  {currentRagApiKey ? maskApiKeyStr(currentRagApiKey) : '填写智谱 API Key（可选，留空则复用对话 Key）'}
                </span>
                <span className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors text-xs">
                  ✎
                </span>
              </button>
            )}
          </div>

          {/* 测试 RAG Embedding 连接 */}
          <div className="space-y-2">
            <button
              onClick={handleTestRag}
              disabled={ragTestStatus === 'testing'}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <BrainIcon className={`w-4 h-4 ${ragTestStatus === 'testing' ? 'animate-pulse' : ''}`} />
              {ragTestStatus === 'testing' ? '检测中…' : '测试 RAG 连接'}
            </button>

            {ragTestStatus !== 'idle' && (
              <div
                className={`flex items-start gap-2 p-3 rounded-lg text-sm ${
                  ragTestStatus === 'connected'
                    ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                    : ragTestStatus === 'error'
                      ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                      : 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
                }`}
              >
                {ragTestStatus === 'connected' ? (
                  <CircleCheckIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                ) : ragTestStatus === 'error' ? (
                  <CircleAlertIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                ) : (
                  <RefreshCwIcon className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" />
                )}
                <p className="whitespace-pre-wrap text-xs">{ragTestDetail}</p>
              </div>
            )}
          </div>
        </>
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
  onFontFamilyChange: (f: 'simhei' | 'simsun' | 'kaiti' | 'yahei') => void
  onFontSizeChange: (s: number) => void
  onGridSizeChange: (s: 'small' | 'medium' | 'large') => void
}) {
  const fontOptions = [
    { value: 'yahei', label: '微软雅黑' },
    { value: 'simhei', label: '黑体' },
    { value: 'simsun', label: '宋体' },
    { value: 'kaiti', label: '楷体' },
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
