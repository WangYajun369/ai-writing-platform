/**
 * RAG Embedding 配置子区块（预留能力）—— 使用智谱 BigModel Embeddings API
 *
 * 说明：向量索引/语义检索尚未接入对话。当前对话上下文由 Agent 引擎通过
 * 内置工具检索章节与世界观卡片（全文搜索）提供，无需向量索引。
 * 此处仅保留连接配置与连通性测试，供未来接入语义检索使用。
 */
import { useState } from 'react'
import { BrainIcon } from 'lucide-react'
import type { RagConfig, RagProvider } from '@/types'
import { getRagApiKey } from '@/types'
import { RAG_PROVIDER_DEFAULTS, RAG_BIGMODEL_MODELS } from './constants'
import { ApiKeyField, ConnectionStatusBadge, ConnectionStatus } from './shared'

interface RagConfigSectionProps {
  config: RagConfig
  onChange: (c: Partial<RagConfig>) => void
}

export function RagConfigSection({ config, onChange }: RagConfigSectionProps) {
  const [ragTestStatus, setRagTestStatus] = useState<ConnectionStatus>('idle')
  const [ragTestDetail, setRagTestDetail] = useState('')

  const handleProviderChange = (provider: RagProvider) => {
    const d = RAG_PROVIDER_DEFAULTS[provider]
    onChange({ provider, endpoint: d.endpoint, embeddingModel: d.embeddingModel })
  }

  const handleApiKeyChange = (value: string) => {
    onChange({ bigmodelApiKey: value || undefined })
  }

  const currentRagApiKey = getRagApiKey(config)

  const handleTestRag = async () => {
    if (!currentRagApiKey) {
      setRagTestStatus('error')
      setRagTestDetail('请先填写 API Key')
      return
    }
    setRagTestStatus('testing')
    setRagTestDetail('')
    try {
      const { aiApi } = await import('@/lib/tauri-bridge')
      const result = await aiApi.testRagConnection(config.endpoint, currentRagApiKey, config.embeddingModel)
      setRagTestStatus(result.ok ? 'connected' : 'error')
      setRagTestDetail(result.detail)
    } catch (err) {
      setRagTestStatus('error')
      setRagTestDetail(String(err))
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">语义检索（预留）</h2>
      <p className="text-xs text-muted-foreground -mt-2">
        向量索引与语义检索尚未接入对话。当前对话已由 Agent 引擎通过内置工具
        自动检索章节与世界观资料，无需配置此项；此处仅供连接测试与未来接入使用。
      </p>
      <p className="text-xs text-muted-foreground">
        DeepSeek 不提供 Embeddings API，向量服务使用智谱 BigModel
      </p>

      {/* 服务商 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">服务商</label>
        <select
          value={config.provider}
          onChange={(e) => handleProviderChange(e.target.value as RagProvider)}
          className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="bigmodel">智谱 BigModel</option>
        </select>
      </div>

      {/* API 地址 */}
      <div className="space-y-1">
        <label className="text-sm font-medium">API 地址</label>
        <input
          value={config.endpoint}
          readOnly
          className="w-full bg-muted/50 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed opacity-60"
          placeholder="https://open.bigmodel.cn/api/paas/v4"
        />
      </div>

      {/* Embedding 模型 */}
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
      <ApiKeyField
        label="API Key"
        hint="使用智谱 BigModel API Key（用于 Embedding），可在 https://open.bigmodel.cn 获取"
        value={currentRagApiKey}
        placeholder="填写智谱 API Key"
        onChange={handleApiKeyChange}
      />

      {/* 测试连接 */}
      <div className="space-y-2">
        <button
          onClick={handleTestRag}
          disabled={ragTestStatus === 'testing'}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <BrainIcon className={`w-4 h-4 ${ragTestStatus === 'testing' ? 'animate-pulse' : ''}`} />
          {ragTestStatus === 'testing' ? '检测中…' : '测试向量服务连接'}
        </button>
        <ConnectionStatusBadge status={ragTestStatus} detail={ragTestDetail} />
      </div>
    </div>
  )
}
