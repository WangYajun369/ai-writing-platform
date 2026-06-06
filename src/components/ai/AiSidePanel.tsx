/**
 * AiSidePanel — AI 助手侧面板
 *
 * 支持多服务商流式对话（Ollama / OpenAI / 智谱 BigModel / 自定义），
 * 自动 RAG 检索当前书籍上下文。
 * 流式调用由 Rust 侧通过 reqwest 处理，前端通过 Tauri 事件接收增量。
 *
 * 对话记录以当前作品（bookId）为维度持久化到 localStorage，
 * 切换作品时自动加载对应对话历史。
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { SendIcon, BotIcon, XIcon, Loader2Icon, CircleCheckIcon, CircleAlertIcon, CircleIcon, ChevronDownIcon, DatabaseZapIcon, RefreshCwIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAppStore, useCurrentChapter, useCurrentAiMessages } from '@/stores/appStore.ts'
import { aiApi, type StreamEvent, type UsageInfo, type EmbeddingStatus } from '@/lib/tauri-bridge.ts'
import { cn } from '@/lib/utils.ts'
import type { AiMessage } from '@/types'

export default function AiSidePanel() {
  const messages = useCurrentAiMessages()
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const unlistenRef = useRef<UnlistenFn | null>(null)
  const streamErrorRef = useRef(false) // 标记流是否遇到错误，防止最终更新覆盖错误信息
  const { aiConfig, aiConnectionStatus, aiConnectionDetail, currentBookId, addAiMessage, updateAiMessage, clearAiConversation, persistAiConversation } = useAppStore()
  const currentChapter = useCurrentChapter()
  // Embedding 生成状态
  const [embeddingGenerating, setEmbeddingGenerating] = useState(false)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  const [embeddingStatusLoading, setEmbeddingStatusLoading] = useState(false)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 组件卸载时清理事件监听，防止内存泄漏
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [])

  const isOllamaProvider = aiConfig.provider === 'ollama'

  /** 获取服务商显示名称 */
  const providerLabel = {
    ollama: 'Ollama',
    openai: 'OpenAI',
    bigmodel: '智谱',
    custom: '自定义',
  }[aiConfig.provider] ?? aiConfig.provider

  /** 根据连接状态返回状态图标和颜色 */
  const statusConfig = {
    idle: { icon: CircleIcon, color: 'text-muted-foreground/50', label: '未检测' },
    testing: { icon: Loader2Icon, color: 'text-blue-500 animate-spin', label: '检测中…' },
    connected: { icon: CircleCheckIcon, color: 'text-green-500', label: '已连接' },
    error: { icon: CircleAlertIcon, color: 'text-red-500', label: '连接失败' },
  } as const
  const StatusIcon = statusConfig[aiConnectionStatus].icon
  const statusColor = statusConfig[aiConnectionStatus].color
  const statusLabel = statusConfig[aiConnectionStatus].label

  const bookId = currentBookId

  /** 检查当前书籍的 Embedding 索引状态 */
  const refreshEmbeddingStatus = useCallback(async () => {
    if (!bookId) return
    setEmbeddingStatusLoading(true)
    try {
      const status = await aiApi.checkEmbeddingStatus(bookId)
      setEmbeddingStatus(status)
    } catch {
      // 静默忽略，旧版后端可能未实现此命令
    } finally {
      setEmbeddingStatusLoading(false)
    }
  }, [bookId])

  // 切换作品或加载时自动检测索引状态
  useEffect(() => {
    if (bookId && !isOllamaProvider) {
      refreshEmbeddingStatus()
    } else {
      setEmbeddingStatus(null)
    }
  }, [bookId, isOllamaProvider, refreshEmbeddingStatus])

  /** 根据 provider 组装 messages 数组 */
  function buildMessages(context: string) {
    const systemMsg = `你是一位专业的小说创作助手。请根据用户的需求提供创作建议、续写、润色等服务。${context}`
    const history = messages.filter((m) => !m.loading).map((m) => ({ role: m.role, content: m.content }))
    return [
      { role: 'system', content: systemMsg },
      ...history,
      { role: 'user', content: input.trim() },
    ]
  }

  /** 更新助手消息内容（含思考过程与阶段） */
  function updateAssistant(assistantId: string, content: string, thinking?: string, phase?: string) {
    if (!bookId) return
    updateAiMessage(bookId, assistantId, {
      content,
      thinking: thinking ?? undefined,
      phase: (phase ?? undefined) as AiMessage['phase'],
      loading: phase === 'thinking' || (!content && !thinking),
    })
  }

  /** 更新助手消息用量统计（仅 done 事件携带） */
  function updateAssistantUsage(assistantId: string, usage: UsageInfo) {
    if (!bookId) return
    updateAiMessage(bookId, assistantId, { usage })
  }

  async function handleSend() {
    if (!input.trim() || streaming || !bookId) return

    // 非 Ollama 提供者必须提供 API Key
    if (!isOllamaProvider && !aiConfig.apiKey) {
      alert('请先在设置中配置 API Key')
      return
    }

    const userMsg: AiMessage = { id: Date.now().toString(), role: 'user', content: input.trim(), thinking: '', phase: 'done' }
    const assistantId = (Date.now() + 1).toString()
    const assistantMsg: AiMessage = { id: assistantId, role: 'assistant', content: '', thinking: '', phase: 'thinking', loading: true }

    addAiMessage(bookId, userMsg)
    addAiMessage(bookId, assistantMsg)
    const userInput = input.trim()
    setInput('')
    setStreaming(true)

    try {
      // RAG 检索上下文
      let context = ''
      if (currentChapter) {
        const results = await aiApi.ragSearch(
          currentChapter.bookId,
          userInput,
          3,
          aiConfig.endpoint,
          aiConfig.apiKey,
          aiConfig.embeddingModel,
        ).catch(() => [])
        if (results.length > 0) {
          context = '\n\n相关背景：\n' + results.map((r) => r.snippet).join('\n---\n')
        }
      }

      // 注册流式事件监听（必须在 invoke 之前注册）
      // 先取消之前的监听以防重复
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
      streamErrorRef.current = false
      unlistenRef.current = await listen<StreamEvent>('ai-stream-chunk', (event) => {
        const { content, thinking, phase, done, error, usage } = event.payload
        if (error) {
          streamErrorRef.current = true
          updateAssistant(assistantId, `⚠️ AI 响应中断：${error}`, thinking, 'done')
          setStreaming(false)
          persistAiConversation(bookId)
          return
        }
        updateAssistant(assistantId, content, thinking, phase)
        if (usage) {
          updateAssistantUsage(assistantId, usage)
        }
        if (done) {
          setStreaming(false)
          persistAiConversation(bookId)
        }
      })

      // 构建消息
      const chatMessages = buildMessages(context)
      const provider = isOllamaProvider ? 'ollama' : 'openai_compatible'

      // 调用 Rust 侧流式对话命令
      // done 事件中已设置最终内容和用量，此处仅等待流结束，不做重复更新
      await aiApi.streamChat({
        provider,
        endpoint: aiConfig.endpoint,
        model: aiConfig.model,
        temperature: aiConfig.temperature,
        maxTokens: aiConfig.maxTokens,
        apiKey: aiConfig.apiKey,
        messages: chatMessages,
      })
    } catch (err) {
      updateAssistant(assistantId, `⚠️ AI 响应失败：${String(err)}`)
      if (bookId) persistAiConversation(bookId)
    } finally {
      setStreaming(false)
      // 取消事件监听
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }

  function handleClear() {
    if (messages.length > 0 && bookId && confirm('清空当前作品的对话记录？')) {
      clearAiConversation(bookId)
    }
  }

  /** 触发 Embedding 生成 */
  async function handleGenerateEmbeddings() {
    if (!bookId) return
    if (!aiConfig.endpoint || !aiConfig.apiKey || !aiConfig.embeddingModel) {
      alert('请先在设置中配置 AI 服务（Endpoint、API Key、Embedding 模型）')
      return
    }
    setEmbeddingGenerating(true)
    setEmbeddingStatus(null)
    try {
      await aiApi.triggerEmbedding(
        bookId,
        aiConfig.endpoint,
        aiConfig.apiKey,
        aiConfig.embeddingModel,
      )
      // 刷新索引状态
      await refreshEmbeddingStatus()
    } catch (err) {
      alert(`Embedding 生成失败: ${String(err)}`)
    } finally {
      setEmbeddingGenerating(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 头部 */}
      <div className="px-3 py-2 border-b flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <BotIcon className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">AI 助手</span>
          {/* 连接状态指示器 */}
          <div
            className="flex items-center gap-1 cursor-help"
            title={aiConnectionStatus === 'error' ? aiConnectionDetail || '连接失败' : `${providerLabel} · ${statusLabel}`}
          >
            <StatusIcon className={cn('w-3 h-3', statusColor)} />
            <span className={`text-[10px] ${aiConnectionStatus === 'connected' ? 'text-green-600 dark:text-green-400' : aiConnectionStatus === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground/70'}`}>
              {providerLabel}
            </span>
          </div>
        </div>
        <button onClick={handleClear} title="清空对话" className="p-1 rounded hover:bg-muted text-muted-foreground">
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3 min-w-0">
        {messages.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <BotIcon className="w-8 h-8 mx-auto mb-3 opacity-30" />
            <p className="text-xs">向 AI 描述你的创作需求</p>
            <p className="text-xs opacity-70 mt-1">续写、润色、角色设计…</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 快捷提示词 */}
      {messages.length === 0 && (
        <div className="px-3 pb-2 flex gap-1.5 flex-wrap">
          {['帮我续写下一段', '优化这段对话', '推演剧情走向', '分析人物性格'].map((hint) => (
            <button
              key={hint}
              onClick={() => setInput(hint)}
              className="text-xs bg-muted hover:bg-muted/80 px-2.5 py-1.5 rounded-full transition-colors"
            >
              {hint}
            </button>
          ))}
        </div>
      )}

      {/* 输入框 */}
      <div className="px-3 py-3 border-t flex-shrink-0">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder="向 AI 提问…（Shift+Enter 换行）"
            rows={3}
            className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
            disabled={streaming}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || streaming}
            className="self-end p-2.5 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {streaming ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <SendIcon className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
          模型：{aiConfig.model}
          {/* Embedding 状态 */}
          {!isOllamaProvider && bookId && (
            <span className="inline-flex items-center gap-1">
              <span className="text-border/30">|</span>
              {embeddingGenerating ? (
                <span className="text-blue-500 flex items-center gap-0.5">
                  <Loader2Icon className="w-3 h-3 animate-spin" />
                  生成中…
                </span>
              ) : embeddingStatusLoading ? (
                <span className="text-muted-foreground/50">
                  <Loader2Icon className="w-3 h-3 animate-spin" />
                </span>
              ) : embeddingStatus?.stale ? (
                <button
                  onClick={handleGenerateEmbeddings}
                  className="text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 flex items-center gap-0.5 transition-colors"
                  title={`索引已过期：${embeddingStatus.totalChapters} 章节/${embeddingStatus.totalWorldCards} 卡片，仅索引了 ${embeddingStatus.indexedChapters} 章节/${embeddingStatus.indexedWorldCards} 卡片`}
                >
                  <CircleAlertIcon className="w-3 h-3" />
                  <RefreshCwIcon className="w-3 h-3" />
                  索引已过期
                </button>
              ) : embeddingStatus && (embeddingStatus.indexedChapters > 0 || embeddingStatus.indexedWorldCards > 0) ? (
                <span className="text-green-600 dark:text-green-400 flex items-center gap-0.5 cursor-help" title={`${embeddingStatus.indexedChapters} 章节 + ${embeddingStatus.indexedWorldCards} 卡片已索引 / 共 ${embeddingStatus.totalChapters} 章节 + ${embeddingStatus.totalWorldCards} 卡片`}>
                  <CircleCheckIcon className="w-3 h-3" />
                  {embeddingStatus.indexedChapters + embeddingStatus.indexedWorldCards} 项已索引
                  <button
                    onClick={handleGenerateEmbeddings}
                    className="text-primary/60 hover:text-primary ml-0.5"
                    title="重新生成索引"
                  >
                    <RefreshCwIcon className="w-3 h-3" />
                  </button>
                </span>
              ) : (
                <button
                  onClick={handleGenerateEmbeddings}
                  className="text-primary/80 hover:text-primary flex items-center gap-0.5 transition-colors"
                  title="为当前书籍生成语义索引，提升 RAG 检索精度"
                >
                  <DatabaseZapIcon className="w-3 h-3" />
                  生成索引
                </button>
              )}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

/**
 * 对话气泡子组件
 *
 * 根据角色（用户/助手）切换对齐方向与气泡配色。
 * 助手消息使用 react-markdown 渲染，支持 GFM（表格/删除线等）。
 */
function MessageBubble({ message }: { message: AiMessage }) {
  const isUser = message.role === 'user'
  const [thinkingExpanded, setThinkingExpanded] = useState(false)

  /** 兜底计算：若 Rust 侧 outputChars 为 0，用前端实际内容字符数替代 */
  const contentCharCount = [...message.content].length
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
  const isLoading = message.loading && !message.content && !hasThinking

  return (
    <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap'
            : 'bg-muted text-foreground rounded-bl-sm markdown-body'
        )}
      >
        {/* 初始加载状态（无思考内容、无正式输出） */}
        {isLoading && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="w-3 h-3 animate-spin" />
            思考中…
          </span>
        )}

        {/* 深度思考过程（可折叠） */}
        {!isUser && hasThinking && (
          <div className="mb-2">
            <button
              onClick={() => setThinkingExpanded((v) => !v)}
              className={cn(
                'flex items-center gap-1.5 text-[11px] mb-1 transition-colors',
                isThinkingPhase ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/70'
              )}
            >
              <ChevronDownIcon
                className={cn('w-3 h-3 transition-transform', thinkingExpanded && 'rotate-180')}
              />
              {isThinkingPhase ? (
                <span className="flex items-center gap-1">
                  <Loader2Icon className="w-2.5 h-2.5 animate-spin" />
                  深度思考中…
                </span>
              ) : (
                '思考过程'
              )}
            </button>
            {thinkingExpanded && (
              <div className="text-[11px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap border-l-2 border-amber-300/40 pl-2.5 py-0.5 italic">
                {message.thinking}
              </div>
            )}
          </div>
        )}

        {/* 正式输出 */}
        {!isUser && hasThinking && message.content && (
          <div className={cn(
            'text-[10px] text-muted-foreground/50 mb-1 border-t border-border/30 pt-1',
            message.phase === 'answering' && 'flex items-center gap-1'
          )}>
            {message.phase === 'answering' ? (
              <>📝 正式输出中…</>
            ) : (
              '📝 正式输出'
            )}
          </div>
        )}

        {/* 用户消息纯文本 / 助手消息 Markdown */}
        {isUser ? (
          message.content
        ) : message.content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        ) : null}

        {/* 用量统计（仅助手消息完成时显示） */}
        {!isUser && !message.loading && effectiveUsage && (
          <div className="mt-2 pt-2 border-t border-border/50 flex items-center gap-3 text-[10px] text-muted-foreground/70">
            <span title="输入 Token">↗ {effectiveUsage.inputTokens} token</span>
            <span title="输出 Token">↘ {effectiveUsage.outputTokens} token</span>
            <span className="text-border/30">|</span>
            <span title="输入字数">↗ {effectiveUsage.inputChars} 字</span>
            <span title="输出字数">↘ {effectiveUsage.outputChars} 字</span>
          </div>
        )}
      </div>
    </div>
  )
}
