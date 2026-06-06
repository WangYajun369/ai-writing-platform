/**
 * AiSidePanel — AI 助手侧面板
 *
 * 支持多服务商流式对话（Ollama / OpenAI / 智谱 BigModel / 自定义），
 * 自动 RAG 检索当前书籍上下文。
 * 流式调用由 Rust 侧通过 reqwest 处理，前端通过 Tauri 事件接收增量。
 */
import { useState, useRef, useEffect } from 'react'
import { SendIcon, BotIcon, XIcon, Loader2Icon, CircleCheckIcon, CircleAlertIcon, CircleIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAppStore, useCurrentChapter } from '@/stores/appStore.ts'
import { aiApi, type StreamEvent } from '@/lib/tauri-bridge.ts'
import { cn } from '@/lib/utils.ts'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  loading?: boolean
}

export default function AiSidePanel() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const { aiConfig, aiConnectionStatus, aiConnectionDetail } = useAppStore()
  const currentChapter = useCurrentChapter()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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

  /** 更新助手消息内容 */
  function updateAssistant(assistantId: string, content: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === assistantId ? { ...m, content, loading: false } : m))
    )
  }

  async function handleSend() {
    if (!input.trim() || streaming) return

    // 非 Ollama 提供者必须提供 API Key
    if (!isOllamaProvider && !aiConfig.apiKey) {
      alert('请先在设置中配置 API Key')
      return
    }

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: input.trim() }
    const assistantId = (Date.now() + 1).toString()
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', loading: true }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    const userInput = input.trim()
    setInput('')
    setStreaming(true)

    // 注册事件监听，用于接收流式数据
    let unlisten: UnlistenFn | null = null

    try {
      // RAG 检索上下文
      let context = ''
      if (currentChapter) {
        const results = await aiApi.ragSearch(
          currentChapter.bookId,
          userInput,
          3
        ).catch(() => [])
        if (results.length > 0) {
          context = '\n\n相关背景：\n' + results.map((r) => r.snippet).join('\n---\n')
        }
      }

      // 注册流式事件监听（必须在 invoke 之前注册）
      unlisten = await listen<StreamEvent>('ai-stream-chunk', (event) => {
        const { content, done, error } = event.payload
        if (error) {
          updateAssistant(assistantId, `⚠️ AI 响应失败：${error}`)
          setStreaming(false)
          return
        }
        updateAssistant(assistantId, content)
        if (done) {
          setStreaming(false)
        }
      })

      // 构建消息
      const messages = buildMessages(context)
      const provider = isOllamaProvider ? 'ollama' : 'openai_compatible'

      // 调用 Rust 侧流式对话命令
      await aiApi.streamChat({
        provider,
        endpoint: aiConfig.endpoint,
        model: aiConfig.model,
        temperature: aiConfig.temperature,
        maxTokens: aiConfig.maxTokens,
        apiKey: aiConfig.apiKey,
        messages,
      })

      // 如果流正常结束但 done 事件未触发（兜底）
      setStreaming(false)
    } catch (err) {
      updateAssistant(assistantId, `⚠️ AI 响应失败：${String(err)}`)
    } finally {
      setStreaming(false)
      // 取消事件监听
      if (unlisten) {
        unlisten()
      }
    }
  }

  function handleClear() {
    if (messages.length > 0 && confirm('清空对话记录？')) {
      setMessages([])
    }
  }

  return (
    <div className="flex flex-col h-full">
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
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
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
        <p className="text-xs text-muted-foreground mt-1">
          模型：{aiConfig.model}
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
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
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
        {message.loading ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="w-3 h-3 animate-spin" />
            思考中…
          </span>
        ) : isUser ? (
          message.content
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  )
}
