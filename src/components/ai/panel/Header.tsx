/**
 * Header — AI 助手 / Agent 助手头部
 *
 * 包含模式切换标签、连接状态、模型可用性检测、技能选择器、清空按钮。
 */
import { memo } from 'react'
import {
  BotIcon, Trash2Icon, MessageSquareIcon, SparklesIcon, BrainIcon, DownloadIcon, FileJsonIcon, FileTextIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SkillType } from '@/components/agent/types'
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
  /** Agent 记忆面板相关 */
  showMemory: boolean
  onToggleMemory: () => void
  /** AI 对话导出（Phase 4 问题 25；仅聊天模式） */
  exportOpen?: boolean
  onExportToggle?: () => void
  onExportFormat?: (format: 'markdown' | 'json') => void
}

/** 导出菜单项 */
function ExportMenuItem({
  icon, label, onClick,
}: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left hover:bg-muted transition-colors"
    >
      {icon}
      {label}
    </button>
  )
}

export const Header = memo(function Header({
  mode, onModeChange,
  providerLabel, modelName,
  modelCheckStatus, modelCheckDetail, onCheckModel,
  statusKey,
  selectedSkill, onSkillChange,
  onClear,
  showMemory, onToggleMemory,
  exportOpen, onExportToggle, onExportFormat,
}: HeaderProps) {
  const StatusIcon = STATUS_CONFIG[statusKey].icon
  const statusColor = STATUS_CONFIG[statusKey].color
  const statusLabel = STATUS_CONFIG[statusKey].label

  // Agent 已迁移为 Rust 原生实现：状态栏恒为「已连接」，tooltip 说明模型服务状态
  const tooltipText = statusKey === 'connected'
    ? `${providerLabel} · 模型服务就绪（Rust 内置 Agent）`
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
          {/* Agent 模式下的记忆按钮 */}
          {mode === 'agent' && (
            <button
              onClick={onToggleMemory}
              title="Agent 记忆管理"
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                showMemory
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <BrainIcon className="w-3 h-3" />
              <span>记忆</span>
            </button>
          )}
          {/* AI 对话导出（仅聊天模式；Phase 4 问题 25） */}
          {mode === 'chat' && (
            <div className="relative">
              <button
                onClick={onExportToggle}
                title="导出 AI 对话（Markdown / JSON）"
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-muted text-muted-foreground text-xs transition-colors"
              >
                <DownloadIcon className="w-3 h-3" />
                <span>导出</span>
              </button>
              {exportOpen && (
                <>
                  {/* 点击外部关闭 */}
                  <div className="fixed inset-0 z-10" onClick={onExportToggle} />
                  <div className="absolute right-0 top-full z-20 mt-1 rounded-md border bg-popover text-popover-foreground shadow-md p-1 min-w-32">
                    <ExportMenuItem
                      icon={<FileTextIcon className="w-3.5 h-3.5" />}
                      label="Markdown (.md)"
                      onClick={() => onExportFormat?.('markdown')}
                    />
                    <ExportMenuItem
                      icon={<FileJsonIcon className="w-3.5 h-3.5" />}
                      label="JSON (.json)"
                      onClick={() => onExportFormat?.('json')}
                    />
                  </div>
                </>
              )}
            </div>
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
