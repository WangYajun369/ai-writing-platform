/**
 * OutlineDialogs — 目录面板的输入对话框 + 确认对话框
 */
import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import type { InputDialogState, ConfirmDialogState } from './types'

interface InputDialogViewProps {
  state: InputDialogState
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function InputDialog({ state, onConfirm, onCancel }: InputDialogViewProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (state.open) {
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [state.open])

  if (!state.open) return null

  const handleConfirm = () => {
    const value = inputRef.current?.value?.trim()
    if (value) onConfirm(value)
    onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
      />
      <div className="relative bg-card border border-border rounded-lg shadow-lg p-4 w-72">
        <label className="block text-sm font-medium text-foreground mb-2">
          {state.label}
        </label>
        <input
          ref={inputRef}
          autoFocus
          defaultValue={state.defaultValue}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm()
            if (e.key === 'Escape') onCancel()
          }}
          className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-md outline-none focus:border-primary"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-sm rounded-md hover:bg-muted text-muted-foreground"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

interface ConfirmDialogViewProps {
  state: ConfirmDialogState
  onClose: () => void
}

export function ConfirmDialog({ state, onClose }: ConfirmDialogViewProps) {
  if (!state.open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="relative bg-card border border-border rounded-lg shadow-lg p-5 w-80">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          {state.title}
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          {state.message}
        </p>
        <div className="flex justify-end gap-2">
          {state.danger !== false && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-md hover:bg-muted text-muted-foreground"
            >
              取消
            </button>
          )}
          <button
            onClick={state.onConfirm}
            className={cn(
              'px-3 py-1.5 text-sm rounded-md',
              state.danger !== false
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {state.confirmLabel ?? '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
