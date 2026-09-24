/**
 * AI 配置区块 —— 对话与 RAG 解耦
 *
 * 纯组合容器：分别渲染 ChatConfigSection 与 RagConfigSection，并把子区块的
 * 局部变更合并回外层 AiConfig（不可变更新）。
 * 数据来源：config 由 SettingsPage 传入 useAiStore 的 aiConfig；
 * onChange 冒泡回 setAiConfig 持久化。config.chat/rag 缺失时给出降级提示。
 */
import type { AiConfig, AiChatConfig, RagConfig } from '@/types'
import { ChatConfigSection } from './ChatConfigSection'
import { RagConfigSection } from './RagConfigSection'
import { ConnectionStatus } from './shared'

interface AiConfigSectionProps {
  config: AiConfig
  onChange: (c: Partial<AiConfig>) => void
  connectionStatus: ConnectionStatus
  connectionDetail: string
  onTestConnection: (endpoint: string, apiKey?: string) => Promise<void>
}

export function AiConfigSection({
  config,
  onChange,
  connectionStatus,
  connectionDetail,
  onTestConnection,
}: AiConfigSectionProps) {
  if (!config.chat || !config.rag) {
    return <div className="p-4 text-sm text-muted-foreground">AI 配置数据异常，请尝试清除浏览器缓存后重试。</div>
  }

  return (
    <div className="space-y-6">
      <ChatConfigSection
        config={config.chat}
        onChange={(partial) => onChange({ chat: { ...config.chat, ...partial } as AiChatConfig })}
        connectionStatus={connectionStatus}
        connectionDetail={connectionDetail}
        onTestConnection={onTestConnection}
      />

      <hr className="border-border/40" />

      <RagConfigSection
        config={config.rag}
        onChange={(partial) => onChange({ rag: { ...config.rag, ...partial } as RagConfig })}
      />
    </div>
  )
}
