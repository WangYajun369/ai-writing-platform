/**
 * AiSidePanel — AI 助手侧面板
 *
 * 支持两种模式：
 * - AI 聊天模式：原有对话方式，通过 invoke 直接调用 AI
 * - Agent 模式：通过 Python Agent 服务，支持技能选择、流式输出
 *
 * 子组件拆分到 ./panel/ 目录：
 *  - Header         → 头部（模式切换、连接状态、技能选择器）
 *  - MessageList    → AI 聊天消息列表
 *  - QuickHints     → 快捷提示词
 *  - InputArea      → AI 聊天输入区域
 *  - AgentMessageList → Agent 模式消息列表
 *  - AgentInputArea → Agent 模式输入区域
 *  - ModelCheckIcon → 模型检测图标
 *  - EmbeddingStatus→ Embedding 索引状态
 *  - constants      → 状态配置 / getAgentQuickActions
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAppStore, useCurrentAiMessages, useCurrentBook } from '@/stores/appStore'
import type { ChatRequestPayload } from '@/types'
import { getChatApiKey } from '@/types'
import { aiApi } from '@/lib/tauri-bridge'
import { useAiChat, PROVIDER_LABELS } from './useAiChat'
import { RequestDetailModal } from './RequestDetailModal'
import { useAgent } from '@/components/agent/useAgent'
import type { AgentStatus, SkillType } from '@/components/agent/types'
import { Header } from './panel/Header'
import { MessageList } from './panel/MessageList'
import { QuickHints } from './panel/QuickHints'
import { InputArea } from './panel/InputArea'
import { AgentMessageList } from './panel/AgentMessageList'
import { AgentInputArea } from './panel/AgentInputArea'
import { mapAgentStatus } from './panel/constants'

type PanelMode = 'chat' | 'agent'

export default function AiSidePanel() {
  const [mode, setMode] = useState<PanelMode>('chat')
  const messages = useCurrentAiMessages()
  const [input, setInput] = useState('')
  const [selectedSkill, setSelectedSkill] = useState<SkillType>('writing')
  const [detailPayload, setDetailPayload] = useState<ChatRequestPayload | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)

  const { aiConfig, currentBookId } = useAppStore()
  const book = useCurrentBook()
  const {
    streaming,
    embeddingGenerating,
    embeddingStatus,
    embeddingStatusLoading,
    handleSend,
    handleClear,
    handleDeleteMessage,
    handleGenerateEmbeddings,
  } = useAiChat({ bookId: currentBookId ?? '', aiConfig, skill: selectedSkill })

  // Agent 模式 hooks
  const {
    status: agentStatus,
    messages: agentMessages,
    isStreaming: agentStreaming,
    error: agentError,
    startAgent,
    stopAgent,
    executeSkill,
    cancelSkill,
    clearMessages: clearAgentMessages,
  } = useAgent()

  // Agent 连接状态（Rust 侧自动启动，前端只监听状态变化）
  const [agentStatusDisplay, setAgentStatusDisplay] = useState<AgentStatus>('stopped')
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    listen<{ status: string; message: string }>('agent-status-changed', (event) => {
      const { status: s } = event.payload
      if (s === 'running') setAgentStatusDisplay('running')
      else if (s === 'stopped') setAgentStatusDisplay('stopped')
      else if (s === 'starting') setAgentStatusDisplay('starting')
      else if (s.startsWith('crashed')) setAgentStatusDisplay('crashed')
    }).then((fn) => { unlisten = fn }).catch(() => {})
    return () => { unlisten?.() }
  }, [])

  const providerLabel = PROVIDER_LABELS[aiConfig.chat.provider] ?? aiConfig.chat.provider
  const modelName = aiConfig.chat.model

  // 模型可用性检测
  const [modelCheckStatus, setModelCheckStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [modelCheckDetail, setModelCheckDetail] = useState('')
  const handleCheckModel = useCallback(async () => {
    setModelCheckStatus('checking')
    setModelCheckDetail('')
    try {
      const chatApiKey = getChatApiKey(aiConfig.chat)
      const result = await aiApi.testConnection(aiConfig.chat.provider, aiConfig.chat.endpoint, chatApiKey)
      if (result.ok) {
        setModelCheckStatus('ok')
        setModelCheckDetail(result.detail)
      } else {
        setModelCheckStatus('error')
        setModelCheckDetail(result.detail)
      }
    } catch (err) {
      setModelCheckStatus('error')
      setModelCheckDetail(String(err))
    }
  }, [aiConfig])

  const statusKey = mapAgentStatus(agentStatusDisplay)

  // 稳定回调引用，避免子组件 memo 失效
  const onShowDetail = useCallback((payload: ChatRequestPayload) => {
    setDetailPayload(payload)
  }, [])
  const onCloseDetail = useCallback(() => {
    setDetailPayload(null)
  }, [])

  // 打开面板时滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动滚动到底部：仅当流式进行中且用户在底部附近时滚动
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isStreaming = mode === 'agent' ? agentStreaming : streaming
  const allMessages = mode === 'agent' ? agentMessages : messages
  useEffect(() => {
    if (!isStreaming || !scrollContainerRef.current) return
    if (scrollRafRef.current) return
    const container = scrollContainerRef.current
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
  }, [allMessages, isStreaming])

  const onSend = useCallback(() => {
    if (input.trim() && !streaming && currentBookId) {
      void handleSend(input)
      setInput('')
    }
  }, [input, streaming, currentBookId, handleSend])

  const onAgentSend = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || !book?.id || agentStreaming) return
    setInput('')
    const history = agentMessages
      .filter((m) => m.role !== 'system')
      .slice(-20)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))
    await executeSkill(selectedSkill, book.id, trimmed, history)
  }, [input, book?.id, agentStreaming, selectedSkill, agentMessages, executeSkill])

  const onClear = mode === 'agent' ? clearAgentMessages : handleClear

  return (
    <div className="flex flex-col h-full min-h-0">
      <Header
        mode={mode}
        onModeChange={setMode}
        providerLabel={providerLabel}
        modelName={modelName}
        modelCheckStatus={modelCheckStatus}
        modelCheckDetail={modelCheckDetail}
        onCheckModel={handleCheckModel}
        statusKey={statusKey}
        selectedSkill={selectedSkill}
        onSkillChange={setSelectedSkill}
        onClear={onClear}
        agentStatus={agentStatus}
        onStartAgent={startAgent}
        onStopAgent={stopAgent}
      />

      {/* 消息列表 */}
      {mode === 'chat' ? (
        <MessageList
          messages={messages}
          bottomRef={bottomRef}
          scrollContainerRef={scrollContainerRef}
          onDelete={handleDeleteMessage}
          onShowDetail={onShowDetail}
          bookId={currentBookId ?? undefined}
        />
      ) : (
        <AgentMessageList
          messages={agentMessages}
          agentStatus={agentStatus}
          selectedSkill={selectedSkill}
          error={agentError}
          onSelectQuick={setInput}
          bottomRef={bottomRef}
          scrollContainerRef={scrollContainerRef}
        />
      )}

      {/* 快捷提示词（仅聊天模式） */}
      {mode === 'chat' && messages.length === 0 && <QuickHints onSelect={setInput} />}

      {/* 输入框 */}
      {mode === 'chat' ? (
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
      ) : (
        <AgentInputArea
          input={input}
          onChange={setInput}
          onSend={onAgentSend}
          isStreaming={agentStreaming}
          agentStatus={agentStatus}
          selectedSkill={selectedSkill}
          onCancel={cancelSkill}
        />
      )}

      {/* 请求详情弹窗 */}
      {detailPayload && <RequestDetailModal payload={detailPayload} onClose={onCloseDetail} />}
    </div>
  )
}
