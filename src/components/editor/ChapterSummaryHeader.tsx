/**
 * ChapterSummaryToolbar — 章节 AI 总结工具栏按钮 + ChapterSummaryPanel — 独立窗口面板
 *
 * 工具栏中「章节总结」按钮，点击打开独立窗口展示 Markdown 格式总结内容，
 * 窗口内可执行更新总结、自定义要求、查看请求详情等操作。
 */
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RefreshCwIcon, Loader2Icon, CheckCircleIcon, AlertCircleIcon, InfoIcon, XIcon, BookOpenIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { useAppStore, useCurrentChapter } from '@/stores/appStore'
import { chapterApi, aiApi } from '@/lib/tauri-bridge'
import { getChatApiKey } from '@/types'
import type { SummarizeArgs } from '@/lib/tauri-bridge'

interface ChapterSummaryData {
  summary: string | null
  summaryAt: string | null
}

function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return '—'
  try {
    const date = new Date(isoString)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

/** 独立窗口 Props */
interface ChapterSummaryPanelProps {
  chapterId?: string
  bookId?: string
  chapterTitle?: string
}

/** 独立窗口模式：章节 AI 总结面板 */
export function ChapterSummaryPanel({ chapterId, chapterTitle }: ChapterSummaryPanelProps) {
  const { aiConfig, aiToolCategories } = useAppStore()
  const [summaryData, setSummaryData] = useState<ChapterSummaryData>({ summary: null, summaryAt: null })
  const [isGenerating, setIsGenerating] = useState(false)
  const [lastRequest, setLastRequest] = useState<SummarizeArgs | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  // 从 AI 工具箱分类中按名称查找章节总结 System Prompt
  const allTools = aiToolCategories.flatMap((c) => c.tools)
  const systemPrompt = allTools.find((p) => p.name === '章节总结')?.systemPrompt ?? ''

  useEffect(() => {
    if (!chapterId) return
    chapterApi.getSummary(chapterId).then(setSummaryData).catch(console.error)
  }, [chapterId])

  // 在独立窗口模式中，always allow update（无法获取章节 updatedAt）
  const allowUpdate = true

  const handleUpdateSummary = useCallback(async () => {
    if (!chapterId || isGenerating) return
    setIsGenerating(true)
    try {
      const contentHtml = await chapterApi.getContent(chapterId)
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = contentHtml
      const plainText = tempDiv.textContent || tempDiv.innerText || ''

      if (plainText.trim().length < 300) {
        console.warn('章节内容太少，无需总结')
        setIsGenerating(false)
        return
      }

      const apiKey = getChatApiKey(aiConfig.chat)
      const summarizeArgs: SummarizeArgs = {
        endpoint: aiConfig.chat.endpoint,
        model: aiConfig.chat.model,
        apiKey,
        temperature: aiConfig.chat.temperature,
        maxTokens: aiConfig.chat.maxTokens,
        chapterTitle: chapterTitle ?? '',
        chapterContent: plainText.slice(0, 8000),
        thinkingEnabled: aiConfig.chat.thinkingEnabled,
        systemPrompt: systemPrompt.trim() || undefined,
      }
      setLastRequest(summarizeArgs)
      const result = await aiApi.summarizeChapter(summarizeArgs)

      await chapterApi.saveSummary(chapterId, result.summary)
      const updated = await chapterApi.getSummary(chapterId)
      setSummaryData(updated)
    } catch (err) {
      console.error('生成总结失败', err)
    } finally {
      setIsGenerating(false)
    }
  }, [chapterId, chapterTitle, aiConfig, isGenerating])

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <BookOpenIcon className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">章节总结</span>
          {chapterTitle && (
            <span className="text-xs text-muted-foreground">{chapterTitle}</span>
          )}
          {summaryData.summaryAt && (
            <span className="text-xs text-muted-foreground">
              {formatDateTime(summaryData.summaryAt)}
            </span>
          )}
          {allowUpdate && !isGenerating && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5">
              <AlertCircleIcon className="w-3 h-3" />
              内容已更新
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* 更新总结 */}
          <button
            onClick={handleUpdateSummary}
            disabled={!allowUpdate || isGenerating}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all',
              isGenerating
                ? 'bg-blue-500/10 text-blue-500 cursor-wait'
                : allowUpdate
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 cursor-pointer'
                  : 'text-muted-foreground/50 cursor-not-allowed',
            )}
            title={
              !allowUpdate
                ? '内容暂无更新，无需重新总结'
                : isGenerating
                  ? '正在生成总结…'
                  : '更新总结'
            }
          >
            {isGenerating ? (
              <>
                <Loader2Icon className="w-3 h-3 animate-spin" />
                生成中
              </>
            ) : allowUpdate ? (
              <>
                <RefreshCwIcon className="w-3 h-3" />
                更新
              </>
            ) : (
              <>
                <CheckCircleIcon className="w-3 h-3" />
                最新
              </>
            )}
          </button>
          {/* 详情 */}
          {lastRequest && (
            <button
              onClick={() => setShowDetail(true)}
              className="p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="查看请求详情"
            >
              <InfoIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {/* 总结内容（Markdown） */}
        {summaryData.summary ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summaryData.summary}</ReactMarkdown>
          </div>
        ) : isGenerating ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <Loader2Icon className="w-5 h-5 animate-spin" />
            <span className="text-sm">正在生成总结…</span>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground text-center py-12">
            暂无总结，点击「更新」生成 AI 章节摘要
          </div>
        )}
      </div>

      {/* 请求详情弹窗 */}
      {showDetail && lastRequest && (
        <SummarizeRequestDetailModal request={lastRequest} onClose={() => setShowDetail(false)} />
      )}
    </div>
  )
}

/** 工具栏按钮：打开章节总结独立窗口 */
export default function ChapterSummaryToolbar() {
  const currentChapter = useCurrentChapter()

  const handleOpen = useCallback(async () => {
    if (!currentChapter) return
    try {
      await invoke('open_summary_window', {
        chapterId: currentChapter.id,
        bookId: currentChapter.bookId,
        chapterTitle: currentChapter.title,
      })
    } catch (e) {
      console.error('打开章节总结窗口失败', e)
    }
  }, [currentChapter])

  return (
    <button
      onClick={handleOpen}
      title="章节总结"
      className="p-1.5 rounded transition-colors text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <BookOpenIcon className="w-4 h-4" />
    </button>
  )
}

/** 章节 AI 总结请求详情弹窗 */
function SummarizeRequestDetailModal({ request, onClose }: { request: SummarizeArgs; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 bg-background border rounded-xl shadow-2xl w-[90vw] max-w-2xl max-h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <InfoIcon className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">章节总结请求详情</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* 弹窗内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* 请求参数 */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">请求参数</h3>
            <div className="bg-muted/50 rounded-lg p-3 text-xs space-y-1.5 font-mono">
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">Endpoint：</span>
                <span className="break-all">{request.endpoint}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">模型：</span>
                <span>{request.model}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">Temperature：</span>
                <span>{request.temperature}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">MaxTokens：</span>
                <span>{request.maxTokens ?? '-'}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">思考模式：</span>
                <span>{request.thinkingEnabled ? '已启用' : '已关闭'}</span>
              </div>
            </div>
          </div>

          {/* System Prompt */}
          {request.systemPrompt && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">System Prompt（自定义）</h3>
              <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
                <div className="px-3 py-1.5 bg-amber-100/50 dark:bg-amber-900/20 text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                  自定义总结要求
                </div>
                <div className="px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word bg-amber-50/30 dark:bg-amber-950/20 text-foreground leading-relaxed">
                  {request.systemPrompt}
                </div>
              </div>
            </div>
          )}

          {/* 章节标题 */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">章节标题</h3>
            <div className="bg-muted/50 rounded-lg p-3 text-xs">
              {request.chapterTitle || <span className="text-muted-foreground/40 italic">（空）</span>}
            </div>
          </div>

          {/* 提交内容 */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              提交内容（{request.chapterContent.length} 字）
            </h3>
            <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-amber-100/50 dark:bg-amber-900/20 text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                章节正文内容（截取前 8000 字）
              </div>
              <div className="px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word bg-amber-50/30 dark:bg-amber-950/20 text-foreground leading-relaxed max-h-[40vh] overflow-y-auto">
                {request.chapterContent}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
