/**
 * useAgentChatStream — Agent 流式响应「传输桥接」hook
 *
 * 职责单一：管理 `agent-stream-chunk` 事件监听的生命周期与
 * 流式文本缓冲（requestAnimationFrame 合并刷新，避免逐 token 更新 store）。
 *
 * 对外 API：
 *   startStream(handlers) → Promise<requestId>：清理上一次监听后注册本次监听，
 *     返回供 invoke('execute_agent_skill', { requestId }) 使用的请求 ID。
 *   stopStream()：主动清理监听与未决的 rAF 刷新。
 *
 * 缓冲快照语义与引擎输出一致：content/thinking/phase/usage。
 */
import { useCallback, useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UsageInfo } from '@/lib/tauri-bridge'

/** 一次流式会话的缓冲快照 */
export interface AgentStreamPayload {
  content: string
  thinking: string
  phase?: string
  usage: UsageInfo | null
}

export interface AgentStreamHandlers {
  /** 缓冲被合并刷新（每帧至多一次）时回调 */
  onFlush: (payload: AgentStreamPayload) => void
  /** 引擎上报 error 事件（raw 为原始错误文本） */
  onError: (raw: string) => void
  /** 引擎上报 done 事件 */
  onDone: () => void
  /** 引擎上报 cancelled 事件 */
  onCancelled: () => void
}

export interface UseAgentChatStreamReturn {
  startStream: (handlers: AgentStreamHandlers) => Promise<string>
  stopStream: () => void
}

export function useAgentChatStream(): UseAgentChatStreamReturn {
  const unlistenRef = useRef<UnlistenFn | null>(null)
  const rafRef = useRef<number | null>(null)
  const handlersRef = useRef<AgentStreamHandlers | null>(null)
  const bufferRef = useRef<AgentStreamPayload>({
    content: '',
    thinking: '',
    phase: undefined,
    usage: null,
  })

  /** 将缓冲快照刷新给外层（外层负责写入消息 store） */
  const flushBuffer = useCallback(() => {
    const handlers = handlersRef.current
    if (!handlers) return
    const b = bufferRef.current
    handlers.onFlush({
      content: b.content,
      thinking: b.thinking,
      phase: b.phase,
      usage: b.usage,
    })
  }, [])

  const cancelRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  /** 清理监听与未决刷新 */
  const cleanup = useCallback(() => {
    cancelRaf()
    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }
    handlersRef.current = null
    bufferRef.current = { content: '', thinking: '', phase: undefined, usage: null }
  }, [cancelRaf])

  // 组件卸载兜底清理
  useEffect(() => {
    return cleanup
  }, [cleanup])

  const startStream = useCallback(
    async (handlers: AgentStreamHandlers): Promise<string> => {
      // 清理上一次监听（避免重复注册与旧事件污染）
      cleanup()
      handlersRef.current = handlers
      // 生成请求 ID，用于过滤属于自己的 SSE 事件
      const requestId =
        crypto.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      const scheduleFlush = () => {
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null
            flushBuffer()
          })
        }
      }

      unlistenRef.current = await listen<{
        event: string
        data: string
        requestId: string
      }>('agent-stream-chunk', (event) => {
        const { event: eventType, data, requestId: eventRequestId } = event.payload
        const currentHandlers = handlersRef.current
        if (!currentHandlers) return
        // 过滤不属于当前请求的事件
        if (eventRequestId && eventRequestId !== requestId) return

        if (eventType === 'error') {
          cancelRaf()
          currentHandlers.onError(data)
          return
        }

        if (eventType === 'chunk') {
          // 累积内容（覆盖写缓冲：content 全量、phase 标记回答中）
          bufferRef.current = {
            ...bufferRef.current,
            content: bufferRef.current.content + data,
            phase: 'answering',
          }
          scheduleFlush()
          return
        }

        if (eventType === 'done') {
          cancelRaf()
          flushBuffer()
          currentHandlers.onDone()
          return
        }

        if (eventType === 'cancelled') {
          cancelRaf()
          flushBuffer()
          currentHandlers.onCancelled()
        }
      })

      return requestId
    },
    [cleanup, flushBuffer, cancelRaf],
  )

  const stopStream = useCallback(() => {
    cleanup()
  }, [cleanup])

  return { startStream, stopStream }
}
