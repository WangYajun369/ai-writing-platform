import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftIcon, BotIcon, PaletteIcon, DatabaseIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'

type Tab = 'ai' | 'appearance' | 'storage'

export default function SettingsPage() {
  const navigate = useNavigate()
  const { aiConfig, setAiConfig, theme, setTheme } = useAppStore()
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
            <AppearanceSection theme={theme} onChange={setTheme} />
          )}
          {activeTab === 'storage' && (
            <StorageSection />
          )}
        </div>
      </div>
    </div>
  )
}

// ==================== AI 配置 ====================
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

// ==================== 外观 ====================
function AppearanceSection({
  theme,
  onChange,
}: {
  theme: string
  onChange: (t: 'light' | 'dark' | 'system') => void
}) {
  return (
    <div className="space-y-5">
      <h2 className="text-base font-semibold">外观设置</h2>
      <div className="space-y-2">
        <label className="text-sm font-medium">主题</label>
        <div className="flex gap-3">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              onClick={() => onChange(t)}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                theme === t ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
              }`}
            >
              {{ light: '浅色', dark: '深色', system: '跟随系统' }[t]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ==================== 存储 ====================
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
