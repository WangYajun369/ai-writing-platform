/**
 * useAiChatMessages — AI 对话「消息仓储」hook
 *
 * 职责单一：封装对 appStore.aiConversations 的读改写、持久化与便捷消息操作。
 * 由 useAiChat 编排层组合调用，不再承担发送/流式/摘要逻辑。
 */
import { useCallback } from 'react'
import { useAiStore } from '@/stores/aiStore'
import type { AiMessage } from '@/types'
import type { UsageInfo } from '@/lib/tauri-bridge'

export function useAiChatMessages(bookId: string) {
  const addAiMessage = useAiStore((s) => s.addAiMessage)
  const updateAiMessage = useAiStore((s) => s.updateAiMessage)
  const deleteAiMessage = useAiStore((s) => s.deleteAiMessage)
  const clearAiConversation = useAiStore((s) => s.clearAiConversation)
  const persistAiConversation = useAiStore((s) => s.persistAiConversation)

  /** 一次性追加 user + assistant 消息对 */
  const addPair = useCallback(
    (userMsg: AiMessage, assistantMsg: AiMessage) => {
      if (!bookId) return
      addAiMessage(bookId, userMsg)
      addAiMessage(bookId, assistantMsg)
    },
    [bookId, addAiMessage],
  )

  /** 更新助手消息（含 retrying 阶段特例：不覆盖内容，仅置 loading） */
  const updateAssistant = useCallback(
    (
      assistantId: string,
      content: string,
      thinking?: string,
      phase?: string,
    ) => {
      if (!bookId) return
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
    },
    [bookId, updateAiMessage],
  )

  /** 更新助手消息的 token 用量 */
  const updateAssistantUsage = useCallback(
    (assistantId: string, usage: UsageInfo) => {
      if (!bookId) return
      updateAiMessage(bookId, assistantId, { usage })
    },
    [bookId, updateAiMessage],
  )

  /** 通用局部更新（请求载荷等） */
  const patchMessage = useCallback(
    (messageId: string, patch: Partial<AiMessage>) => {
      if (!bookId) return
      updateAiMessage(bookId, messageId, patch)
    },
    [bookId, updateAiMessage],
  )

  /** 删除单条消息 */
  const deleteMessage = useCallback(
    (messageId: string) => {
      if (!bookId) return
      deleteAiMessage(bookId, messageId)
    },
    [bookId, deleteAiMessage],
  )

  /** 清空对话（直接执行，确认逻辑由调用方负责） */
  const clearConversation = useCallback(() => {
    if (!bookId) return
    clearAiConversation(bookId)
  }, [bookId, clearAiConversation])

  /** 持久化当前对话到后端 */
  const persist = useCallback(() => {
    if (!bookId) return
    persistAiConversation(bookId)
  }, [bookId, persistAiConversation])

  return {
    addPair,
    updateAssistant,
    updateAssistantUsage,
    patchMessage,
    deleteMessage,
    clearConversation,
    persist,
  }
}
