/**
 * Chat 配置子区块 —— 服务商 / 模型 / Temperature / API Key / 连接测试
 */
import { ZapIcon } from 'lucide-react'
import type { AiChatConfig } from '@/types'
import { getChatApiKey } from '@/types'
import { BIGMODEL_MODELS, DEEPSEEK_MODELS, PROVIDER_DEFAULTS } from './constants'
import { ApiKeyField, ConnectionStatusBadge, ConnectionStatus } from './shared'

interface ChatConfigSectionProps {
  config: AiChatConfig
  onChange: (c: Partial<AiChatConfig>) => void
  connectionStatus: ConnectionStatus
  connectionDetail: string
  onTestConnection: (endpoint: string, apiKey?: string) => Promise<void>
}

export function ChatConfigSection({
  config,
  onChange,
  connectionStatus,
  connectionDetail,
  onTestConnection,
}: ChatConfigSectionProps) {
  const handleProviderChange = (provider: typeof config.provider) => {
    const d = PROVIDER_DEFAULTS[provider]
    onChange({ provider, endpoint: d.endpoint, model: d.model })
  }

  const handleApiKeyChange = (value: string) => {
    if (config.provider === 'bigmodel') {
      onChange({ bigmodelApiKey: value || undefined })
    } else {
      onChange({ deepseekApiKey: value || undefined })
    }
  }

  const currentApiKey = getChatApiKey(config)
  const models = config.provider === 'deepseek' ? DEEPSEEK_MODELS : BIGMODEL_MODELS

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

      {/* API 地址 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">API 地址</label>
        <p className="text-xs text-muted-foreground mb-1">根据所选服务商自动填充，暂不支持修改</p>
        <input
          value={config.endpoint}
          readOnly
          className="w-full bg-muted/50 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed opacity-60"
          placeholder={PROVIDER_DEFAULTS[config.provider]?.endpoint}
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
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* 思考模式（仅 DeepSeek） */}
      {config.provider === 'deepseek' && (
        <div className="space-y-1">
          <label className="text-sm font-medium">思考模式</label>
          <p className="text-xs text-muted-foreground">
            启用后，模型会先进行深度推理再输出回答，思考过程可在 AI 助手中查看
          </p>
          <div className="flex gap-3 mt-1">
            {([true, false] as const).map((value) => (
              <button
                key={String(value)}
                onClick={() => onChange({ thinkingEnabled: value })}
                className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                  config.thinkingEnabled === value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80'
                }`}
              >
                {value ? '启用' : '禁用'}
              </button>
            ))}
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

      {/* 上下文窗口大小 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">上下文窗口轮数: {config.contextWindowSize ?? 10}</label>
        <input
          type="range"
          min={1} max={50} step={1}
          value={config.contextWindowSize ?? 10}
          onChange={(e) => onChange({ contextWindowSize: parseInt(e.target.value) || 10 })}
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">
          保留最近 N 轮对话（每轮 = 提问 + 回答），超出部分自动压缩为摘要注入 system prompt。较小的值节省 token，较大的值保留更多上下文。
        </p>
      </div>

      {/* API Key */}
      <ApiKeyField
        label="API Key"
        hint="每个服务商的 API Key 独立保存，切换服务商不会丢失"
        value={currentApiKey}
        placeholder={config.provider === 'bigmodel' ? '填写智谱 API Key' : '填写 DeepSeek API Key'}
        onChange={handleApiKeyChange}
      />

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
        <ConnectionStatusBadge status={connectionStatus} detail={connectionDetail} />
      </div>
    </div>
  )
}
