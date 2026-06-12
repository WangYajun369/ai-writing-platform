/**
 * ToolboxCenterInput — 工具箱中间输入区域
 * 包含工具信息头、输入框、生成按钮、System Prompt 编辑器
 */
import { useState } from 'react'
import {
  SparklesIcon,
  Loader2Icon,
  PenLineIcon,
  XIcon,
} from 'lucide-react'
import type { AiToolPrompt } from '@/types'
import { cn } from '@/lib/utils'

/** 生成状态 */
export type GenerateStatus = 'idle' | 'generating' | 'done' | 'error'

interface ToolboxCenterInputProps {
  selectedTool: AiToolPrompt
  userInput: string
  onInputChange: (v: string) => void
  onGenerate: () => void
  status: GenerateStatus
  modelName: string
  systemPromptDraft: string | null
  onSystemPromptChange: (v: string | null) => void
}

export function ToolboxCenterInput({
  selectedTool,
  userInput,
  onInputChange,
  onGenerate,
  status,
  modelName,
  systemPromptDraft,
  onSystemPromptChange,
}: ToolboxCenterInputProps) {
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
      onSystemPromptChange(null)
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

      {/* 输入框 */}
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
          模型：{modelName}
        </p>
      </div>

      {/* System Prompt 编辑弹窗 */}
      {showPromptEditor && (
        <SystemPromptEditor
          initialPrompt={currentPrompt}
          onSave={handleSavePrompt}
          onClose={() => setShowPromptEditor(false)}
        />
      )}
    </div>
  )
}

/** System Prompt 编辑弹窗 */
function SystemPromptEditor({
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
