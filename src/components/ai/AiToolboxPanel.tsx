/**
 * AiToolboxPanel — AI 工具箱面板
 *
 * 三栏布局：左侧工具分类/列表，中间输入区域，右侧流式生成内容展示。
 * 流式调用通过 Rust 侧 SSE 处理，前端监听 ai-stream-chunk 事件。
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { SparklesIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { aiApi, type StreamEvent, type UsageInfo } from '@/lib/tauri-bridge'
import { getChatApiKey } from '@/types'
import type { AiToolPrompt } from '@/types'
import { getFriendlyAiError } from './useAiChat'
import { ToolboxSidebar } from './panel/ToolboxSidebar'
import { ToolboxCenterInput } from './panel/ToolboxCenterInput'
import type { GenerateStatus } from './panel/ToolboxCenterInput'
import { ToolboxOutputPanel } from './panel/ToolboxOutputPanel'
import type { RequestDetail } from './panel/ToolboxOutputPanel'

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
    setSystemPromptDraft(null)
  }

  /** 复制生成内容 */
  const handleCopy = async () => {
    if (!generatedContent) return
    try {
      await navigator.clipboard.writeText(generatedContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
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

    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }

    try {
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

      const defaultPrompt = `你是一位专业的小说创作助手。请根据用户需求，围绕「${selectedTool.name}」提供帮助。`
      const systemPrompt = systemPromptDraft || selectedTool.systemPrompt || defaultPrompt
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput.trim() },
      ]

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
  }, [selectedTool, userInput, status, aiConfig, systemPromptDraft])

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
      <ToolboxSidebar
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
          {/* 中间：输入区域 */}
          <ToolboxCenterInput
            selectedTool={selectedTool}
            userInput={userInput}
            onInputChange={setUserInput}
            onGenerate={handleGenerate}
            status={status}
            modelName={aiConfig.chat.model}
            systemPromptDraft={systemPromptDraft}
            onSystemPromptChange={setSystemPromptDraft}
          />

          {/* 右侧：生成内容 */}
          <ToolboxOutputPanel
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
