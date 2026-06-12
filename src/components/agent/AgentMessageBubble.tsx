/**
 * Agent 消息气泡组件
 *
 * 与 MessageBubble 保持视觉一致：统一的 Tailwind 气泡布局、
 * Markdown 渲染、流式加载提示和错误状态展示。
 */

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2Icon, ClipboardPasteIcon, Trash2Icon, CheckIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentMessage, SkillType } from './types'
import { SKILLS } from './types'

interface AgentMessageBubbleProps {
  message: AgentMessage
  onCopy?: (content: string) => void
  onDelete?: () => void
}

export const AgentMessageBubble: React.FC<AgentMessageBubbleProps> = ({ message, onCopy, onDelete }) => {
  const skillMeta = message.skill ? SKILLS.find((s) => s.type === message.skill) : null

  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const hasError = !!message.error
  const isThinking = message.isStreaming && !message.content

  const [copied, setCopied] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)

  const handleCopy = React.useCallback(() => {
    if (!message.content) return
    onCopy?.(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [message.content, onCopy])

  if (isSystem) {
    return (
      <div className="flex justify-center py-1">
        <span className="text-[11px] text-muted-foreground/60 px-3 py-1 rounded-full bg-muted/50">
          {message.content}
        </span>
      </div>
    )
  }

  return (
    <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'max-w-[98%] rounded-2xl px-3 py-2 text-sm wrap',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap'
            : 'bg-muted text-foreground rounded-bl-sm markdown-body'
        )}
      >
        {/* 思考中加载提示 */}
        {isThinking && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="w-3 h-3 animate-spin" />
            思考中…
          </span>
        )}

        {/* 技能标签（仅 assistant 消息且已指定技能时显示） */}
        {!isUser && skillMeta && (
          <div className="text-[10px] mb-1 flex items-center gap-1">
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{ backgroundColor: skillMeta.color + '20', color: skillMeta.color }}
            >
              {getSkillIcon(message.skill!)} {skillMeta.label}
            </span>
          </div>
        )}

        {/* 消息内容 */}
        {isUser ? (
          message.content
        ) : message.content && !isThinking ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        ) : null}

        {/* 流式光标 */}
        {message.isStreaming && message.content && (
          <span className="inline-block w-px h-4 bg-primary animate-pulse ml-0.5 align-middle" />
        )}

        {/* 错误信息 */}
        {hasError && (
          <div className="mt-2 pt-2 border-t border-border/30 text-[11px] text-destructive/80">
            ⚠️ {message.error}
          </div>
        )}

        {/* 操作按钮（仅 assistant 消息且非流式加载中时显示） */}
        {!isUser && !isThinking && message.content && (
          <div className="mt-2 pt-2 border-t border-border/30 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* 复制内容 */}
              <button
                onClick={handleCopy}
                disabled={copied}
                className={cn(
                  'flex items-center gap-1 text-[11px] transition-colors',
                  copied
                    ? 'text-emerald-500 cursor-default'
                    : 'text-muted-foreground/50 hover:text-primary'
                )}
                title={copied ? '已复制' : '复制内容'}
              >
                {copied ? (
                  <CheckIcon className="w-3 h-3" />
                ) : (
                  <ClipboardPasteIcon className="w-3 h-3" />
                )}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            {confirming ? (
              <span className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">确认删除？</span>
                <button
                  onClick={() => onDelete?.()}
                  className="text-xs px-2 py-0.5 rounded bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
                >
                  删除
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="text-xs px-2 py-0.5 rounded bg-muted-foreground/15 text-muted-foreground hover:bg-muted-foreground/25 transition-colors"
                >
                  取消
                </button>
              </span>
            ) : (
              onDelete && (
                <button
                  onClick={() => setConfirming(true)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-destructive transition-colors"
                  title="删除此消息"
                >
                  <Trash2Icon className="w-3 h-3" />
                  删除
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function getSkillIcon(skill: SkillType): string {
  switch (skill) {
    case 'writing':
      return '✍️'
    case 'analysis':
      return '🔍'
    case 'research':
      return '📖'
    case 'polish':
      return '✨'
  }
}
