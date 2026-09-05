/**
 * Agent 状态管理 Hook
 *
 * Agent 已由 Python 外部进程迁移为 Rust 原生实现（无独立进程、始终就绪），
 * 因此不再需要「启动/停止/状态轮询」；本 Hook 负责 Skill 对话的流式收发：
 * - executeSkill：调用 execute_agent_skill（Rust 引擎直接与模型 API 通信）
 * - cancelSkill：取消当前任务
 * 流式输出使用 RAF 缓冲批量更新，避免高频重渲染。
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAiStore } from '@/stores/aiStore'
import { getChatApiKey } from '@/types'
import type {
  SkillType,
  AgentStreamEvent,
  AgentMessage,
  ChatHistoryItem,
} from './types'

// 简单的 UUID 生成（不引入额外依赖）
function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

export function useAgent() {
  // Agent 为 Rust 原生实现，状态恒为 running（无外部进程需要管理）
  const status = 'running' as const
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSkill, setActiveSkill] = useState<SkillType | null>(null)

  const accumulatedRef = useRef('')
  const unlistenRef = useRef<UnlistenFn | null>(null)
  const currentRequestIdRef = useRef<string>('')
  // RAF 缓冲优化：避免逐 chunk 触发重渲染
  const streamBufferRef = useRef<string>('')
  const streamRafRef = useRef<number | null>(null)
  // 追踪最后一个助手消息的 ID，用于批量更新
  const lastAssistantIdRef = useRef<string>('')

  /** 将缓冲区的流式数据刷新到状态 */
  const flushStreamBuffer = useCallback(() => {
    const buffered = streamBufferRef.current
    const aid = lastAssistantIdRef.current
    if (!aid || !buffered) return

    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === aid)
      if (idx === -1) return prev
      const updated = [...prev]
      updated[idx] = {
        ...updated[idx],
        content: buffered,
        isStreaming: true,
      }
      return updated
    })
  }, [])

  // 监听 Agent SSE 流
  const startListening = useCallback(async () => {
    if (unlistenRef.current) return

    const unlisten = await listen<AgentStreamEvent & { requestId?: string }>('agent-stream-chunk', (event) => {
      const { event: eventType, data } = event.payload

      // 过滤不属于当前请求的事件
      if (event.payload.requestId && event.payload.requestId !== currentRequestIdRef.current) return

      switch (eventType) {
        case 'chunk': {
          // RAF 缓冲：累积到缓冲区，每帧刷新一次
          accumulatedRef.current += data
          streamBufferRef.current = accumulatedRef.current

          if (streamRafRef.current === null) {
            streamRafRef.current = requestAnimationFrame(() => {
              flushStreamBuffer()
              streamRafRef.current = null
            })
          }
          break
        }
        case 'done': {
          // 确保最终内容刷新
          if (streamRafRef.current) {
            cancelAnimationFrame(streamRafRef.current)
            streamRafRef.current = null
          }
          flushStreamBuffer()

          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...last,
              content: accumulatedRef.current,
              isStreaming: false,
            }
            return updated
          })
          setIsStreaming(false)
          break
        }
        case 'error': {
          if (streamRafRef.current) {
            cancelAnimationFrame(streamRafRef.current)
            streamRafRef.current = null
          }

          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...last,
              content: accumulatedRef.current || data,
              isStreaming: false,
              error: data,
            }
            return updated
          })
          setError(data)
          setIsStreaming(false)
          break
        }
        case 'cancelled': {
          if (streamRafRef.current) {
            cancelAnimationFrame(streamRafRef.current)
            streamRafRef.current = null
          }
          flushStreamBuffer()

          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...last,
              content: accumulatedRef.current,
              isStreaming: false,
            }
            return updated
          })
          setIsStreaming(false)
          break
        }
      }
    })

    unlistenRef.current = unlisten
  }, [flushStreamBuffer])

  // 停止监听
  const stopListening = useCallback(() => {
    unlistenRef.current?.()
    unlistenRef.current = null
  }, [])

  // 清理
  useEffect(() => {
    return () => {
      stopListening()
      if (streamRafRef.current) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
    }
  }, [stopListening])

  // 执行 Skill
  const executeSkill = useCallback(
    async (skill: SkillType, bookId: string, message: string, history?: ChatHistoryItem[]) => {
      if (isStreaming) return

      setError(null)
      setActiveSkill(skill)
      accumulatedRef.current = ''
      streamBufferRef.current = ''

      // 生成请求 ID，用于过滤属于自己的 SSE 事件
      const requestId = generateId()
      currentRequestIdRef.current = requestId

      // 添加用户消息
      const userMsg: AgentMessage = {
        id: generateId(),
        role: 'user',
        content: message,
        skill,
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, userMsg])

      // 添加 AI 占位消息
      const aiId = generateId()
      lastAssistantIdRef.current = aiId
      const aiMsg: AgentMessage = {
        id: aiId,
        role: 'assistant',
        content: '',
        skill,
        timestamp: Date.now(),
        isStreaming: true,
      }
      setMessages((prev) => [...prev, aiMsg])

      setIsStreaming(true)

      try {
        // 确保在监听
        await startListening()

        // 获取 AI 配置
        const aiConfig = useAiStore.getState().aiConfig
        const chatApiKey = getChatApiKey(aiConfig.chat)

        await invoke<string>('execute_agent_skill', {
          skill,
          bookId,
          message,
          conversationHistory: history ?? null,
          aiConfig: {
            provider: aiConfig.chat.provider,
            endpoint: aiConfig.chat.endpoint,
            model: aiConfig.chat.model,
            apiKey: chatApiKey,
            temperature: aiConfig.chat.temperature,
            maxTokens: aiConfig.chat.maxTokens,
            thinkingEnabled: aiConfig.chat.thinkingEnabled,
            // DeepSeek 思考强度：Agent 场景默认 max
            reasoningEffort: 'max',
          },
          requestId,
          // Skill 模式为独立任务轮次（每轮自带工具检索与记忆注入），
          // 无需注入会话滑动窗口摘要；聊天模式的总结由 useAiChat 负责传递。
          conversationSummary: null,
        })
      } catch (e) {
        const errMsg = String(e)
        setError(errMsg)
        setMessages((prev) => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (last && last.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              isStreaming: false,
              error: errMsg,
            }
          }
          return updated
        })
        setIsStreaming(false)
      }
    },
    [isStreaming, startListening],
  )

  // 取消当前任务
  const cancelSkill = useCallback(async () => {
    try {
      await invoke('cancel_agent_skill')
      setIsStreaming(false)
      if (streamRafRef.current) {
        cancelAnimationFrame(streamRafRef.current)
        streamRafRef.current = null
      }
    } catch (e) {
      setError(String(e))
    }
  }, [])

  // 清空消息
  const clearMessages = useCallback(() => {
    setMessages([])
    accumulatedRef.current = ''
    streamBufferRef.current = ''
    setError(null)
    setActiveSkill(null)
  }, [])

  return {
    status,
    messages,
    isStreaming,
    error,
    activeSkill,
    executeSkill,
    cancelSkill,
    clearMessages,
  }
}
