/**
 * Chat 配置子区块 —— DeepSeek 服务商 / 模型 / Temperature / API Key / 连接测试
 * 当前仅支持 DeepSeek，后期扩展其他服务商时重新开放服务商选择器
 *
 * 偏好存取：config 由父级传入（SettingsPage ← useAiStore.aiConfig.chat），
 * onChange 仅回传局部变更；aiStore 侧默认值见 aiStore（provider deepseek、
 * model deepseek-flash、temperature 0.7、maxTokens 131072、thinkingEnabled、
 * contextWindowSize 10）。连接测试回调由 SettingsPage 动态 import aiApi.testConnection。
 */
import { useMemo, useState } from 'react'
import { ZapIcon, RefreshCwIcon } from 'lucide-react'
import type { AiChatConfig } from '@/types'
import { getChatApiKey } from '@/types'
import { DEEPSEEK_MODELS } from './constants'
import { useAiStore } from '@/stores/aiStore'
import { ApiKeyField, ConnectionStatusBadge, ConnectionStatus, StaticInfoRow, Toggle } from './shared'

/** 最大输出 Token 的合法区间与推荐值（推荐值与后端默认值 131072 一致） */
const MAX_TOKENS_MIN = 1
const MAX_TOKENS_MAX = 262144
const MAX_TOKENS_RECOMMENDED = 131072

/** 解析最大 Token 输入：整数化并收敛到合法区间；非法输入回退到推荐值 */
function parseMaxTokens(raw: string): number {
  const parsed = parseInt(raw, 10)
  if (!Number.isInteger(parsed)) return MAX_TOKENS_RECOMMENDED
  return Math.min(MAX_TOKENS_MAX, Math.max(MAX_TOKENS_MIN, parsed))
}

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
  const handleApiKeyChange = (value: string) => {
    onChange({ deepseekApiKey: value || undefined })
  }

  const currentApiKey = getChatApiKey(config)

  // 已拉取的可用模型（来自 ai_models 配置段；空时 fallback 到内置 DEEPSEEK_MODELS）
  const availableModels = useAiStore((s) => s.availableModels)
  const modelsFetchedAt = useAiStore((s) => s.modelsFetchedAt)
  const fetchModels = useAiStore((s) => s.fetchModels)

  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const modelOptions = useMemo(() => {
    const base = availableModels.length > 0
      ? availableModels.map((m) => ({
          value: m.id,
          label: m.name ? `${m.name}（${m.id}）` : m.id,
        }))
      : DEEPSEEK_MODELS.map((m) => ({ value: m, label: m }))
    // 保证当前选中值一定在下拉中可见（例如旧配置里的旧模型名尚未被新拉取列表覆盖）
    if (!base.some((o) => o.value === config.model)) {
      base.unshift({ value: config.model, label: `${config.model}（当前）` })
    }
    return base
  }, [availableModels, config.model])

  const handleFetchModels = async () => {
    setFetching(true)
    setFetchError(null)
    try {
      await fetchModels()
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
    }
  }

  const formatFetchedAt = (iso: string) =>
    new Date(iso).toLocaleString('zh-CN', { hour12: false })

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">AI 对话</h2>

      {/* 服务商（当前仅支持 DeepSeek，以静态行呈现，避免伪装成可选项） */}
      <StaticInfoRow
        label="服务商"
        value="DeepSeek"
        hint="当前仅支持 DeepSeek，后续将扩展更多服务商"
      />

      {/* API 地址（由服务商决定，不可修改） */}
      <StaticInfoRow label="API 地址" value={config.endpoint} />

      {/* 对话模型 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">对话模型</label>
        <select
          value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* 获取全部模型：调用 DeepSeek /models，结果持久化到 ai_models 配置段 */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={handleFetchModels}
            disabled={fetching}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            <RefreshCwIcon className={`w-3.5 h-3.5 ${fetching ? 'animate-spin' : ''}`} />
            {fetching ? '获取中…' : '获取全部模型'}
          </button>
          {modelsFetchedAt && availableModels.length > 0 && (
            <span className="text-xs text-muted-foreground">
              已获取 {availableModels.length} 个模型 · {formatFetchedAt(modelsFetchedAt)}
            </span>
          )}
        </div>
        {fetchError && (
          <p className="text-xs text-destructive">{fetchError}</p>
        )}
        <p className="text-xs text-muted-foreground">
          未获取时显示内置可选项；点击「获取全部模型」从服务商拉取最新列表
        </p>
      </div>

      {/* 思考模式 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">思考模式</label>
        <div className="flex items-start justify-between gap-4 mt-1">
          <p className="text-xs text-muted-foreground">
            启用后，模型会先进行深度推理再输出回答，思考过程可在 AI 助手中查看
          </p>
          <Toggle
            enabled={config.thinkingEnabled}
            onChange={(value) => onChange({ thinkingEnabled: value })}
          />
        </div>
      </div>

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
          min={MAX_TOKENS_MIN}
          max={MAX_TOKENS_MAX}
          step={1024}
          value={config.maxTokens}
          onChange={(e) => onChange({ maxTokens: parseMaxTokens(e.target.value) })}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          1 万汉字约需 15000 tokens。推理模型的思考过程也计入此上限，建议设置 ≥ {MAX_TOKENS_RECOMMENDED}。
        </p>
      </div>

      {/* 上下文窗口大小 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">上下文窗口轮数: {config.contextWindowSize ?? 10}</label>
        <input
          type="range"
          min={1} max={50} step={1}
          value={config.contextWindowSize ?? 10}
          onChange={(e) => onChange({ contextWindowSize: Math.max(1, parseInt(e.target.value) || 10) })}
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">
          保留最近 N 轮对话（每轮 = 提问 + 回答），超出部分自动压缩为摘要注入 system prompt。较小的值节省 token，较大的值保留更多上下文。
        </p>
      </div>

      {/* API Key */}
      <ApiKeyField
        label="API Key"
        hint="使用 DeepSeek API Key，可在 https://platform.deepseek.com 获取"
        value={currentApiKey}
        placeholder="填写 DeepSeek API Key"
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
