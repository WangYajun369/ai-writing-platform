/**
 * useAiChat — AI 对话编排 hook
 *
 * 已拆分为 4 个职责单一的 hook（问题 6）：
 * - useAiChatMessages           消息仓储（读改写/持久化）
 * - useConversationSummarizer   滑动窗口历史摘要
 * - useAgentChatStream          Agent 流式传输桥接（监听/缓冲/合并刷新）
 * - useAiChat（本文件）         主编排：前置校验 → 组合上述能力 → invoke Agent 引擎
 *
 * 纯工具导出（getFriendlyAiError / QUICK_HINTS / PROVIDER_LABELS /
 * stripHtmlToText）保留在此处，供 AiSidePanel / AiToolboxPanel / QuickHints 引用。
 */
import { useCallback, useRef, useState } from 'react'
import { errText } from '@/lib/errors'
import { invoke } from '@tauri-apps/api/core'
import { useCurrentChapter, useCurrentAiMessages } from '@/stores/appStore'
import { useAiStore } from '@/stores/aiStore'
import { bookApi, chapterApi } from '@/lib/tauri-bridge'
import { getChatApiKey } from '@/types'
import { toast } from '@/lib/toast'
import type { AiMessage, AiConfig, Chapter } from '@/types'
import type { SkillType } from '@/components/agent/types'
import { useAiChatMessages } from './hooks/useAiChatMessages'
import { useConversationSummarizer } from './hooks/useConversationSummarizer'
import { useAgentChatStream } from './hooks/useAgentChatStream'

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
  if (/dns|resolve|域名解析/.test(lower)) {
    return 'DNS 解析失败，无法访问 AI 服务。请检查网络连接，或尝试在系统中设置 HTTPS_PROXY 环境变量后重启应用'
  }
  if (/refused|拒绝/.test(lower)) {
    return '连接被拒绝，请确认 AI 服务地址正确且端口可访问，或检查防火墙/代理设置'
  }
  if (/tls|certificate|ssl|证书/.test(lower)) {
    return 'TLS 证书验证失败，请检查系统时间是否正确。若使用代理，请设置 HTTPS_PROXY 环境变量后重启应用'
  }
  if (/connection|connect|network|econnrefused|eof|reset|broken pipe/.test(lower)) {
    return '网络连接不稳定，已自动重试，若持续失败请检查网络并在**设置**中确认 API 地址正确'
  }
  if (/500|502|503|504|internal server|unavailable/.test(lower)) {
    return 'AI 服务暂时不可用，已自动重试，请稍后'
  }
  if (/诊断/.test(rawError)) {
    // 后端已附带诊断信息，提取用户可读提示
    return 'AI 响应异常，请在**设置**中检查 AI 是否可用'
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
  handleSend: (input: string) => Promise<void>
  handleClear: () => void
  handleDeleteMessage: (messageId: string) => void
}

export function useAiChat(options: UseAiChatOptions): UseAiChatReturn {
  const { bookId, aiConfig, skill: currentSkill = 'writing' } = options
  const messages = useCurrentAiMessages()
  const currentChapter = useCurrentChapter()

  // ── 组合职责 hook（方法均为稳定引用，可安全进入依赖数组） ──
  const {
    addPair,
    updateAssistant,
    updateAssistantUsage,
    patchMessage,
    deleteMessage,
    clearConversation,
    persist,
  } = useAiChatMessages(bookId)
  const { summarizeIfNeeded, currentSummary } = useConversationSummarizer(
    bookId,
    aiConfig,
  )
  const { startStream, stopStream } = useAgentChatStream()

  const [streaming, setStreaming] = useState(false)
  // 本次会话内是否已收到 SSE error 事件（避免 invoke 抛错时重复提示）
  const streamErrorRef = useRef(false)

  // 清空对话（带确认）
  const handleClear = useCallback(() => {
    if (messages.length > 0 && bookId && confirm('清空当前作品的对话记录？')) {
      clearConversation()
    }
  }, [messages, bookId, clearConversation])

  // 删除消息
  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      deleteMessage(messageId)
    },
    [deleteMessage],
  )

  // 发送消息
  const handleSend = useCallback(
    async (input: string) => {
      if (!input.trim() || streaming || !bookId) return

      const chatApiKey = getChatApiKey(aiConfig.chat)
      if (!chatApiKey) {
        toast.warning('请先在设置中配置 API Key')
        return
      }

      const userMsg: AiMessage = { id: Date.now().toString(), role: 'user', content: input.trim(), thinking: '', phase: 'done' }
      const assistantId = (Date.now() + 1).toString()
      const assistantMsg: AiMessage = { id: assistantId, role: 'assistant', content: '', thinking: '', phase: 'thinking', loading: true, isSummarizing: false }

      addPair(userMsg, assistantMsg)
      setStreaming(true)
      streamErrorRef.current = false

      /** 前置校验不通过时：提示并标记消息为大纲缺失类型 */
      const stopWithOutlineHint = async (hint: string) => {
        updateAssistant(assistantId, hint, undefined, 'done')
        patchMessage(assistantId, { action: 'open-world-outline' })
        setStreaming(false)
        persist()
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

        const requestId = await startStream({
          onFlush: (payload) => {
            updateAssistant(assistantId, payload.content, payload.thinking, payload.phase)
            if (payload.usage) updateAssistantUsage(assistantId, payload.usage)
          },
          onError: (raw) => {
            streamErrorRef.current = true
            const friendly = getFriendlyAiError(raw)
            updateAssistant(assistantId, `⚠️ ${friendly}\n\n> 错误详情：${raw}`, undefined, 'done')
            setStreaming(false)
            persist()
          },
          onDone: () => {
            setStreaming(false)
            persist()
            // 后台触发对话历史总结
            const allMsgs = useAiStore.getState().aiConversations[bookId] ?? []
            void summarizeIfNeeded(allMsgs)
          },
          onCancelled: () => {
            setStreaming(false)
            persist()
          },
        })

        // ==================== 阶段 2：调用 Agent Skill ====================

        // 构建对话历史（最近 20 条非 loading 消息）
        const validMsgs = messages.filter((m) => !m.loading && (m.role === 'user' || m.role === 'assistant'))
        const recentMsgs = validMsgs.slice(-20)
        const history = recentMsgs.map((m) => ({ role: m.role, content: m.content }))

        // 存储请求载荷
        patchMessage(assistantId, {
          requestPayload: {
            provider: 'agent',
            model: aiConfig.chat.model,
            temperature: aiConfig.chat.temperature,
            maxTokens: aiConfig.chat.maxTokens,
            thinkingEnabled: aiConfig.chat.thinkingEnabled,
            messages: [
              { role: 'system', content: `Skill: ${currentSkill}, Book: ${bookId}` },
              ...history.map((h) => ({ role: h.role, content: h.content })),
              { role: 'user', content: input.trim() },
            ],
            ragContext: undefined,
            chapterSummary: undefined,
          },
        })

        await invoke<string>('execute_agent_skill', {
          skill: currentSkill,
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
          const rawErr = errText(err, '未知错误')
          const friendly = getFriendlyAiError(rawErr)
          updateAssistant(assistantId, `⚠️ ${friendly}\n\n> 错误详情：${rawErr}`, undefined, 'done')
          persist()
        }
      } finally {
        setStreaming(false)
        stopStream()
      }
    },
    [
      streaming,
      bookId,
      aiConfig,
      currentChapter,
      currentSkill,
      currentSummary,
      messages,
      addPair,
      updateAssistant,
      updateAssistantUsage,
      patchMessage,
      persist,
      startStream,
      stopStream,
      summarizeIfNeeded,
    ],
  )

  return {
    streaming,
    handleSend,
    handleClear,
    handleDeleteMessage,
  }
}
