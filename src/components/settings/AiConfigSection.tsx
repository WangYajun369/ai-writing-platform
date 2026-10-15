/**
 * AI 配置区块 —— 对话配置
 *
 * 组合容器：渲染 ChatConfigSection，并把子区块的局部变更合并回外层
 * AiConfig（不可变更新）。
 * 数据来源：config 由 SettingsPage 传入 useAiStore 的 aiConfig；
 * onChange 冒泡回 setAiConfig 持久化。config.chat 缺失时给出降级提示。
 *
 * 注：语义检索（RAG/Embedding）区块已从设置页移除，仅保留后端命令与
 * 配置项（未接入对话），待未来接入时再恢复入口。
 */
import type { AiConfig } from '@/types'
import { ChatConfigSection } from './ChatConfigSection'
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
  if (!config.chat) {
    return <div className="p-4 text-sm text-muted-foreground">AI 配置数据异常，请在「版本」页重新初始化配置，或重启应用后重试。</div>
  }

  return (
    <div className="space-y-6">
      <ChatConfigSection
        config={config.chat}
        onChange={(partial) => onChange({ chat: { ...config.chat, ...partial } })}
        connectionStatus={connectionStatus}
        connectionDetail={connectionDetail}
        onTestConnection={onTestConnection}
      />
    </div>
  )
}
