/**
 * Agent 模式输入区域
 */
import { memo } from 'react'
import { SendIcon, Loader2Icon } from 'lucide-react'
import type { AgentStatus, SkillType } from '@/components/agent/types'
import { SKILLS } from '@/components/agent/types'

interface AgentInputAreaProps {
  input: string
  onChange: (v: string) => void
  onSend: () => void
  isStreaming: boolean
  agentStatus: AgentStatus
  selectedSkill: SkillType
  onCancel: () => void
}

export const AgentInputArea = memo(function AgentInputArea({
  input, onChange, onSend, isStreaming, agentStatus, selectedSkill, onCancel,
}: AgentInputAreaProps) {
  const selectedSkillMeta = SKILLS.find((s) => s.type === selectedSkill)
  const disabled = agentStatus !== 'running'
  return (
    <div className="px-3 py-3 border-t shrink-0">
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          placeholder={disabled ? '请先启动 Agent 服务…' : `输入指令，${selectedSkillMeta?.label ?? ''}模式…`}
          rows={2}
          className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none disabled:opacity-50"
          disabled={disabled || isStreaming}
        />
        {isStreaming ? (
          <button
            onClick={onCancel}
            className="self-end px-3 py-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 text-xs font-medium transition-colors"
          >
            停止
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!input.trim() || disabled}
            className="self-end p-2.5 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {isStreaming ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <SendIcon className="w-4 h-4" />}
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Enter 发送 · Shift+Enter 换行
      </p>
    </div>
  )
})
