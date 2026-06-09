/**
 * 消息气泡组件
 */
import { memo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAtomValue } from 'jotai'
import { Loader2Icon, ClipboardPasteIcon, InfoIcon, Trash2Icon, SettingsIcon, ChevronDownIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { editorInstanceAtom } from '@/stores/uiAtoms'
import type { AiMessage, ChatRequestPayload } from '@/types'

interface MessageBubbleProps {
  message: AiMessage
  onDelete: (id: string) => void
  onShowDetail: (payload: ChatRequestPayload) => void
}

export const MessageBubble = memo(function MessageBubble({ message, onDelete, onShowDetail }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const isError = !isUser && message.content.startsWith('⚠️')
  const hasPayload = !isUser && !!message.requestPayload
  const isSummarizing = message.isSummarizing || message.phase === 'summarizing'
  const hasChapterSummary = message.requestPayload?.chapterSummary
  const navigate = useNavigate()
  const editor = useAtomValue(editorInstanceAtom)

  // 计算有效用量
  const contentCharCount = message.content.length
  const effectiveUsage = message.usage
    ? {
        inputTokens: message.usage.inputTokens,
        outputTokens: message.usage.outputTokens,
        inputChars: message.usage.inputChars > 0 ? message.usage.inputChars : contentCharCount,
        outputChars: message.usage.outputChars > 0 ? message.usage.outputChars : contentCharCount,
      }
    : null

  const hasThinking = message.thinking.length > 0
  const isThinkingPhase = message.phase === 'thinking'
  const isLoading = message.loading && !message.content && !hasThinking && !isSummarizing

  const handleInsertToEditor = () => {
    if (!editor || !message.content) return
    editor.chain().focus().insertContent(message.content).run()
  }

  return (
    <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm wrap',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap'
            : 'bg-muted text-foreground rounded-bl-sm markdown-body'
        )}
      >
        {/* 章节总结阶段 */}
        {isSummarizing && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="w-3 h-3 animate-spin" />
            正在总结章节内容…
          </span>
        )}

        {/* 初始加载状态 */}
        {isLoading && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="w-3 h-3 animate-spin" />
            思考中…
          </span>
        )}

        {/* 章节总结信息（可折叠） */}
        {!isUser && hasChapterSummary && !isSummarizing && (
          <ChapterSummarySection
            summary={hasChapterSummary}
            expanded={summaryExpanded}
            onToggle={() => setSummaryExpanded(v => !v)}
          />
        )}

        {/* 深度思考过程（可折叠） */}
        {!isUser && hasThinking && !isSummarizing && (
          <ThinkingSection
            thinking={message.thinking}
            expanded={thinkingExpanded}
            isThinkingPhase={isThinkingPhase}
            onToggle={() => setThinkingExpanded(v => !v)}
          />
        )}

        {/* 正式输出标签 */}
        {!isUser && hasThinking && message.content && !isSummarizing && (
          <div className={cn(
            'text-[10px] text-muted-foreground/50 mb-1 border-t border-border/30 pt-1',
            message.phase === 'answering' && 'flex items-center gap-1'
          )}>
            {message.phase === 'answering' ? '📝 正式输出中…' : '📝 正式输出'}
          </div>
        )}

        {/* 消息内容 */}
        {isUser ? (
          message.content
        ) : message.content && !isSummarizing ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        ) : null}

        {/* 错误提示操作按钮 */}
        {isError && (
          <button
            onClick={() => navigate('/settings')}
            className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 text-xs font-medium transition-colors"
          >
            <SettingsIcon className="w-3.5 h-3.5" />
            前往设置检查
          </button>
        )}

        {/* 用量统计 */}
        {!isUser && !message.loading && effectiveUsage && (
          <UsageStats usage={effectiveUsage} />
        )}

        {/* 操作按钮 */}
        {!isUser && !isLoading && (
          <MessageActions
            hasPayload={hasPayload}
            message={message}
            confirming={confirming}
            onInsert={handleInsertToEditor}
            onShowDetail={onShowDetail}
            onDelete={() => setConfirming(true)}
            onConfirmDelete={() => onDelete(message.id)}
            onCancelDelete={() => setConfirming(false)}
          />
        )}
      </div>
    </div>
  )
})

/** 章节总结区域 */
function ChapterSummarySection({
  summary,
  expanded,
  onToggle,
}: {
  summary: NonNullable<AiMessage['requestPayload']>['chapterSummary']
  expanded: boolean
  onToggle: () => void
}) {
  if (!summary) return null
  return (
    <div className="mb-2">
      <button onClick={onToggle} className="flex items-center gap-1.5 text-[11px] mb-1 transition-colors text-blue-600 dark:text-blue-400">
        <ChevronDownIcon className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
        {expanded ? '收起章节总结' : '查看章节总结'}
        <span className="text-[10px] opacity-60">({summary.originalChars}字 → {summary.summaryChars}字)</span>
      </button>
      {expanded && (
        <div className="text-[11px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap border border-blue-200 dark:border-blue-800 rounded-lg p-2 bg-blue-50/30 dark:bg-blue-950/20">
          {summary.summary}
        </div>
      )}
    </div>
  )
}

/** 思考过程区域 */
function ThinkingSection({
  thinking,
  expanded,
  isThinkingPhase,
  onToggle,
}: {
  thinking: string
  expanded: boolean
  isThinkingPhase: boolean
  onToggle: () => void
}) {
  return (
    <div className="mb-2">
      <button
        onClick={onToggle}
        className={cn(
          'flex items-center gap-1.5 text-[11px] mb-1 transition-colors',
          isThinkingPhase ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/70'
        )}
      >
        <ChevronDownIcon className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
        {isThinkingPhase ? (
          <span className="flex items-center gap-1">
            <Loader2Icon className="w-2.5 h-2.5 animate-spin" />
            深度思考中…
          </span>
        ) : '思考过程'}
      </button>
      {expanded && (
        <div className="text-[11px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap border-l-2 border-amber-300/40 pl-2.5 py-0.5 italic">
          {thinking}
        </div>
      )}
    </div>
  )
}

/** 用量统计 */
function UsageStats({ usage }: { usage: { inputTokens: number; outputTokens: number; inputChars: number; outputChars: number } }) {
  return (
    <div className="mt-2 pt-2 border-t border-border/50 flex items-center gap-3 text-[10px] text-muted-foreground/70">
      <span title="输入 Token">↗ {usage.inputTokens} token</span>
      <span title="输出 Token">↘ {usage.outputTokens} token</span>
      <span className="text-border/30">|</span>
      <span title="输入字数">↗ {usage.inputChars} 字</span>
      <span title="输出字数">↘ {usage.outputChars} 字</span>
    </div>
  )
}

/** 消息操作按钮 */
function MessageActions({
  hasPayload,
  message,
  confirming,
  onInsert,
  onShowDetail,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  hasPayload: boolean
  message: AiMessage
  confirming: boolean
  onInsert: () => void
  onShowDetail: (payload: ChatRequestPayload) => void
  onDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  return (
    <div className="mt-2 pt-2 border-t border-border/30 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <button
          onClick={onInsert}
          className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-primary transition-colors"
          title="插入到编辑器"
        >
          <ClipboardPasteIcon className="w-3 h-3" />
          插入编辑器
        </button>
        {hasPayload && (
          <button
            onClick={() => onShowDetail(message.requestPayload!)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-primary transition-colors"
            title="查看提交给 AI 的请求详情"
          >
            <InfoIcon className="w-3 h-3" />
            详情
          </button>
        )}
      </div>
      {confirming ? (
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">确认删除？</span>
          <button onClick={onConfirmDelete} className="text-xs px-2 py-0.5 rounded bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity">
            删除
          </button>
          <button onClick={onCancelDelete} className="text-xs px-2 py-0.5 rounded bg-muted-foreground/15 text-muted-foreground hover:bg-muted-foreground/25 transition-colors">
            取消
          </button>
        </span>
      ) : (
        <button
          onClick={onDelete}
          className="flex items-center gap-1 text-[11px] text-muted-foreground/50 hover:text-destructive transition-colors"
          title="删除此轮问答"
        >
          <Trash2Icon className="w-3 h-3" />
          删除
        </button>
      )}
    </div>
  )
}
