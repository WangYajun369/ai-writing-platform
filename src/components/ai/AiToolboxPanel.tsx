/**
 * AiToolboxPanel — AI 工具箱面板
 *
 * 三栏布局：左侧工具分类/列表，中间输入区域，右侧流式生成内容展示。
 * 流式调用通过 Rust 侧 SSE 处理，前端监听 ai-stream-chunk 事件。
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  WrenchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  CopyIcon,
  CheckIcon,
  Trash2Icon,
  SparklesIcon,
  InfoIcon,
  XIcon,
  PenLineIcon,
} from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { aiApi, type StreamEvent, type UsageInfo } from '@/lib/tauri-bridge'
import { getChatApiKey } from '@/types'
import type { AiToolCategory, AiToolPrompt } from '@/types'
import { cn } from '@/lib/utils'
import { getFriendlyAiError } from './useAiChat'

/** 生成状态 */
type GenerateStatus = 'idle' | 'generating' | 'done' | 'error'

/** 请求详情 */
interface RequestDetail {
  systemPrompt: string
  userInput: string
  model: string
  endpoint: string
  temperature: number
  maxTokens: number
  thinkingEnabled: boolean
}

export default function AiToolboxPanel({ initialToolId }: { initialToolId?: string }) {
  const { aiToolCategories, aiConfig } = useAppStore()
  const [selectedTool, setSelectedTool] = useState<AiToolPrompt | null>(null)
  const initialized = useRef(false)

  // 首次挂载时，若指定 initialToolId 且在分类中存在，则自动选中
  useEffect(() => {
    if (initialized.current || selectedTool || !initialToolId) return
    for (const cat of aiToolCategories) {
      const tool = cat.tools.find((t) => t.id === initialToolId)
      if (tool) {
        initialized.current = true
        setSelectedTool(tool)
        return
      }
    }
  }, [aiToolCategories, selectedTool, initialToolId])
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [userInput, setUserInput] = useState('')
  const [generatedContent, setGeneratedContent] = useState('')
  const [thinkingContent, setThinkingContent] = useState('')
  const [status, setStatus] = useState<GenerateStatus>('idle')
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [requestDetail, setRequestDetail] = useState<RequestDetail | null>(null)
  const [systemPromptDraft, setSystemPromptDraft] = useState<string | null>(null)

  const unlistenRef = useRef<UnlistenFn | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const thinkingRef = useRef<HTMLDivElement>(null)

  // 清理事件监听
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current()
        unlistenRef.current = null
      }
    }
  }, [])

  /** 切换分类折叠状态 */
  const toggleCategory = (catId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(catId)) {
        next.delete(catId)
      } else {
        next.add(catId)
      }
      return next
    })
  }

  /** 选择工具 */
  const selectTool = (tool: AiToolPrompt) => {
    if (status === 'generating') return
    setSelectedTool(tool)
    setSystemPromptDraft(null) // 切换工具时重置为默认 prompt
    // 不清空已有生成结果，让用户可以切换工具查看
  }

  /** 复制生成内容 */
  const handleCopy = async () => {
    if (!generatedContent) return
    try {
      await navigator.clipboard.writeText(generatedContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
      const ta = document.createElement('textarea')
      ta.value = generatedContent
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  /** 清空 */
  const handleClear = () => {
    setGeneratedContent('')
    setThinkingContent('')
    setUsage(null)
    setErrorMsg('')
    setStatus('idle')
  }

  /** 开始生成 */
  const handleGenerate = useCallback(async () => {
    if (!selectedTool || !userInput.trim() || status === 'generating') return

    const chatApiKey = getChatApiKey(aiConfig.chat)
    if (!chatApiKey) {
      setErrorMsg('请先在设置中配置 API Key')
      setStatus('error')
      return
    }

    setGeneratedContent('')
    setThinkingContent('')
    setUsage(null)
    setErrorMsg('')
    setStatus('generating')

    // 取消上一轮监听
    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }

    try {
      // 注册流式事件监听
      // 注意：后端发射的 content/thinking 已经是全量累积值，前端直接使用，无需再本地累加
      unlistenRef.current = await listen<StreamEvent>('ai-stream-chunk', (event) => {
        const { content, thinking, done, error, usage: evtUsage } = event.payload

        if (error) {
          const friendly = getFriendlyAiError(error)
          setGeneratedContent(`⚠️ ${friendly}\n\n> 错误详情：${error}`)
          setErrorMsg(friendly)
          setStatus('error')
          return
        }

        if (content) {
          setGeneratedContent(content)
        }
        if (thinking) {
          setThinkingContent(thinking)
        }
        if (evtUsage) {
          setUsage(evtUsage)
        }
        if (done) {
          setStatus('done')
        }
      })

      // 构建消息（优先使用草稿，否则使用工具默认 prompt）
      const defaultPrompt = `你是一位专业的小说创作助手。请根据用户需求，围绕「${selectedTool.name}」提供帮助。`
      const systemPrompt = systemPromptDraft || selectedTool.systemPrompt || defaultPrompt
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput.trim() },
      ]

      // 保存请求详情
      setRequestDetail({
        systemPrompt,
        userInput: userInput.trim(),
        model: aiConfig.chat.model,
        endpoint: aiConfig.chat.endpoint,
        temperature: aiConfig.chat.temperature,
        maxTokens: aiConfig.chat.maxTokens,
        thinkingEnabled: aiConfig.chat.thinkingEnabled,
      })

      await aiApi.streamChat({
        provider: 'sse',
        endpoint: aiConfig.chat.endpoint,
        model: aiConfig.chat.model,
        temperature: aiConfig.chat.temperature,
        maxTokens: aiConfig.chat.maxTokens,
        apiKey: chatApiKey,
        thinkingEnabled: aiConfig.chat.thinkingEnabled,
        messages,
      })
    } catch (err) {
      const rawErr = String(err)
      const friendly = getFriendlyAiError(rawErr)
      setGeneratedContent(`⚠️ ${friendly}\n\n> 错误详情：${rawErr}`)
      setErrorMsg(friendly)
      setStatus('error')
    } finally {
      if (status !== 'error') {
        setStatus('done')
      }
    }
  }, [selectedTool, userInput, status, aiConfig])

  // 从工具箱中排除章节总结（有独立窗口）
  const filteredCategories = useMemo(() => {
    return aiToolCategories
      .map((cat) => ({
        ...cat,
        tools: cat.tools.filter((t) => t.id !== 'chapter-summary'),
      }))
      .filter((cat) => cat.tools.length > 0)
  }, [aiToolCategories])

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden bg-card">
      {/* 左侧：工具列表 */}
      <ToolListSidebar
        categories={filteredCategories}
        selectedToolId={selectedTool?.id ?? null}
        collapsedCategories={collapsedCategories}
        onToggleCategory={toggleCategory}
        onSelectTool={selectTool}
        generating={status === 'generating'}
      />

      {/* 未选择工具时：合并展示占位提示 */}
      {!selectedTool ? (
        <div className="flex-1 flex items-center justify-center min-w-0 border-l border-border">
          <div className="text-center px-4">
            <SparklesIcon className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">请在左侧选择一个工具</p>
            <p className="text-xs text-muted-foreground/60 mt-1">选择工具后输入需求开始创作</p>
          </div>
        </div>
      ) : (
        <>
          {/* 中间：输入区域（固定宽度） */}
          <CenterInput
            selectedTool={selectedTool}
            userInput={userInput}
            onInputChange={setUserInput}
            onGenerate={handleGenerate}
            status={status}
            aiConfig={aiConfig}
            systemPromptDraft={systemPromptDraft}
            onSystemPromptChange={setSystemPromptDraft}
          />

          {/* 右侧：生成内容（弹性占满剩余空间） */}
          <OutputPanel
            content={generatedContent}
            thinking={thinkingContent}
            status={status}
            errorMsg={errorMsg}
            usage={usage}
            copied={copied}
            onCopy={handleCopy}
            onClear={handleClear}
            outputRef={outputRef}
            thinkingRef={thinkingRef}
            selectedToolName={selectedTool?.name}
            requestDetail={requestDetail}
          />
        </>
      )}
    </div>
  )
}

/** 左侧工具列表侧边栏 */
function ToolListSidebar({
  categories,
  selectedToolId,
  collapsedCategories,
  onToggleCategory,
  onSelectTool,
  generating,
}: {
  categories: AiToolCategory[]
  selectedToolId: string | null
  collapsedCategories: Set<string>
  onToggleCategory: (id: string) => void
  onSelectTool: (tool: AiToolPrompt) => void
  generating: boolean
}) {
  return (
    <div className="w-48 shrink-0 border-r border-border flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <WrenchIcon className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-semibold text-muted-foreground">AI 工具箱</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {categories.map((cat) => {
          const isCollapsed = collapsedCategories.has(cat.id)
          return (
            <div key={cat.id} className="mb-0.5">
              {/* 分类标题 */}
              <button
                onClick={() => onToggleCategory(cat.id)}
                className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                {isCollapsed ? (
                  <ChevronRightIcon className="w-3 h-3 shrink-0" />
                ) : (
                  <ChevronDownIcon className="w-3 h-3 shrink-0" />
                )}
                <span className="truncate">{cat.name}</span>
                <span className="text-[10px] opacity-50 ml-auto">{cat.tools.length}</span>
              </button>
              {/* 工具列表 */}
              {!isCollapsed && (
                <div className="space-y-0.5 px-1">
                  {cat.tools.map((tool) => (
                    <button
                      key={tool.id}
                      onClick={() => onSelectTool(tool)}
                      disabled={generating}
                      className={cn(
                        'w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors',
                        selectedToolId === tool.id
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-foreground/80 hover:bg-muted/60',
                        generating && 'opacity-50 cursor-not-allowed',
                      )}
                    >
                      <div className="truncate">{tool.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {categories.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground/50 text-center">
            暂无工具，请前往设置管理
          </p>
        )}
      </div>
    </div>
  )
}

/** 中间输入区域 — 固定宽度，工具信息头 + 输入框填充中部 + 底部生成按钮 */
function CenterInput({
  selectedTool,
  userInput,
  onInputChange,
  onGenerate,
  status,
  aiConfig,
  systemPromptDraft,
  onSystemPromptChange,
}: {
  selectedTool: AiToolPrompt
  userInput: string
  onInputChange: (v: string) => void
  onGenerate: () => void
  status: GenerateStatus
  aiConfig: { chat: { model: string } }
  systemPromptDraft: string | null
  onSystemPromptChange: (v: string | null) => void
}) {
  const isGenerating = status === 'generating'
  const [showPromptEditor, setShowPromptEditor] = useState(false)

  const defaultPrompt = `你是一位专业的小说创作助手。请根据用户需求，围绕「${selectedTool.name}」提供帮助。`
  const currentPrompt = systemPromptDraft ?? selectedTool.systemPrompt ?? defaultPrompt
  const isCustomized = systemPromptDraft !== null

  const handleSavePrompt = (newPrompt: string) => {
    const trimmed = newPrompt.trim()
    if (trimmed && trimmed !== (selectedTool.systemPrompt || defaultPrompt)) {
      onSystemPromptChange(trimmed)
    } else {
      onSystemPromptChange(null) // 恢复默认
    }
    setShowPromptEditor(false)
  }

  return (
    <div className="w-72 shrink-0 flex flex-col border-r border-border overflow-hidden">
      {/* 工具信息头 */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <h3 className="text-sm font-semibold text-foreground">{selectedTool.name}</h3>
        {selectedTool.description && (
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{selectedTool.description}</p>
        )}
      </div>

      {/* 输入框 — 填充整个中部 */}
      <textarea
        value={userInput}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onGenerate()
          }
        }}
        placeholder="输入你的创作需求…（Shift+Enter 换行）"
        className={cn(
          'flex-1 min-h-0 bg-transparent px-4 py-3 text-sm outline-none resize-none placeholder:text-muted-foreground/50',
          isGenerating && 'opacity-60',
        )}
        disabled={isGenerating}
      />

      {/* 底部：生成按钮 */}
      <div className="px-3 py-3 border-t border-border shrink-0 space-y-2">
        <button
          onClick={onGenerate}
          disabled={!userInput.trim() || isGenerating}
          className={cn(
            'w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all',
            isGenerating
              ? 'bg-primary/80 text-primary-foreground cursor-not-allowed'
              : 'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50',
          )}
        >
          {isGenerating ? (
            <>
              <Loader2Icon className="w-4 h-4 animate-spin" />
              生成中…
            </>
          ) : (
            <>
              <SparklesIcon className="w-4 h-4" />
              开始生成
            </>
          )}
        </button>
        <p className="text-[10px] text-muted-foreground/50 text-center flex items-center justify-center gap-1">
          {/* 编辑 System Prompt 图标 */}
          <button
            onClick={() => setShowPromptEditor(true)}
            disabled={isGenerating}
            className={cn(
              'p-0.5 rounded hover:bg-muted transition-colors',
              isCustomized && 'text-primary',
            )}
            title={isCustomized ? 'System Prompt 已自定义' : '编辑 System Prompt'}
          >
            <PenLineIcon className="w-3 h-3" />
          </button>
          模型：{aiConfig.chat.model}
        </p>
      </div>

      {/* System Prompt 编辑弹窗 */}
      {showPromptEditor && (
        <SystemPromptModal
          initialPrompt={currentPrompt}
          onSave={handleSavePrompt}
          onClose={() => setShowPromptEditor(false)}
        />
      )}
    </div>
  )
}

/** System Prompt 编辑弹窗 */
function SystemPromptModal({
  initialPrompt,
  onSave,
  onClose,
}: {
  initialPrompt: string
  onSave: (prompt: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initialPrompt)

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[420px] max-h-[70%] bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden m-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">
            <PenLineIcon className="w-3.5 h-3.5 inline mr-1.5 text-primary" />
            编辑 System Prompt
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* 编辑区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-48 bg-muted rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-ring resize-none leading-relaxed"
            placeholder="输入 System Prompt…"
          />
          <p className="text-[10px] text-muted-foreground/50 mt-2">
            System Prompt 用于设定 AI 的角色、风格和回答规则，清空后保存可恢复默认。
          </p>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onSave(draft)}
            className="px-3 py-1.5 rounded-lg text-xs bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** 右侧输出面板 — 参考 MessageBubble 样式 */
function OutputPanel({
  content,
  thinking,
  status,
  errorMsg,
  usage,
  copied,
  onCopy,
  onClear,
  outputRef,
  thinkingRef,
  selectedToolName,
  requestDetail,
}: {
  content: string
  thinking: string
  status: GenerateStatus
  errorMsg: string
  usage: UsageInfo | null
  copied: boolean
  onCopy: () => void
  onClear: () => void
  outputRef: React.RefObject<HTMLDivElement | null>
  thinkingRef: React.RefObject<HTMLDivElement | null>
  selectedToolName?: string
  requestDetail: RequestDetail | null
}) {
  const isGenerating = status === 'generating'
  const hasContent = content.length > 0
  const hasThinking = thinking.length > 0
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)

  // 参考 AI 助手：RAF 限流滚动到底部
  useEffect(() => {
    if (scrollRafRef.current) return
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
  }, [content, thinking])

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* 头部 */}
      <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SparklesIcon className={cn('w-3.5 h-3.5', isGenerating ? 'text-primary animate-pulse' : 'text-muted-foreground')} />
          <span className="text-xs font-medium text-muted-foreground">
            {selectedToolName ? `${selectedToolName} · 结果` : '输出区域'}
          </span>
          {status === 'done' && (
            <span className="text-[10px] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 px-1.5 py-0.5 rounded">
              已完成
            </span>
          )}
          {isGenerating && (
            <span className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 px-1.5 py-0.5 rounded animate-pulse">
              生成中
            </span>
          )}
          {status === 'error' && (
            <span className="text-[10px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded">
              失败
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {requestDetail && (
            <button
              onClick={() => setShowDetail(true)}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="查看请求详情"
            >
              <InfoIcon className="w-3.5 h-3.5" />
            </button>
          )}
          {hasContent && !isGenerating && (
            <button
              onClick={onCopy}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={copied ? '已复制' : '复制内容'}
            >
              {copied ? <CheckIcon className="w-3.5 h-3.5 text-green-500" /> : <CopyIcon className="w-3.5 h-3.5" />}
            </button>
          )}
          {(hasContent || hasThinking || status === 'error') && (
            <button
              onClick={onClear}
              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="清空输出"
            >
              <Trash2Icon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 内容区域 — 参考 MessageBubble 结构 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-3 min-h-0 min-w-0">
        {/* 思考过程 — 对齐 MessageBubble ThinkingSection */}
        {hasThinking && (
          <div className="border border-amber-200 dark:border-amber-800/40 rounded-lg overflow-hidden">
            <button
              onClick={() => setThinkingExpanded((v) => !v)}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] hover:bg-amber-50/50 dark:hover:bg-amber-950/20 transition-colors"
            >
              {thinkingExpanded ? (
                <ChevronDownIcon className="w-3 h-3 shrink-0" />
              ) : (
                <ChevronRightIcon className="w-3 h-3 shrink-0" />
              )}
              {isGenerating ? (
                <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <Loader2Icon className="w-2.5 h-2.5 animate-spin" />
                  深度思考中…
                </span>
              ) : (
                <span className="text-muted-foreground/70">思考过程</span>
              )}
            </button>
            {thinkingExpanded && (
              <div
                ref={thinkingRef}
                className="px-3 pb-3 text-[11px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap border-t border-amber-200/50 dark:border-amber-800/30 italic max-h-48 overflow-y-auto overflow-x-hidden min-w-0 break-all bg-amber-50/30 dark:bg-amber-950/10"
              >
                {thinking}
              </div>
            )}
          </div>
        )}

        {/* 正式输出标签 — 对齐 MessageBubble */}
        {hasThinking && hasContent && (
          <div className="text-[10px] text-muted-foreground/60 font-medium">
            📝 {isGenerating ? '正式输出中…' : '正式输出'}
          </div>
        )}

        {/* 生成内容 — Markdown 渲染 + 气泡容器 */}
        {hasContent ? (
          <div
            ref={outputRef}
            className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3 min-w-0 overflow-hidden"
          >
            <div className="markdown-body text-sm min-w-0 [overflow-wrap:anywhere] [&_pre]:!whitespace-pre-wrap [&_pre]:!break-all [&_pre]:!overflow-x-hidden [&_code]:!break-all [&_table]:!block [&_table]:!max-w-full">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              {isGenerating && (
                <span className="inline-block w-2 h-4 bg-primary/60 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
              )}
            </div>
            {/* 用量统计 — 参考 MessageBubble */}
            {usage && status === 'done' && (
              <div className="mt-3 pt-2 border-t border-border/50 flex items-center gap-3 text-[10px] text-muted-foreground/50">
                <span title="输入 Token">↗ {usage.inputTokens} token</span>
                <span title="输出 Token">↘ {usage.outputTokens} token</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-40">
            <div className="text-center px-4">
              <SparklesIcon className="w-8 h-8 mx-auto mb-2 text-muted-foreground/20" />
              <p className="text-xs text-muted-foreground/50">
                {isGenerating ? '正在生成内容…' : '选择工具并输入需求，点击发送'}
              </p>
            </div>
          </div>
        )}

        {/* 错误信息 */}
        {status === 'error' && errorMsg && (
          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2">
            {errorMsg}
          </div>
        )}

        {/* 滚动哨兵 — 参考 AI 助手 */}
        <div ref={bottomRef} />
      </div>

      {/* 请求详情弹窗 */}
      {showDetail && requestDetail && (
        <DetailModal detail={requestDetail} onClose={() => setShowDetail(false)} />
      )}
    </div>
  )
}

/** 请求详情弹窗 */
function DetailModal({
  detail,
  onClose,
}: {
  detail: RequestDetail
  onClose: () => void
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[440px] max-h-[80%] bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden m-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">请求详情</h3>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* 弹窗内容 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">
          {/* 模型参数 */}
          <DetailSection title="模型参数">
            <DetailRow label="接口地址" value={detail.endpoint} />
            <DetailRow label="模型" value={detail.model} />
            <DetailRow label="Temperature" value={String(detail.temperature)} />
            <DetailRow label="Max Tokens" value={String(detail.maxTokens)} />
            <DetailRow label="深度思考" value={detail.thinkingEnabled ? '已开启' : '未开启'} />
          </DetailSection>

          {/* System Prompt */}
          <DetailSection title="System Prompt">
            <pre className="whitespace-pre-wrap break-all text-muted-foreground/80 leading-relaxed bg-muted/50 rounded-lg p-3 max-h-32 overflow-y-auto">
              {detail.systemPrompt}
            </pre>
          </DetailSection>

          {/* 用户输入 */}
          <DetailSection title="用户输入">
            <pre className="whitespace-pre-wrap break-all text-muted-foreground/80 leading-relaxed bg-muted/50 rounded-lg p-3 max-h-32 overflow-y-auto">
              {detail.userInput}
            </pre>
          </DetailSection>
        </div>
      </div>
    </div>
  )
}

/** 详情区块 */
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold text-foreground/70 mb-2">{title}</h4>
      {children}
    </div>
  )
}

/** 键值行 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-muted-foreground/60 shrink-0 min-w-[90px]">{label}</span>
      <span className="text-muted-foreground truncate">{value}</span>
    </div>
  )
}
