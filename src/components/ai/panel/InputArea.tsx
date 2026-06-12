/**
 * AI 聊天模式输入区域
 */
import { memo } from 'react'
import { SendIcon, Loader2Icon } from 'lucide-react'
import { useAiChat } from '../useAiChat'
import { EmbeddingStatus } from './EmbeddingStatus'

interface InputAreaProps {
  input: string
  onChange: (v: string) => void
  onSend: () => void
  streaming: boolean
  modelName: string
  embeddingGenerating: boolean
  embeddingStatusLoading: boolean
  embeddingStatus: ReturnType<typeof useAiChat>['embeddingStatus']
  currentBookId: string | null
  ragEnabled: boolean
  onGenerateEmbeddings: () => void
}

export const InputArea = memo(function InputArea({
  input, onChange, onSend, streaming, modelName,
  embeddingGenerating, embeddingStatusLoading, embeddingStatus,
  currentBookId, ragEnabled, onGenerateEmbeddings,
}: InputAreaProps) {
  return (
    <div className="px-3 py-3 border-t shrink-0">
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void onSend()
            }
          }}
          placeholder="向 AI 提问…（Shift+Enter 换行）"
          rows={3}
          className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
          disabled={streaming}
        />
        <button
          onClick={onSend}
          disabled={!input.trim() || streaming}
          className="self-end p-2.5 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 hover:opacity-90 transition-opacity"
        >
          {streaming ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <SendIcon className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
        模型：{modelName}
        {currentBookId && ragEnabled && (
          <EmbeddingStatus
            generating={embeddingGenerating}
            loading={embeddingStatusLoading}
            status={embeddingStatus}
            onRegenerate={onGenerateEmbeddings}
          />
        )}
      </p>
    </div>
  )
})
