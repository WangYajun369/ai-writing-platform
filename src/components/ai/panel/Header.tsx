/**
 * Header — AI 助手 / Agent 助手头部
 *
 * 包含模式切换标签、连接状态、模型可用性检测、技能选择器、清空按钮。
 */
import { memo } from 'react'
import {
  BotIcon, Trash2Icon, MessageSquareIcon, SparklesIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SkillType, AgentStatus } from '@/components/agent/types'
import { SKILLS } from '@/components/agent/types'
import { STATUS_CONFIG, type StatusKey } from './constants'
import { ModelCheckIcon } from './ModelCheckIcon'

interface HeaderProps {
  mode: 'chat' | 'agent'
  onModeChange: (m: 'chat' | 'agent') => void
  providerLabel: string
  modelName: string
  modelCheckStatus: 'idle' | 'checking' | 'ok' | 'error'
  modelCheckDetail: string
  onCheckModel: () => void
  statusKey: StatusKey
  selectedSkill: SkillType
  onSkillChange: (skill: SkillType) => void
  onClear: () => void
  agentStatus: AgentStatus
  onStartAgent: () => void
  onStopAgent: () => void
}

export const Header = memo(function Header({
  mode, onModeChange,
  providerLabel, modelName,
  modelCheckStatus, modelCheckDetail, onCheckModel,
  statusKey,
  selectedSkill, onSkillChange,
  onClear, agentStatus, onStartAgent, onStopAgent,
}: HeaderProps) {
  const StatusIcon = STATUS_CONFIG[statusKey].icon
  const statusColor = STATUS_CONFIG[statusKey].color
  const statusLabel = STATUS_CONFIG[statusKey].label

  const tooltipText = statusKey === 'error'
    ? 'Agent 服务异常，请重启应用'
    : statusKey === 'idle'
      ? `${providerLabel} · ${statusLabel}`
      : statusKey === 'testing'
        ? '正在启动 Agent…'
        : `${providerLabel} · ${statusLabel}`

  return (
    <div className="px-3 py-2 border-b shrink-0 space-y-2">
      {/* 模式切换标签 */}
      <div className="flex bg-muted rounded-lg p-0.5">
        <ModeTab active={mode === 'chat'} onClick={() => onModeChange('chat')} icon={<MessageSquareIcon className="w-3.5 h-3.5" />} label="AI 聊天" />
        <ModeTab active={mode === 'agent'} onClick={() => onModeChange('agent')} icon={<SparklesIcon className="w-3.5 h-3.5" />} label="Agent 助手" />
      </div>

      {/* 状态栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BotIcon className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {mode === 'agent' ? 'Agent 助手' : 'AI 助手'}
          </span>
          <span title={tooltipText} className="flex items-center gap-1 rounded px-1 py-0.5">
            <StatusIcon className={cn('w-3 h-3', statusColor)} />
            <span className={cn('text-[10px]',
              statusKey === 'connected' ? 'text-green-600 dark:text-green-400' :
              statusKey === 'error' ? 'text-red-600 dark:text-red-400' :
              'text-muted-foreground/70',
            )}>
              {providerLabel}
            </span>
          </span>
          {/* 模型名 — 可点击检测可用性 */}
          <button
            onClick={(e) => { e.stopPropagation(); onCheckModel() }}
            title={
              modelCheckStatus === 'ok' ? `模型可用：${modelCheckDetail}` :
              modelCheckStatus === 'error' ? `模型不可用：${modelCheckDetail}` :
              '点击检测模型是否可用'
            }
            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted/80 transition-colors cursor-pointer"
          >
            <ModelCheckIcon status={modelCheckStatus} />
            <span className={cn('text-[10px] max-w-[120px] truncate',
              modelCheckStatus === 'ok' ? 'text-green-600 dark:text-green-400' :
              modelCheckStatus === 'error' ? 'text-red-600 dark:text-red-400' :
              'text-muted-foreground/70',
            )}>
              {modelName}
            </span>
          </button>
        </div>
        <div className="flex items-center gap-1">
          {/* Agent 模式下的启停按钮 */}
          {mode === 'agent' && (
            agentStatus === 'stopped' || agentStatus === 'crashed' ? (
              <button
                onClick={onStartAgent}
                title="启动 Agent 服务"
                className="px-2 py-0.5 rounded text-[10px] bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                启动
              </button>
            ) : (
              <button
                onClick={onStopAgent}
                title="停止 Agent 服务"
                className="px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:bg-muted transition-colors"
              >
                停止
              </button>
            )
          )}
          <button
            onClick={onClear}
            title={mode === 'agent' ? '清空Agent对话' : '清空AI聊天记录'}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground text-xs transition-colors"
          >
            <Trash2Icon className="w-3 h-3" />
            <span>清空</span>
          </button>
        </div>
      </div>

      {/* 技能选择器 */}
      <div className="flex gap-1">
        {SKILLS.map((skill) => (
          <button
            key={skill.type}
            onClick={() => onSkillChange(skill.type)}
            title={skill.description}
            className={cn('text-[10px] px-2 py-0.5 rounded-full transition-colors',
              selectedSkill === skill.type
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50',
            )}
          >
            {skill.label}
          </button>
        ))}
      </div>
    </div>
  )
})

/** 模式切换标签按钮 */
function ModeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
