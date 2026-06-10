/**
 * AiSidePanel — AI 助手侧面板
 *
 * 支持多服务商流式对话（智谱 BigModel / 自定义），
 * 自动 RAG 检索当前书籍上下文。
 * 流式调用由 Rust 侧通过 reqwest 处理，前端通过 Tauri 事件接收增量。
 *
 * 对话记录以当前作品（bookId）为维度持久化到 localStorage，
 * 切换作品时自动加载对应对话历史。
 */
import { useState, useRef, useEffect, useCallback, memo } from 'react'
import {
  SendIcon, BotIcon, Trash2Icon, Loader2Icon, CircleCheckIcon,
  CircleAlertIcon, CircleIcon, DatabaseZapIcon, RefreshCwIcon,
} from 'lucide-react'
import { useAppStore, useCurrentAiMessages } from '@/stores/appStore'
import { cn } from '@/lib/utils'
import type { ChatRequestPayload } from '@/types'
import { useAiChat, PROVIDER_LABELS, QUICK_HINTS } from './useAiChat'
import { MessageBubble } from './MessageBubble'
import { RequestDetailModal } from './RequestDetailModal'

/** 连接状态配置 */
const STATUS_CONFIG = {
  idle: { icon: CircleIcon, color: 'text-muted-foreground/50', label: '未检测' },
  testing: { icon: Loader2Icon, color: 'text-blue-500 animate-spin', label: '检测中…' },
  connected: { icon: CircleCheckIcon, color: 'text-green-500', label: '已连接' },
  error: { icon: CircleAlertIcon, color: 'text-red-500', label: '连接失败' },
} as const

export default function AiSidePanel() {
  const messages = useCurrentAiMessages()
  const [input, setInput] = useState('')
  const [detailPayload, setDetailPayload] = useState<ChatRequestPayload | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)

  const { aiConfig, aiConnectionStatus, aiConnectionDetail, currentBookId } = useAppStore()
  const {
    streaming,
    embeddingGenerating,
    embeddingStatus,
    embeddingStatusLoading,
    handleSend,
    handleClear,
    handleDeleteMessage,
    handleGenerateEmbeddings,
  } = useAiChat({ bookId: currentBookId ?? '', aiConfig })

  const providerLabel = PROVIDER_LABELS[aiConfig.chat.provider] ?? aiConfig.chat.provider
  const StatusIcon = STATUS_CONFIG[aiConnectionStatus].icon
  const statusColor = STATUS_CONFIG[aiConnectionStatus].color
  const statusLabel = STATUS_CONFIG[aiConnectionStatus].label

  // 稳定回调引用，避免子组件 memo 失效
  const onShowDetail = useCallback((payload: ChatRequestPayload) => {
    setDetailPayload(payload)
  }, [])
  const onCloseDetail = useCallback(() => {
    setDetailPayload(null)
  }, [])

  // 自动滚动到底部：仅当流式进行中且用户在底部附近时滚动
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!streaming || !scrollContainerRef.current) return
    if (scrollRafRef.current) return
    const container = scrollContainerRef.current
    // 用户手动上滚超过 200px 则停止自动滚动
    const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distFromBottom > 200) return

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
  }, [messages, streaming])

  const onSend = () => {
    if (input.trim() && !streaming && currentBookId) {
      void handleSend(input)
      setInput('')
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 头部 */}
      <Header
        providerLabel={providerLabel}
        StatusIcon={StatusIcon}
        statusColor={statusColor}
        statusLabel={statusLabel}
        aiConnectionStatus={aiConnectionStatus}
        aiConnectionDetail={aiConnectionDetail}
        onClear={handleClear}
      />

      {/* 消息列表 */}
      <MessageList messages={messages} bottomRef={bottomRef} scrollContainerRef={scrollContainerRef} onDelete={handleDeleteMessage} onShowDetail={onShowDetail} bookId={currentBookId ?? undefined} />

      {/* 快捷提示词 */}
      {messages.length === 0 && <QuickHints onSelect={setInput} />}

      {/* 输入框 */}
      <InputArea
        input={input}
        onChange={setInput}
        onSend={onSend}
        streaming={streaming}
        modelName={aiConfig.chat.model}
        embeddingGenerating={embeddingGenerating}
        embeddingStatusLoading={embeddingStatusLoading}
        embeddingStatus={embeddingStatus}
        currentBookId={currentBookId}
        ragEnabled={aiConfig.rag.enabled}
        onGenerateEmbeddings={handleGenerateEmbeddings}
      />

      {/* 请求详情弹窗 */}
      {detailPayload && <RequestDetailModal payload={detailPayload} onClose={onCloseDetail} />}
    </div>
  )
}

/** 头部组件 */
const Header = memo(function Header({
  providerLabel,
  StatusIcon,
  statusColor,
  statusLabel,
  aiConnectionStatus,
  aiConnectionDetail,
  onClear,
}: {
  providerLabel: string
  StatusIcon: typeof CircleIcon
  statusColor: string
  statusLabel: string
  aiConnectionStatus: keyof typeof STATUS_CONFIG
  aiConnectionDetail: string | null
  onClear: () => void
}) {
  return (
    <div className="px-3 py-2 border-b flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2">
        <BotIcon className="w-4 h-4 text-primary" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">AI 助手</span>
        <div
          className="flex items-center gap-1 cursor-help"
          title={aiConnectionStatus === 'error' ? aiConnectionDetail || '连接失败' : `${providerLabel} · ${statusLabel}`}
        >
          <StatusIcon className={cn('w-3 h-3', statusColor)} />
          <span className={`text-[10px] ${
            aiConnectionStatus === 'connected' ? 'text-green-600 dark:text-green-400' :
            aiConnectionStatus === 'error' ? 'text-red-600 dark:text-red-400' :
            'text-muted-foreground/70'
          }`}>
            {providerLabel}
          </span>
        </div>
      </div>
      <button
        onClick={onClear}
        title="清空AI聊天记录"
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground text-xs transition-colors"
      >
        <Trash2Icon className="w-3 h-3" />
        <span>清空聊天</span>
      </button>
    </div>
  )
})

/** 消息列表组件 */
const MessageList = memo(function MessageList({
  messages,
  bottomRef,
  scrollContainerRef,
  onDelete,
  onShowDetail,
  bookId,
}: {
  messages: ReturnType<typeof useCurrentAiMessages>
  bottomRef: React.RefObject<HTMLDivElement | null>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  onDelete: (id: string) => void
  onShowDetail: (payload: ChatRequestPayload) => void
  bookId?: string
}) {
  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3 min-w-0">
      {messages.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <BotIcon className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-xs">向 AI 描述你的创作需求</p>
          <p className="text-xs opacity-70 mt-1">续写、润色、角色设计…</p>
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onDelete={onDelete} onShowDetail={onShowDetail} bookId={bookId} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
})

/** 快捷提示词组件 */
const QuickHints = memo(function QuickHints({ onSelect }: { onSelect: (hint: string) => void }) {
  return (
    <div className="px-3 pb-2 flex gap-1.5 flex-wrap">
      {QUICK_HINTS.map((hint) => (
        <button
          key={hint}
          onClick={() => onSelect(hint)}
          className="text-xs bg-muted hover:bg-muted/80 px-2.5 py-1.5 rounded-full transition-colors"
        >
          {hint}
        </button>
      ))}
    </div>
  )
})

/** 输入区域组件 */
const InputArea = memo(function InputArea({
  input,
  onChange,
  onSend,
  streaming,
  modelName,
  embeddingGenerating,
  embeddingStatusLoading,
  embeddingStatus,
  currentBookId,
  ragEnabled,
  onGenerateEmbeddings,
}: {
  input: string
  onChange: (v: string) => void
  onSend: () => void
  streaming: boolean
  modelName: string
  embeddingGenerating: boolean
  embeddingStatusLoading: boolean
  embeddingStatus: ReturnType<typeof useAiChat>['embeddingStatus']
  currentBookId: string | null
  ragEnabled: boolean
  onGenerateEmbeddings: () => void
}) {
  return (
    <div className="px-3 py-3 border-t shrink-0">
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void onSend()
            }
          }}
          placeholder="向 AI 提问…（Shift+Enter 换行）"
          rows={3}
          className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
          disabled={streaming}
        />
        <button
          onClick={onSend}
          disabled={!input.trim() || streaming}
          className="self-end p-2.5 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 hover:opacity-90 transition-opacity"
        >
          {streaming ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <SendIcon className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
        模型：{modelName}
        {/* Embedding 状态（仅 RAG 启用时显示） */}
        {currentBookId && ragEnabled && (
          <EmbeddingStatusCmp
            generating={embeddingGenerating}
            loading={embeddingStatusLoading}
            status={embeddingStatus}
            onRegenerate={onGenerateEmbeddings}
          />
        )}
      </p>
    </div>
  )
})

/** Embedding 状态指示器 */
const EmbeddingStatusCmp = memo(function EmbeddingStatus({
  generating,
  loading,
  status,
  onRegenerate,
}: {
  generating: boolean
  loading: boolean
  status: ReturnType<typeof useAiChat>['embeddingStatus']
  onRegenerate: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-border/30">|</span>
      {generating ? (
        <span className="text-blue-500 flex items-center gap-0.5">
          <Loader2Icon className="w-3 h-3 animate-spin" />
          生成中…
        </span>
      ) : loading ? (
        <span className="text-muted-foreground/50">
          <Loader2Icon className="w-3 h-3 animate-spin" />
        </span>
      ) : status?.stale ? (
        <button
          onClick={onRegenerate}
          className="text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 flex items-center gap-0.5 transition-colors"
          title={`索引已过期：${status.totalChapters} 章节/${status.totalWorldCards} 卡片，仅索引了 ${status.indexedChapters} 章节/${status.indexedWorldCards} 卡片`}
        >
          <CircleAlertIcon className="w-3 h-3" />
          <RefreshCwIcon className="w-3 h-3" />
          索引已过期
        </button>
      ) : status && (status.indexedChapters > 0 || status.indexedWorldCards > 0) ? (
        <span
          className="text-green-600 dark:text-green-400 flex items-center gap-0.5 cursor-help"
          title={`${status.indexedChapters} 章节 + ${status.indexedWorldCards} 卡片已索引 / 共 ${status.totalChapters} 章节 + ${status.totalWorldCards} 卡片`}
        >
          <CircleCheckIcon className="w-3 h-3" />
          {status.indexedChapters + status.indexedWorldCards} 项已索引
          <button onClick={onRegenerate} className="text-primary/60 hover:text-primary ml-0.5" title="重新生成索引">
            <RefreshCwIcon className="w-3 h-3" />
          </button>
        </span>
      ) : (
        <button
          onClick={onRegenerate}
          className="text-primary/80 hover:text-primary flex items-center gap-0.5 transition-colors"
          title="为当前书籍生成语义索引，提升 RAG 检索精度"
        >
          <DatabaseZapIcon className="w-3 h-3" />
          生成索引
        </button>
      )}
    </span>
  )
})
