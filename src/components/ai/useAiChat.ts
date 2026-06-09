/**
 * AI 对话相关的自定义 hooks
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAppStore, useCurrentChapter, useCurrentAiMessages } from '@/stores/appStore'
import { aiApi, type StreamEvent, type UsageInfo, type EmbeddingStatus, type ChapterSummary } from '@/lib/tauri-bridge'
import { getChatApiKey, getRagApiKey } from '@/types'
import type { AiMessage, AiConfig } from '@/types'

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
  if (/timeout|timed out/.test(lower)) {
    return 'AI 服务响应超时，请检查网络连接后重试'
  }
  if (/connection|connect|network|econnrefused/.test(lower)) {
    return '无法连接到 AI 服务，请检查网络连接并在**设置**中确认 API 地址正确'
  }
  if (/500|503|internal server/.test(lower)) {
    return 'AI 服务暂时不可用，请稍后重试'
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
  const { volumes, chapters, addAiMessage, updateAiMessage, deleteAiMessage, clearAiConversation, persistAiConversation } = useAppStore()

  const [streaming, setStreaming] = useState(false)
  const [embeddingGenerating, setEmbeddingGenerating] = useState(false)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null)
  const [embeddingStatusLoading, setEmbeddingStatusLoading] = useState(false)

  const unlistenRef = useRef<UnlistenFn | null>(null)
  const streamErrorRef = useRef(false)

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

  // 构建消息数组（可选传入总结后的章节内容）
  const buildMessages = useCallback((context: string, input: string, chapterContent?: string): Array<{ role: string; content: string }> => {
    const volumeCtx = buildVolumeContext()
    const content = chapterContent ?? getCurrentChapterContent()
    const systemMsg = `你是一位专业的小说创作助手。请根据用户的需求提供创作建议、续写、润色等服务。${volumeCtx}${content}${context}`
    const history = messages.filter((m) => !m.loading).map((m) => ({ role: m.role, content: m.content }))
    return [
      { role: 'system', content: systemMsg },
      ...history,
      { role: 'user', content: input },
    ]
  }, [buildVolumeContext, getCurrentChapterContent, messages])

  // 更新助手消息
  const updateAssistant = useCallback((assistantId: string, content: string, thinking?: string, phase?: string) => {
    if (!bookId) return
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
      alert(`Embedding 生成失败: ${String(err)}`)
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

    try {
      const chapterContent = getCurrentChapterContent()
      const originalCharCount = getCurrentChapterRawCharCount()
      const needSummary = originalCharCount > 300
      let chapterSummaryInfo: ChapterSummary | null = null
      let finalChapterContent = chapterContent

      // 章节总结
      if (needSummary && currentChapter) {
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
        } catch {
          finalChapterContent = chapterContent
        }
      }

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
    getCurrentChapterContent, getCurrentChapterRawCharCount, getCurrentChapterRawText
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
