/**
 * useConversationSummarizer — AI 对话「滑动窗口摘要」hook
 *
 * 职责单一：当对话超出 contextWindowSize 时，将溢出历史压缩为摘要
 * 并在后台推进（覆盖到最新溢出消息的 id），不阻塞当前请求。
 * 由 useAiChat 编排层组合调用。
 */
import { useCallback, useRef } from 'react'
import { useAiStore } from '@/stores/aiStore'
import { aiApi } from '@/lib/tauri-bridge'
import type { ChatMessage } from '@/lib/tauri-bridge'
import { getChatApiKey } from '@/types'
import type { AiConfig, AiMessage, ConversationSummary } from '@/types'

export function useConversationSummarizer(bookId: string, aiConfig: AiConfig) {
  const aiSummaries = useAiStore((s) => s.aiSummaries)
  const setConversationSummary = useAiStore((s) => s.setConversationSummary)

  // 防止并发总结
  const summarizingRef = useRef(false)

  // 窗口大小：每轮 = user + assistant，至少保留 1 轮
  const windowSize = Math.max(1, aiConfig.chat.contextWindowSize ?? 10)
  const currentSummary = bookId ? aiSummaries[bookId] : undefined

  /** 将超出窗口的历史消息压缩为摘要（后台执行，不阻塞当前请求） */
  const summarizeIfNeeded = useCallback(
    async (allMsgs: AiMessage[]) => {
      if (!bookId || summarizingRef.current) return
      const validMsgs = allMsgs.filter(
        (m) => m.role === 'user' || m.role === 'assistant',
      )
      const totalTurns = Math.floor(validMsgs.length / 2)
      // 未超出窗口，无需总结
      if (totalTurns <= windowSize) return

      const keepCount = windowSize * 2
      const overflowMsgs = validMsgs.slice(0, validMsgs.length - keepCount)

      // 摘要已覆盖到最新溢出消息，无需重复总结
      if (currentSummary && overflowMsgs.length > 0) {
        const lastOverflowId = overflowMsgs[overflowMsgs.length - 1].id
        if (
          currentSummary.coveredUpToId === lastOverflowId &&
          currentSummary.summary
        ) {
          return
        }
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
    },
    [bookId, aiConfig, windowSize, currentSummary, setConversationSummary],
  )

  return { summarizeIfNeeded, currentSummary }
}
