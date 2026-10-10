/**
 * AgentMessageList — Agent 模式消息列表
 *
 * 数据来源：useAgent 维护的 AgentMessage[]（Rust Agent 引擎流式会话），
 * 单条气泡渲染委托 @/components/agent/AgentMessageBubble（含技能/工具相关展示）。
 * 空对话且引擎 running 时，按当前技能展示问候语与快捷操作（点击写入输入框）；
 * 引擎不可用或出错时分别展示占位与错误条。滚动哨兵与容器 ref 由 AiSidePanel 注入。
 */
import { memo } from 'react'
import { BotIcon } from 'lucide-react'
import type { AgentMessage, AgentStatus } from '@/components/agent/types'
import type { ProfileMeta } from '@/types'
import { AgentMessageBubble } from '@/components/agent/AgentMessageBubble'

interface AgentMessageListProps {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  /** 当前选中的能力画像（后端下发，含快捷操作文案） */
  selectedAbility?: ProfileMeta
  /** 能力画像列表，供消息气泡把 skill id 解析为展示名 */
  abilities?: ProfileMeta[]
  error: string | null
  onSelectQuick: (text: string) => void
  bottomRef: React.RefObject<HTMLDivElement | null>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}

export const AgentMessageList = memo(function AgentMessageList({
  messages, agentStatus, selectedAbility, abilities, error,
  onSelectQuick, bottomRef, scrollContainerRef,
}: AgentMessageListProps) {
  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3 min-w-0">
      {messages.length === 0 && agentStatus === 'running' && (
        <div className="text-center py-8">
          <span className="text-3xl">✨</span>
          <h4 className="text-sm font-medium mt-2">你好，我是你的 AI 写作助手</h4>
          <p className="text-xs text-muted-foreground mt-1">
            当前模式：<strong style={{ color: selectedAbility?.color }}>{selectedAbility?.label}</strong>
          </p>
          <p className="text-xs text-muted-foreground">{selectedAbility?.description}</p>
          <div className="flex flex-col gap-1.5 mt-3 max-w-[300px] mx-auto">
            {(selectedAbility?.quickActions ?? []).map((action, i) => (
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
          <p className="text-xs">Agent 引擎暂不可用</p>
        </div>
      )}
      {messages.map((msg) => (
        <AgentMessageBubble key={msg.id} message={msg} abilities={abilities} />
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
