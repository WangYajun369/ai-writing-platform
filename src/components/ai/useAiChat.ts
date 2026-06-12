/**
 * AI 对话相关的自定义 hooks
 *
 * 现已接入 Agent 服务：通过 invoke('execute_agent_skill') 调用 Python Agent，
 * 由 Agent 内部管理 Prompt 构建、RAG 检索、模型路由和工具调用。
 * 流式响应通过 Tauri 事件 `agent-stream-chunk` 接收。
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore, useCurrentChapter, useCurrentAiMessages } from '@/stores/appStore'
import { aiApi, bookApi, chapterApi, type UsageInfo, type EmbeddingStatus } from '@/lib/tauri-bridge'
import type { ChatMessage } from '@/lib/tauri-bridge'
import { getChatApiKey, getRagApiKey } from '@/types'
import type { AiMessage, AiConfig, ConversationSummary, Chapter } from '@/types'
import type { SkillType } from '@/components/agent/types'

/** 将 AI 异常信息转换为用户友好的提示 */
export function getFriendlyAiError(rawError: string): string {
  const lower = rawError.toLowerCase()
  if (/401|unauthorized|invalid api key|authentication/.test(lower)) {
    return 'API Key 无效或已过期，请前往**设置**页面更新 API Key'
  }
  if (/403|forbidden/.test(lower)) {
    return 'API 访问被拒绝，请检查**设置**中的 API Key 权限'
  }
  if (/404|not found/.test(lower)) {
    return '模型不可用，请前往**设置**页面检查模型名称是否正确'
  }
  if (/429|rate limit|too many/.test(lower)) {
    return '请求过于频繁，请稍后重试'
  }
  if (/timeout|timed out|超时/.test(lower)) {
    return 'AI 服务响应超时（网络抖动），已自动重试，若持续失败请检查网络连接'
  }
  if (/connection|connect|network|econnrefused|eof|reset|broken pipe/.test(lower)) {
    return '网络连接不稳定，已自动重试，若持续失败请检查网络并在**设置**中确认 API 地址正确'
  }
  if (/500|502|503|504|internal server|unavailable/.test(lower)) {
    return 'AI 服务暂时不可用，已自动重试，请稍后'
  }
  return 'AI 响应异常，请在**设置**中检查 AI 是否可用'
}

/** 快捷提示词配置 */
export const QUICK_HINTS = ['帮我续写下一段', '优化这段对话', '推演剧情走向', '分析人物性格'] as const

/** 服务商显示名称映射 */
export const PROVIDER_LABELS: Record<string, string> = {
  bigmodel: '智谱',
  deepseek: 'DeepSeek',
}

/** 剥离 HTML 标签获取纯文本，限制长度 */
export function stripHtmlToText(html: string, maxChars: number = 2000): string {
  const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '…'
}

export interface UseAiChatOptions {
  bookId: string
  aiConfig: AiConfig
  /** 当前选择的技能类型，默认 'writing' */
  skill?: SkillType
  onError?: (message: AiMessage, friendly: string, raw: string) => void
  onSuccess?: (message: AiMessage) => void
}

export interface UseAiChatReturn {
  streaming: boolean
  embeddingGenerating: boolean
  embeddingStatus: EmbeddingStatus | null
  embeddingStatusLoading: boolean
  handleSend: (input: string) => Promise<void>
  handleClear: () => void
  handleDeleteMessage: (messageId: string) => void
  handleGenerateEmbeddings: () => Promise<void>
  refreshEmbeddingStatus: () => Promise<void>
}

export function useAiChat(options: UseAiChatOptions): UseAiChatReturn {
  const { bookId, aiConfig, skill: currentSkill = 'writing' } = options
  const messages = useCurrentAiMessages()
  const currentChapter = useCurrentChapter()
  const { aiSummaries, addAiMessage, updateAiMessage, deleteAiMessage, clearAiConversation, persistAiConversation, setConversationSummary } = useAppStore()

  const [streaming, setStreaming] = useState(false)
  const [embeddingGenerating, setEmbeddingGenerating] = useState(false)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  const [embeddingStatusLoading, setEmbeddingStatusLoading] = useState(false)

  const unlistenRef = useRef<UnlistenFn | null>(null)
  const streamErrorRef = useRef(false)
  const summarizingRef = useRef(false) // 防止并发总结

  // 流式数据缓冲：避免逐 token 更新 Zustand 导致高频重渲染
  const streamBufferRef = useRef<{ content: string; thinking: string; phase?: string; usage: UsageInfo | null }>({
    content: '', thinking: '', phase: undefined, usage: null,
  })
  const streamRafRef = useRef<number | null>(null)
  const currentAssistantIdRef = useRef<string>('')

  // 清理事件监听和流式缓冲
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
      if (streamRafRef.current) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
    }
  }, [])

  // 检查 Embedding 状态
  const refreshEmbeddingStatus = useCallback(async () => {
    if (!bookId) return
    setEmbeddingStatusLoading(true)
    try {
      const status = await aiApi.checkEmbeddingStatus(bookId)
      setEmbeddingStatus(status)
    } catch {
      // 静默忽略
    } finally {
      setEmbeddingStatusLoading(false)
    }
  }, [bookId])

  // 切换作品时自动检测索引状态
  useEffect(() => {
    if (bookId) {
      void refreshEmbeddingStatus()
    } else {
      setEmbeddingStatus(null)
    }
  }, [bookId, refreshEmbeddingStatus])

  // 窗口大小：每轮 = user + assistant，至少保留 1 轮
  const windowSize = Math.max(1, aiConfig.chat.contextWindowSize ?? 10)
  const currentSummary = bookId ? aiSummaries[bookId] : undefined

  /** 将超出窗口的历史消息压缩为摘要（后台执行，不阻塞当前请求） */
  const summarizeOverflowMessages = useCallback(async (allMsgs: AiMessage[]) => {
    if (!bookId || summarizingRef.current) return
    const validMsgs = allMsgs.filter((m) => m.role === 'user' || m.role === 'assistant')
    const totalTurns = Math.floor(validMsgs.length / 2)
    // 未超出窗口，无需总结
    if (totalTurns <= windowSize) return

    const keepCount = windowSize * 2
    const overflowMsgs = validMsgs.slice(0, validMsgs.length - keepCount)

    // 摘要已覆盖到最新溢出消息，无需重复总结
    if (currentSummary && overflowMsgs.length > 0) {
      const lastOverflowId = overflowMsgs[overflowMsgs.length - 1].id
      if (currentSummary.coveredUpToId === lastOverflowId && currentSummary.summary) return
    }
    if (overflowMsgs.length === 0) return

    const chatApiKey = getChatApiKey(aiConfig.chat)
    if (!chatApiKey) return

    summarizingRef.current = true
    try {
      const chatMsgs: ChatMessage[] = overflowMsgs
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }))
      if (chatMsgs.length === 0) return

      const previousSummary = currentSummary?.summary || undefined

      const result = await aiApi.summarizeConversation({
        endpoint: aiConfig.chat.endpoint,
        model: aiConfig.chat.model,
        apiKey: chatApiKey,
        temperature: 0.3,
        maxTokens: 1000,
        messages: chatMsgs,
        previousSummary,
        thinkingEnabled: false,
      })

      const lastOverflowId = overflowMsgs[overflowMsgs.length - 1].id
      const summary: ConversationSummary = {
        summary: result.summary,
        coveredUpToId: lastOverflowId,
        summaryChars: result.summaryChars,
        updatedAt: new Date().toISOString(),
      }
      setConversationSummary(bookId, summary)
    } catch (err) {
      console.error('对话历史总结失败:', err)
    } finally {
      summarizingRef.current = false
    }
  }, [bookId, aiConfig, windowSize, currentSummary, setConversationSummary])

  // 更新助手消息
  const updateAssistant = useCallback((assistantId: string, content: string, thinking?: string, phase?: string) => {
    if (!bookId) return
    // retrying 阶段：不覆盖已有内容，仅更新阶段和 loading 状态
    if (phase === 'retrying') {
      updateAiMessage(bookId, assistantId, {
        phase: 'retrying',
        loading: true,
      })
      return
    }
    updateAiMessage(bookId, assistantId, {
      content,
      thinking: thinking ?? undefined,
      phase: (phase ?? undefined) as AiMessage['phase'],
      loading: phase === 'thinking' || (!content && !thinking),
    })
  }, [bookId, updateAiMessage])

  // 更新助手用量
  const updateAssistantUsage = useCallback((assistantId: string, usage: UsageInfo) => {
    if (!bookId) return
    updateAiMessage(bookId, assistantId, { usage })
  }, [bookId, updateAiMessage])

  // 清空对话
  const handleClear = useCallback(() => {
    if (messages.length > 0 && bookId && confirm('清空当前作品的对话记录？')) {
      clearAiConversation(bookId)
    }
  }, [messages, bookId, clearAiConversation])

  // 删除消息
  const handleDeleteMessage = useCallback((messageId: string) => {
    if (!bookId) return
    deleteAiMessage(bookId, messageId)
  }, [bookId, deleteAiMessage])

  // 生成 Embedding
  const handleGenerateEmbeddings = useCallback(async () => {
    if (!bookId) return
    const ragApiKey = getRagApiKey(aiConfig.rag) || getChatApiKey(aiConfig.chat)
    if (!aiConfig.rag.endpoint || !ragApiKey || !aiConfig.rag.embeddingModel) {
      alert('请先在设置中配置 RAG 检索（Endpoint、API Key、Embedding 模型）')
      return
    }
    setEmbeddingGenerating(true)
    setEmbeddingStatus(null)
    try {
      await aiApi.triggerEmbedding(bookId, aiConfig.rag.endpoint, ragApiKey, aiConfig.rag.embeddingModel)
      await refreshEmbeddingStatus()
    } catch (err) {
      const msg = String(err)
      // 提取友好提示
      alert(`Embedding 生成失败\n\n${msg}\n\n排查建议：\n1. 检查智谱 API Key 是否有 Embedding 模型（embedding-3）的调用权限\n2. 单条文本过长可能超过 3072 tokens 限制（已自动截断）\n3. 检查 Endpoint 地址是否正确（默认 https://open.bigmodel.cn/api/paas/v4）`)
    } finally {
      setEmbeddingGenerating(false)
    }
  }, [bookId, aiConfig, refreshEmbeddingStatus])

  // 发送消息
  const handleSend = useCallback(async (input: string) => {
    if (!input.trim() || streaming || !bookId) return

    const chatApiKey = getChatApiKey(aiConfig.chat)
    if (!chatApiKey) {
      alert('请先在设置中配置 API Key')
      return
    }

    const userMsg: AiMessage = { id: Date.now().toString(), role: 'user', content: input.trim(), thinking: '', phase: 'done' }
    const assistantId = (Date.now() + 1).toString()
    const assistantMsg: AiMessage = { id: assistantId, role: 'assistant', content: '', thinking: '', phase: 'thinking', loading: true, isSummarizing: false }

    addAiMessage(bookId, userMsg)
    addAiMessage(bookId, assistantMsg)
    setStreaming(true)

    /** 前置校验不通过时：提示并标记消息为大纲缺失类型 */
    const stopWithOutlineHint = async (hint: string) => {
      updateAssistant(assistantId, hint, undefined, 'done')
      updateAiMessage(bookId, assistantId, { action: 'open-world-outline' })
      setStreaming(false)
      persistAiConversation(bookId)
    }
    try {
      // ==================== 阶段 0：前置校验 ====================

      // 0.1 检查作品大纲是否存在
      const book = await bookApi.getById(bookId).catch(() => null)
      if (!book?.outline?.trim()) {
        await stopWithOutlineHint('⚠️ 尚未填写**作品大纲**。\n\n已自动打开「世界观资料库 → 大纲」窗口，请在此为当前作品补充大纲，让 AI 更好地理解你的创作方向。')
        return
      }

      // 0.2 检查当前章节大纲是否存在（从 DB 实时读取，避免 Zustand store 数据滞后）
      if (currentChapter) {
        const freshChapters = await chapterApi.listByBook(bookId).catch(() => [] as Chapter[])
        const freshChapter = freshChapters.find((c: Chapter) => c.id === currentChapter.id)
        if (!freshChapter?.outline?.trim()) {
          await stopWithOutlineHint(`⚠️ 当前章节「${currentChapter.title}」尚未填写**章节大纲**。\n\n请打开「世界观资料库 → 大纲」，在窗口中为对应章节补充大纲后重试。`)
          return
        }
      }

      // ==================== 阶段 1：注册 Agent 流式监听 ====================

      // 清理上一次监听
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
      if (streamRafRef.current) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      streamErrorRef.current = false
      currentAssistantIdRef.current = assistantId
      // 生成请求 ID，用于过滤属于自己的 SSE 事件
      const requestId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      /** 将缓冲区的流式数据刷新到 Zustand */
      const flushStreamBuffer = () => {
        const buffered = streamBufferRef.current
        const aid = currentAssistantIdRef.current
        if (!aid) return
        updateAssistant(aid, buffered.content, buffered.thinking, buffered.phase)
        if (buffered.usage) updateAssistantUsage(aid, buffered.usage)
      }

      // 监听 Agent 流式事件
      unlistenRef.current = await listen<{ event: string; data: string; requestId: string }>('agent-stream-chunk', (event) => {
        const { event: eventType, data, requestId: eventRequestId } = event.payload

        // 过滤不属于当前请求的事件
        if (eventRequestId && eventRequestId !== requestId) return

        if (eventType === 'error') {
          if (streamRafRef.current) {
            cancelAnimationFrame(streamRafRef.current)
            streamRafRef.current = null
          }
          streamErrorRef.current = true
          const friendly = getFriendlyAiError(data)
          updateAssistant(assistantId, `⚠️ ${friendly}\n\n> 错误详情：${data}`, undefined, 'done')
          setStreaming(false)
          persistAiConversation(bookId)
          return
        }

        if (eventType === 'chunk') {
          // 累积内容
          streamBufferRef.current = {
            ...streamBufferRef.current,
            content: streamBufferRef.current.content + data,
            phase: 'answering',
          }
          if (streamRafRef.current === null) {
            streamRafRef.current = requestAnimationFrame(() => {
              flushStreamBuffer()
              streamRafRef.current = null
            })
          }
        }

        if (eventType === 'done') {
          if (streamRafRef.current) {
            cancelAnimationFrame(streamRafRef.current)
            streamRafRef.current = null
          }
          flushStreamBuffer()
          setStreaming(false)
          persistAiConversation(bookId)
          // 后台触发对话历史总结
          const allMsgs = useAppStore.getState().aiConversations[bookId] ?? []
          void summarizeOverflowMessages(allMsgs)
        }

        if (eventType === 'cancelled') {
          if (streamRafRef.current) {
            cancelAnimationFrame(streamRafRef.current)
            streamRafRef.current = null
          }
          flushStreamBuffer()
          setStreaming(false)
          persistAiConversation(bookId)
        }
      })

      // ==================== 阶段 2：调用 Agent Skill ====================

      // 构建对话历史
      const validMsgs = messages.filter((m) => !m.loading && (m.role === 'user' || m.role === 'assistant'))
      const recentMsgs = validMsgs.slice(-20) // 最近 20 条
      const history = recentMsgs.map((m) => ({ role: m.role, content: m.content }))

      // 使用当前选中的技能类型
      const skill: SkillType = currentSkill

      // 存储请求载荷
      updateAiMessage(bookId, assistantId, {
        requestPayload: {
          provider: 'agent',
          model: aiConfig.chat.model,
          temperature: aiConfig.chat.temperature,
          maxTokens: aiConfig.chat.maxTokens,
          thinkingEnabled: aiConfig.chat.thinkingEnabled,
          messages: [
            { role: 'system', content: `Skill: ${skill}, Book: ${bookId}` },
            ...history.map((h) => ({ role: h.role, content: h.content })),
            { role: 'user', content: input.trim() },
          ],
          ragContext: undefined,
          chapterSummary: undefined,
        },
      })

      await invoke<string>('execute_agent_skill', {
        skill,
        bookId,
        message: input.trim(),
        conversationHistory: history.length > 0 ? history : null,
        aiConfig: {
          provider: aiConfig.chat.provider,
          endpoint: aiConfig.chat.endpoint,
          model: aiConfig.chat.model,
          apiKey: chatApiKey,
          temperature: aiConfig.chat.temperature,
          maxTokens: aiConfig.chat.maxTokens,
          thinkingEnabled: aiConfig.chat.thinkingEnabled,
        },
        requestId,
        conversationSummary: currentSummary?.summary ?? null,
      })
    } catch (err) {
      // 如果 SSE error 事件已经处理过，避免重复更新
      if (!streamErrorRef.current) {
        const rawErr = String(err)
        const friendly = getFriendlyAiError(rawErr)
        updateAssistant(assistantId, `⚠️ ${friendly}\n\n> 错误详情：${rawErr}`, undefined, 'done')
        if (bookId) persistAiConversation(bookId)
      }
    } finally {
      setStreaming(false)
      if (streamRafRef.current) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [
    streaming, bookId, aiConfig, currentChapter, addAiMessage, updateAiMessage, 
    persistAiConversation, updateAssistant, updateAssistantUsage,
    summarizeOverflowMessages, messages
  ])

  return {
    streaming,
    embeddingGenerating,
    embeddingStatus,
    embeddingStatusLoading,
    handleSend,
    handleClear,
    handleDeleteMessage,
    handleGenerateEmbeddings,
    refreshEmbeddingStatus,
  }
}
