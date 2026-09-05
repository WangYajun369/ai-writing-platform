/**
 * useOutlineDialogs — 目录面板对话框状态 hook（Phase 4 问题 5：OutlinePanel 拆分）
 *
 * 集中管理：新建/重命名输入框、二次确认框、回收站抽屉的开关状态与
 * open/close 方法，使主组件聚焦于数据编排与渲染。
 */
import { useCallback, useState } from 'react'
import type { InputDialogState, ConfirmDialogState } from '../types'

/** 二次确认框的“打开配置”（open 可选，hook 内部统一置位为 true） */
export type ConfirmDialogPayload = Omit<ConfirmDialogState, 'open'> & { open?: boolean }

export function useOutlineDialogs() {
  const [inputDialog, setInputDialog] = useState<InputDialogState>({
    open: false,
    label: '',
    defaultValue: '',
    onSubmit: () => {},
  })
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    onConfirm: () => {},
  })
  const [recycleBinOpen, setRecycleBinOpen] = useState(false)

  const openInputDialog = useCallback(
    (label: string, defaultValue: string, onSubmit: (value: string) => void) => {
      setInputDialog({ open: true, label, defaultValue, onSubmit })
    },
    [],
  )

  const openConfirmDialog = useCallback((state: ConfirmDialogPayload) => {
    setConfirmDialog({ open: true, ...state })
  }, [])

  const closeInputDialog = useCallback(() => {
    setInputDialog((prev) => ({ ...prev, open: false }))
  }, [])

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, open: false }))
  }, [])

  return {
    inputDialog,
    confirmDialog,
    recycleBinOpen,
    setRecycleBinOpen,
    openInputDialog,
    openConfirmDialog,
    closeInputDialog,
    closeConfirmDialog,
  }
}
