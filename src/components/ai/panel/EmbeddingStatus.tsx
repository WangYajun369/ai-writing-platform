/**
 * Embedding 索引状态指示器
 */
import { memo } from 'react'
import {
  Loader2Icon, CircleCheckIcon, CircleAlertIcon, RefreshCwIcon, DatabaseZapIcon,
} from 'lucide-react'
import { useAiChat } from '../useAiChat'

interface EmbeddingStatusProps {
  generating: boolean
  loading: boolean
  status: ReturnType<typeof useAiChat>['embeddingStatus']
  onRegenerate: () => void
}

export const EmbeddingStatus = memo(function EmbeddingStatus({
  generating, loading, status, onRegenerate,
}: EmbeddingStatusProps) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-border/30">|</span>
      {generating ? (
        <span className="text-blue-500 flex items-center gap-0.5">
          <Loader2Icon className="w-3 h-3 animate-spin" />
          生成中…
        </span>
      ) : loading ? (
        <span className="text-muted-foreground/50">
          <Loader2Icon className="w-3 h-3 animate-spin" />
        </span>
      ) : status?.stale ? (
        <button
          onClick={onRegenerate}
          className="text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 flex items-center gap-0.5 transition-colors"
          title={`索引已过期：${status.totalChapters} 章节/${status.totalWorldCards} 卡片，仅索引了 ${status.indexedChapters} 章节/${status.indexedWorldCards} 卡片`}
        >
          <CircleAlertIcon className="w-3 h-3" />
          <RefreshCwIcon className="w-3 h-3" />
          索引已过期
        </button>
      ) : status && (status.indexedChapters > 0 || status.indexedWorldCards > 0) ? (
        <span
          className="text-green-600 dark:text-green-400 flex items-center gap-0.5 cursor-help"
          title={`${status.indexedChapters} 章节 + ${status.indexedWorldCards} 卡片已索引 / 共 ${status.totalChapters} 章节 + ${status.totalWorldCards} 卡片`}
        >
          <CircleCheckIcon className="w-3 h-3" />
          {status.indexedChapters + status.indexedWorldCards} 项已索引
          <button onClick={onRegenerate} className="text-primary/60 hover:text-primary ml-0.5" title="重新生成索引">
            <RefreshCwIcon className="w-3 h-3" />
          </button>
        </span>
      ) : (
        <button
          onClick={onRegenerate}
          className="text-primary/80 hover:text-primary flex items-center gap-0.5 transition-colors"
          title="为当前书籍生成语义索引，提升 RAG 检索精度"
        >
          <DatabaseZapIcon className="w-3 h-3" />
          生成索引
        </button>
      )}
    </span>
  )
})
