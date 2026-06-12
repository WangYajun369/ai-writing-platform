/**
 * ToolboxOutputPanel — 工具箱右侧输出面板
 * 包含思考过程、Markdown 渲染结果、用量统计、请求详情弹窗
 */
import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  CopyIcon,
  CheckIcon,
  Trash2Icon,
  SparklesIcon,
  InfoIcon,
  XIcon,
} from 'lucide-react'
import type { UsageInfo } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import type { GenerateStatus } from './ToolboxCenterInput'

/** 请求详情 */
export interface RequestDetail {
  systemPrompt: string
  userInput: string
  model: string
  endpoint: string
  temperature: number
  maxTokens: number
  thinkingEnabled: boolean
}

interface ToolboxOutputPanelProps {
  content: string
  thinking: string
  status: GenerateStatus
  errorMsg: string
  usage: UsageInfo | null
  copied: boolean
  onCopy: () => void
  onClear: () => void
  outputRef: React.RefObject<HTMLDivElement | null>
  thinkingRef: React.RefObject<HTMLDivElement | null>
  selectedToolName?: string
  requestDetail: RequestDetail | null
}

export function ToolboxOutputPanel({
  content,
  thinking,
  status,
  errorMsg,
  usage,
  copied,
  onCopy,
  onClear,
  outputRef,
  thinkingRef,
  selectedToolName,
  requestDetail,
}: ToolboxOutputPanelProps) {
  const isGenerating = status === 'generating'
  const hasContent = content.length > 0
  const hasThinking = thinking.length > 0
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)

  // RAF 限流滚动到底部
  useEffect(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      scrollRafRef.current = null
    })
    return () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [content, thinking])

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* 头部 */}
      <OutputHeader
        status={status}
        selectedToolName={selectedToolName}
        hasContent={hasContent}
        hasThinking={hasThinking}
        isGenerating={isGenerating}
        copied={copied}
        onCopy={onCopy}
        onClear={onClear}
        onShowDetail={() => setShowDetail(true)}
        hasRequestDetail={!!requestDetail}
      />

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3 min-h-0 min-w-0">
        {/* 思考过程 */}
        {hasThinking && (
          <ThinkingSection
            thinking={thinking}
            isGenerating={isGenerating}
            expanded={thinkingExpanded}
            onToggle={() => setThinkingExpanded((v) => !v)}
            thinkingRef={thinkingRef}
          />
        )}

        {/* 正式输出标签 */}
        {hasThinking && hasContent && (
          <div className="text-[10px] text-muted-foreground/60 font-medium">
            📝 {isGenerating ? '正式输出中…' : '正式输出'}
          </div>
        )}

        {/* 生成内容 — Markdown 渲染 */}
        {hasContent ? (
          <div
            ref={outputRef}
            className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3 min-w-0 overflow-hidden"
          >
            <div className="markdown-body text-sm min-w-0 [overflow-wrap:anywhere] [&_pre]:!whitespace-pre-wrap [&_pre]:!break-all [&_pre]:!overflow-x-hidden [&_code]:!break-all [&_table]:!block [&_table]:!max-w-full">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              {isGenerating && (
                <span className="inline-block w-2 h-4 bg-primary/60 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
              )}
            </div>
            {usage && status === 'done' && (
              <div className="mt-3 pt-2 border-t border-border/50 flex items-center gap-3 text-[10px] text-muted-foreground/50">
                <span title="输入 Token">↗ {usage.inputTokens} token</span>
                <span title="输出 Token">↘ {usage.outputTokens} token</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-40">
            <div className="text-center px-4">
              <SparklesIcon className="w-8 h-8 mx-auto mb-2 text-muted-foreground/20" />
              <p className="text-xs text-muted-foreground/50">
                {isGenerating ? '正在生成内容…' : '选择工具并输入需求，点击发送'}
              </p>
            </div>
          </div>
        )}

        {/* 错误信息 */}
        {status === 'error' && errorMsg && (
          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">
            {errorMsg}
          </div>
        )}

        {/* 滚动哨兵 */}
        <div ref={bottomRef} />
      </div>

      {/* 请求详情弹窗 */}
      {showDetail && requestDetail && (
        <OutputDetailModal detail={requestDetail} onClose={() => setShowDetail(false)} />
      )}
    </div>
  )
}

/** 输出面板头部 */
function OutputHeader({
  status,
  selectedToolName,
  hasContent,
  hasThinking,
  isGenerating,
  copied,
  onCopy,
  onClear,
  onShowDetail,
  hasRequestDetail,
}: {
  status: GenerateStatus
  selectedToolName?: string
  hasContent: boolean
  hasThinking: boolean
  isGenerating: boolean
  copied: boolean
  onCopy: () => void
  onClear: () => void
  onShowDetail: () => void
  hasRequestDetail: boolean
}) {
  return (
    <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <SparklesIcon
          className={cn(
            'w-3.5 h-3.5',
            isGenerating ? 'text-primary animate-pulse' : 'text-muted-foreground',
          )}
        />
        <span className="text-xs font-medium text-muted-foreground">
          {selectedToolName ? `${selectedToolName} · 结果` : '输出区域'}
        </span>
        {status === 'done' && (
          <span className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 px-1.5 py-0.5 rounded">
            已完成
          </span>
        )}
        {isGenerating && (
          <span className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 px-1.5 py-0.5 rounded animate-pulse">
            生成中
          </span>
        )}
        {status === 'error' && (
          <span className="text-[10px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded">
            失败
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {hasRequestDetail && (
          <button
            onClick={onShowDetail}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="查看请求详情"
          >
            <InfoIcon className="w-3.5 h-3.5" />
          </button>
        )}
        {hasContent && !isGenerating && (
          <button
            onClick={onCopy}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={copied ? '已复制' : '复制内容'}
          >
            {copied ? (
              <CheckIcon className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <CopyIcon className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {(hasContent || hasThinking || status === 'error') && (
          <button
            onClick={onClear}
            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="清空输出"
          >
            <Trash2Icon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/** 思考过程区块 */
function ThinkingSection({
  thinking,
  isGenerating,
  expanded,
  onToggle,
  thinkingRef,
}: {
  thinking: string
  isGenerating: boolean
  expanded: boolean
  onToggle: () => void
  thinkingRef: React.RefObject<HTMLDivElement | null>
}) {
  return (
    <div className="border border-amber-200 dark:border-amber-800/40 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] hover:bg-amber-50/50 dark:hover:bg-amber-950/20 transition-colors"
      >
        {expanded ? (
          <ChevronDownIcon className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="w-3 h-3 shrink-0" />
        )}
        {isGenerating ? (
          <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <Loader2Icon className="w-2.5 h-2.5 animate-spin" />
            深度思考中…
          </span>
        ) : (
          <span className="text-muted-foreground/70">思考过程</span>
        )}
      </button>
      {expanded && (
        <div
          ref={thinkingRef}
          className="px-3 pb-3 text-[11px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap border-t border-amber-200/50 dark:border-amber-800/30 italic max-h-48 overflow-y-auto overflow-x-hidden min-w-0 break-all bg-amber-50/30 dark:bg-amber-950/10"
        >
          {thinking}
        </div>
      )}
    </div>
  )
}

/** 请求详情弹窗 */
function OutputDetailModal({
  detail,
  onClose,
}: {
  detail: RequestDetail
  onClose: () => void
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[440px] max-h-[80%] bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">请求详情</h3>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">
          <DetailSection title="模型参数">
            <DetailRow label="接口地址" value={detail.endpoint} />
            <DetailRow label="模型" value={detail.model} />
            <DetailRow label="Temperature" value={String(detail.temperature)} />
            <DetailRow label="Max Tokens" value={String(detail.maxTokens)} />
            <DetailRow label="深度思考" value={detail.thinkingEnabled ? '已开启' : '未开启'} />
          </DetailSection>

          <DetailSection title="System Prompt">
            <pre className="whitespace-pre-wrap break-all text-muted-foreground/80 leading-relaxed bg-muted/50 rounded-lg p-3 max-h-32 overflow-y-auto">
              {detail.systemPrompt}
            </pre>
          </DetailSection>

          <DetailSection title="用户输入">
            <pre className="whitespace-pre-wrap break-all text-muted-foreground/80 leading-relaxed bg-muted/50 rounded-lg p-3 max-h-32 overflow-y-auto">
              {detail.userInput}
            </pre>
          </DetailSection>
        </div>
      </div>
    </div>
  )
}

/** 详情区块 */
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold text-foreground/70 mb-2">{title}</h4>
      {children}
    </div>
  )
}

/** 键值行 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-muted-foreground/60 shrink-0 min-w-[90px]">{label}</span>
      <span className="text-muted-foreground truncate">{value}</span>
    </div>
  )
}
