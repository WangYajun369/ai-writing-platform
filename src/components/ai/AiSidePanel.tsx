/**
 * AiSidePanel — AI 助手侧面板
 *
 * 集成 Ollama 流式对话，自动 RAG 检索当前书籍上下文。
 * 支持流式 Markdown 渲染、快捷提示词、对话清空。
 */
import { useState, useRef, useEffect } from 'react'
import { SendIcon, BotIcon, XIcon, Loader2Icon } from 'lucide-react'
import { useAppStore, useCurrentChapter } from '@/stores/appStore.ts'
import { aiApi } from '@/lib/tauri-bridge.ts'
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
  const { aiConfig } = useAppStore()
  const currentChapter = useCurrentChapter()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    if (!input.trim() || streaming) return
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: input.trim() }
    const assistantId = (Date.now() + 1).toString()
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', loading: true }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
    setStreaming(true)

    try {
      // RAG 检索上下文
      let context = ''
      if (currentChapter) {
        const results = await aiApi.ragSearch(
          currentChapter.bookId,
          input.trim(),
          3
        ).catch(() => [])
        if (results.length > 0) {
          context = '\n\n相关背景：\n' + results.map((r) => r.snippet).join('\n---\n')
        }
      }

      // 调用 Ollama 流式接口
      const response = await fetch(`${aiConfig.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiConfig.model,
          messages: [
            {
              role: 'system',
              content: `你是一位专业的小说创作助手。请根据用户的需求提供创作建议、续写、润色等服务。${context}`,
            },
            ...messages
              .filter((m) => !m.loading)
              .map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: input.trim() },
          ],
          stream: true,
          options: { temperature: aiConfig.temperature },
        }),
      })

      if (!response.ok || !response.body) throw new Error('AI 服务不可用')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        // Ollama 返回的每行是 JSON
        const lines = chunk.split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const data = JSON.parse(line)
            if (data.message?.content) {
              accumulated += data.message.content
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated, loading: false } : m))
              )
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `⚠️ AI 响应失败：${String(err)}`, loading: false }
            : m
        )
      )
    } finally {
      setStreaming(false)
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
                handleSend()
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
 */
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  return (
    <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isUser
            ? 'bg-primary text-primary-foreground rounded-br-sm'
            : 'bg-muted text-foreground rounded-bl-sm'
        )}
      >
        {message.loading ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2Icon className="w-3 h-3 animate-spin" />
            思考中…
          </span>
        ) : (
          message.content
        )}
      </div>
    </div>
  )
}
