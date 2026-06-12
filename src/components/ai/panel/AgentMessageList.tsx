/**
 * Agent 模式消息列表
 */
import { memo } from 'react'
import { BotIcon } from 'lucide-react'
import type { AgentMessage, AgentStatus, SkillType } from '@/components/agent/types'
import { SKILLS } from '@/components/agent/types'
import { AgentMessageBubble } from '@/components/agent/AgentMessageBubble'
import { getAgentQuickActions } from './constants'

interface AgentMessageListProps {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  selectedSkill: SkillType
  error: string | null
  onSelectQuick: (text: string) => void
  bottomRef: React.RefObject<HTMLDivElement | null>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}

export const AgentMessageList = memo(function AgentMessageList({
  messages, agentStatus, selectedSkill, error,
  onSelectQuick, bottomRef, scrollContainerRef,
}: AgentMessageListProps) {
  const selectedSkillMeta = SKILLS.find((s) => s.type === selectedSkill)
  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3 min-w-0">
      {messages.length === 0 && agentStatus === 'running' && (
        <div className="text-center py-8">
          <span className="text-3xl">✨</span>
          <h4 className="text-sm font-medium mt-2">你好，我是你的 AI 写作助手</h4>
          <p className="text-xs text-muted-foreground mt-1">
            当前模式：<strong style={{ color: selectedSkillMeta?.color }}>{selectedSkillMeta?.label}</strong>
          </p>
          <p className="text-xs text-muted-foreground">{selectedSkillMeta?.description}</p>
          <div className="flex flex-col gap-1.5 mt-3 max-w-[300px] mx-auto">
            {getAgentQuickActions(selectedSkill).map((action, i) => (
              <button
                key={i}
                onClick={() => onSelectQuick(action)}
                className="text-xs text-left px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 transition-colors"
              >
                {action}
              </button>
            ))}
          </div>
        </div>
      )}
      {messages.length === 0 && agentStatus !== 'running' && (
        <div className="text-center py-12 text-muted-foreground">
          <BotIcon className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-xs">请先启动 Agent 服务</p>
        </div>
      )}
      {messages.map((msg) => (
        <AgentMessageBubble key={msg.id} message={msg} />
      ))}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
          {error}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
})
