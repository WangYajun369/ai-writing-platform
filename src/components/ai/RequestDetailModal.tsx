/**
 * 请求详情弹窗组件
 */
import { XIcon, InfoIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatRequestPayload } from '@/types'

interface RequestDetailModalProps {
  payload: ChatRequestPayload
  onClose: () => void
}

export function RequestDetailModal({ payload, onClose }: RequestDetailModalProps) {
  const systemMsg = payload.messages.find((m) => m.role === 'system')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-background border rounded-xl shadow-2xl w-[90vw] max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <InfoIcon className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">提交给 AI 的请求详情</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* 弹窗内容 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 请求参数 */}
          <RequestParams params={payload} />

          {/* System Prompt */}
          {systemMsg && <SystemPromptSection content={systemMsg.content} />}

          {/* 章节总结 */}
          {payload.chapterSummary && <ChapterSummarySection summary={payload.chapterSummary} />}

          {/* RAG 检索上下文 */}
          {payload.ragContext && payload.ragContext.length > 0 && <RagContextSection context={payload.ragContext} />}

          {/* 消息列表 */}
          <MessageListSection messages={payload.messages} />
        </div>
      </div>
    </div>
  )
}

/** 请求参数 */
function RequestParams({ params }: { params: ChatRequestPayload }) {
  return (
    <div>
      <SectionTitle title="请求参数" />
      <div className="bg-muted/50 rounded-lg p-3 text-xs space-y-1.5 font-mono">
        <ParamRow label="服务商" value={params.provider} />
        <ParamRow label="模型" value={params.model} />
        <ParamRow label="Temperature" value={params.temperature} />
        <ParamRow label="MaxTokens" value={params.maxTokens} />
        {params.thinkingEnabled !== undefined && (
          <ParamRow label="思考模式" value={params.thinkingEnabled ? '已启用' : '已关闭'} />
        )}
      </div>
    </div>
  )
}

/** System Prompt 区域 */
function SystemPromptSection({ content }: { content: string }) {
  return (
    <div>
      <SectionTitle title="System Prompt" />
      <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
        <div className="px-3 py-1.5 bg-amber-100/50 dark:bg-amber-900/20 text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
          完整 System Prompt
        </div>
        <div className="px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word bg-amber-50/30 dark:bg-amber-950/20 text-foreground leading-relaxed max-h-[40vh] overflow-y-auto">
          {content || <span className="text-muted-foreground/40 italic">（空）</span>}
        </div>
      </div>
    </div>
  )
}

/** 章节总结区域 */
function ChapterSummarySection({ summary }: { summary: NonNullable<ChatRequestPayload['chapterSummary']> }) {
  return (
    <div>
      <SectionTitle title="章节总结" subtitle={`(${summary.originalChars}字 → ${summary.summaryChars}字)`} />
      <div className="border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden">
        <div className="px-3 py-1.5 bg-blue-100/50 dark:bg-blue-900/20 text-[11px] font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
          总结内容
        </div>
        <div className="px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word bg-blue-50/30 dark:bg-blue-950/20 text-foreground leading-relaxed max-h-40 overflow-y-auto">
          {summary.summary}
        </div>
        {summary.thinking && (
          <>
            <div className="px-3 py-1.5 bg-blue-100/50 dark:bg-blue-900/20 text-[11px] font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5 border-t border-blue-200 dark:border-blue-800">
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
              总结思考过程
            </div>
            <div className="px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word italic text-muted-foreground/80 leading-relaxed max-h-32 overflow-y-auto">
              {summary.thinking}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** RAG 检索上下文区域 */
function RagContextSection({ context }: { context: NonNullable<ChatRequestPayload['ragContext']> }) {
  return (
    <div>
      <SectionTitle title={`RAG 检索上下文（${context.length} 条片段）`} />
      <div className="space-y-2">
        {context.map((item, i) => (
          <div key={i} className="border border-purple-200 dark:border-purple-800 rounded-lg overflow-hidden">
            <div className="px-3 py-1.5 bg-purple-100/50 dark:bg-purple-900/20 text-[11px] font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
              片段 {i + 1}
              {item.sourceTitle && (
                <span className="text-[10px] opacity-50 font-normal">
                  · {item.sourceType === 'world_card' ? '世界观' : '章节'}「{item.sourceTitle}」
                </span>
              )}
              {item.score !== undefined && (
                <span className="ml-auto text-[10px] opacity-60 font-mono">相关度: {(item.score * 100).toFixed(1)}%</span>
              )}
            </div>
            <div className="px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word bg-purple-50/30 dark:bg-purple-950/20 text-foreground leading-relaxed max-h-40 overflow-y-auto">
              {item.snippet}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 消息列表区域 */
function MessageListSection({ messages }: { messages: ChatRequestPayload['messages'] }) {
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')
  return (
    <div>
      <SectionTitle title={`对话消息（${nonSystemMessages.length} 条）`} />
      <div className="space-y-2">
        {nonSystemMessages.map((msg, i) => (
          <div key={i} className="border rounded-lg overflow-hidden">
            <div className={cn(
              'px-3 py-1.5 text-[11px] font-semibold flex items-center gap-1.5',
              msg.role === 'user' && 'bg-blue-100/50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
              msg.role === 'assistant' && 'bg-green-100/50 dark:bg-green-900/20 text-green-700 dark:text-green-300',
            )}>
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
              {msg.role === 'user' ? '用户' : '助手'}
            </div>
            <div className="px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word max-h-48 overflow-y-auto bg-muted/30">
              {msg.content || <span className="text-muted-foreground/40 italic">（空）</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 区域标题 */
function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
      {title}
      {subtitle && <span className="ml-2 text-[10px] font-normal opacity-60">{subtitle}</span>}
    </h3>
  )
}

/** 参数行 */
function ParamRow({ label, value }: { label: string; value: string | number | boolean | undefined }) {
  return (
    <div className="flex gap-3">
      <span className="text-muted-foreground shrink-0">{label}：</span>
      <span>{value ?? '-'}</span>
    </div>
  )
}
