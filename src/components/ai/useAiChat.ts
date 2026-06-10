/**
 * AI 对话相关的自定义 hooks
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAppStore, useCurrentChapter, useCurrentAiMessages } from '@/stores/appStore'
import { aiApi, bookApi, chapterApi, type StreamEvent, type UsageInfo, type EmbeddingStatus, type ChapterSummary } from '@/lib/tauri-bridge'
import { getChatApiKey, getRagApiKey } from '@/types'
import type { AiMessage, AiConfig, ConversationSummary, Chapter } from '@/types'
import type { ChatMessage } from '@/lib/tauri-bridge'

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
  const { bookId, aiConfig } = options
  const messages = useCurrentAiMessages()
  const currentChapter = useCurrentChapter()
  const { volumes, chapters, aiSummaries, addAiMessage, updateAiMessage, deleteAiMessage, clearAiConversation, persistAiConversation, setConversationSummary } = useAppStore()

  const [streaming, setStreaming] = useState(false)
  const [embeddingGenerating, setEmbeddingGenerating] = useState(false)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  const [embeddingStatusLoading, setEmbeddingStatusLoading] = useState(false)

  const unlistenRef = useRef<UnlistenFn | null>(null)
  const streamErrorRef = useRef(false)
  const summarizingRef = useRef(false) // 防止并发总结

  // 清理事件监听
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
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

  // 构建卷上下文
  const buildVolumeContext = useCallback((): string => {
    if (!currentChapter?.volumeId) return ''
    const vol = volumes.find((v) => v.id === currentChapter.volumeId)
    if (!vol) return ''
    const volChapters = chapters
      .filter((c) => c.volumeId === currentChapter.volumeId && !c.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    if (volChapters.length === 0) return ''
    const chapterList = volChapters
      .map((c) => c.id === currentChapter.id ? `★「${c.title}」(当前)` : `「${c.title}」`)
      .join(' → ')
    return `\n当前卷：${vol.title}\n卷内章节脉络：${chapterList}`
  }, [currentChapter, volumes, chapters])

  // 获取章节原始文本
  const getCurrentChapterRawText = useCallback((): string => {
    if (!currentChapter) return ''
    const editor = document.querySelector('.ProseMirror')
    if (editor) {
      const text = editor.textContent?.trim() ?? ''
      if (text.length > 0) return text
    }
    if (currentChapter.contentHtml) {
      return currentChapter.contentHtml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    }
    return ''
  }, [currentChapter])

  // 获取章节纯文本（限制2000字）
  const getCurrentChapterContent = useCallback((): string => {
    if (!currentChapter) return ''
    const text = getCurrentChapterRawText()
    if (text.length === 0) return ''
    return stripHtmlToText(`\n\n当前编辑章节「${currentChapter.title}」的内容：\n${text}`)
  }, [currentChapter, getCurrentChapterRawText])

  // 获取章节原始字符数
  const getCurrentChapterRawCharCount = useCallback((): number => {
    return getCurrentChapterRawText().length
  }, [getCurrentChapterRawText])

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

  // 构建消息数组（滑动窗口 + 摘要注入）
  const buildMessages = useCallback((context: string, input: string, chapterContent?: string): Array<{ role: string; content: string }> => {
    const volumeCtx = buildVolumeContext()
    const content = chapterContent ?? getCurrentChapterContent()

    // system prompt 基础部分
    let systemMsg = `你是一位专业的小说创作助手。请根据用户的需求提供创作建议、续写、润色等服务。${volumeCtx}${content}${context}`

    // 注入历史对话摘要（如果存在）
    if (currentSummary?.summary) {
      systemMsg = `${systemMsg}\n\n[历史对话摘要] 以下是用户之前与助手的对话精华：\n${currentSummary.summary}`
    }

    // 滑动窗口：仅保留最近 N 轮完整历史
    const validMsgs = messages.filter((m) => !m.loading && (m.role === 'user' || m.role === 'assistant'))
    const keepCount = windowSize * 2
    const recentMsgs = validMsgs.length > keepCount
      ? validMsgs.slice(validMsgs.length - keepCount)
      : validMsgs

    const history = recentMsgs.map((m) => ({ role: m.role, content: m.content }))

    return [
      { role: 'system', content: systemMsg },
      ...history,
      { role: 'user', content: input },
    ]
  }, [buildVolumeContext, getCurrentChapterContent, messages, currentSummary, windowSize])

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
      alert(`Embedding 生成失败\n\n${msg}\n\n排查建议：\n1. 检查 API Key 是否有 Embedding 模型（embedding-3）的调用权限\n2. 单条文本过长可能超过 3072 tokens 限制（已自动截断）\n3. 检查 Endpoint 地址是否正确（默认 https://open.bigmodel.cn/api/paas/v4）`)
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
    const assistantMsg: AiMessage = { id: assistantId, role: 'assistant', content: '', thinking: '', phase: 'summarizing', loading: true, isSummarizing: false }

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

      // ==================== 阶段 1：章节内容处理 ====================

      const chapterContent = getCurrentChapterContent()
      const originalCharCount = getCurrentChapterRawCharCount()
      let chapterSummaryInfo: ChapterSummary | null = null
      let finalChapterContent: string

      if (originalCharCount === 0) {
        // 章节无内容，不提交章节正文
        finalChapterContent = ''
      } else if (originalCharCount <= 300) {
        // 内容较短，直接提交原始内容
        finalChapterContent = chapterContent
      } else {
        // 内容 > 300 字 → 需要总结
        if (!currentChapter) {
          finalChapterContent = chapterContent
        } else {
          // 1）尝试从已有缓存中读取
          let cachedSummary: { summary: string | null; summaryAt: string | null } | null = null
          if (currentChapter.summary) {
            cachedSummary = { summary: currentChapter.summary, summaryAt: currentChapter.summaryAt ?? null }
          } else {
            cachedSummary = await chapterApi.getSummary(currentChapter.id).catch(() => null)
          }

          if (cachedSummary?.summary) {
            // 已有缓存，直接复用
            const rawText = getCurrentChapterRawText()
            chapterSummaryInfo = {
              summary: cachedSummary.summary,
              originalChars: rawText.length,
              summaryChars: cachedSummary.summary.length,
              thinking: '',
            }
            finalChapterContent = `\n\n当前编辑章节「${currentChapter.title}」的总结（原文${chapterSummaryInfo.originalChars}字）：\n${chapterSummaryInfo.summary}`
          } else {
            // 无缓存 → 先调用 AI 总结，再继续
            updateAssistant(assistantId, '正在总结章节内容…', undefined, 'summarizing')
            try {
              chapterSummaryInfo = await aiApi.summarizeChapter({
                endpoint: aiConfig.chat.endpoint,
                model: aiConfig.chat.model,
                apiKey: chatApiKey,
                temperature: 0.7,
                maxTokens: 2000,
                chapterTitle: currentChapter.title,
                chapterContent: getCurrentChapterRawText(),
                thinkingEnabled: aiConfig.chat.thinkingEnabled,
              })
              finalChapterContent = `\n\n当前编辑章节「${currentChapter.title}」的总结（原文${chapterSummaryInfo.originalChars}字）：\n${chapterSummaryInfo.summary}`
              // 持久化总结，下次直接复用
              chapterApi.saveSummary(currentChapter.id, chapterSummaryInfo.summary).catch(() => {})
              useAppStore.getState().updateChapter(currentChapter.id, {
                summary: chapterSummaryInfo.summary,
                summaryAt: new Date().toISOString(),
              })
            } catch {
              // 总结失败，回退到原始内容
              finalChapterContent = chapterContent
            }
          }
        }
      }

      // ==================== 阶段 2：思考 + RAG + 流式对话 ====================

      // 思考阶段
      updateAssistant(assistantId, '', undefined, 'thinking')

      // RAG 检索
      let context = ''
      let ragResults: { snippet: string; sourceType?: string; sourceTitle?: string; score?: number }[] = []
      if (currentChapter && aiConfig.rag.enabled) {
        const results = await aiApi.ragSearch(
          currentChapter.bookId, input, 3, aiConfig.rag.endpoint,
          getRagApiKey(aiConfig.rag) || chatApiKey, aiConfig.rag.embeddingModel
        ).catch(() => [])
        if (results.length > 0) {
          context = '\n\n相关背景：\n' + results.map(
            (r) => `[${r.sourceType === 'world_card' ? '世界观·' + r.sourceTitle : '章节·' + r.sourceTitle}]\n${r.snippet}`
          ).join('\n---\n')
          ragResults = results.map((r) => ({
            snippet: r.snippet,
            sourceType: r.sourceType,
            sourceTitle: r.sourceTitle,
            score: 1 - r.distance,
          }))
        }
      }

      // 注册流式监听
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
      streamErrorRef.current = false
      unlistenRef.current = await listen<StreamEvent>('ai-stream-chunk', (event) => {
        const { content, thinking, phase, done, error, usage } = event.payload
        if (error) {
          streamErrorRef.current = true
          const friendly = getFriendlyAiError(error)
          updateAssistant(assistantId, `⚠️ ${friendly}\n\n> 错误详情：${error}`, thinking, 'done')
          setStreaming(false)
          persistAiConversation(bookId)
          return
        }
        updateAssistant(assistantId, content, thinking, phase)
        if (usage) updateAssistantUsage(assistantId, usage)
        if (done) {
          setStreaming(false)
          persistAiConversation(bookId)
          // 后台触发对话历史总结（不阻塞 UI）
          const allMsgs = useAppStore.getState().aiConversations[bookId] ?? []
          void summarizeOverflowMessages(allMsgs)
        }
      })

      // 构建消息（使用总结后的内容）
      const chatMessages = buildMessages(context, input, finalChapterContent)

      // 存储请求载荷
      updateAiMessage(bookId, assistantId, {
        requestPayload: {
          provider: aiConfig.chat.provider,
          model: aiConfig.chat.model,
          temperature: aiConfig.chat.temperature,
          maxTokens: aiConfig.chat.maxTokens,
          thinkingEnabled: aiConfig.chat.thinkingEnabled,
          messages: chatMessages,
          ragContext: ragResults.length > 0 ? ragResults : undefined,
          chapterSummary: chapterSummaryInfo ? {
            summary: chapterSummaryInfo.summary,
            originalChars: chapterSummaryInfo.originalChars,
            summaryChars: chapterSummaryInfo.summaryChars,
            thinking: chapterSummaryInfo.thinking,
          } : undefined,
        },
      })

      // 调用流式对话
      await aiApi.streamChat({
        provider: 'sse',
        endpoint: aiConfig.chat.endpoint,
        model: aiConfig.chat.model,
        temperature: aiConfig.chat.temperature,
        maxTokens: aiConfig.chat.maxTokens,
        apiKey: chatApiKey,
        thinkingEnabled: aiConfig.chat.thinkingEnabled,
        messages: chatMessages,
      })
    } catch (err) {
      const rawErr = String(err)
      const friendly = getFriendlyAiError(rawErr)
      updateAssistant(assistantId, `⚠️ ${friendly}\n\n> 错误详情：${rawErr}`, undefined, 'done')
      if (bookId) persistAiConversation(bookId)
    } finally {
      setStreaming(false)
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [
    streaming, bookId, aiConfig, currentChapter, addAiMessage, updateAiMessage, 
    persistAiConversation, updateAssistant, updateAssistantUsage, buildMessages,
    getCurrentChapterContent, getCurrentChapterRawCharCount, getCurrentChapterRawText,
    summarizeOverflowMessages
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
