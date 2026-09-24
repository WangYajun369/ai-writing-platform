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

  /** 打开输入对话框：label 为输入框提示文案，defaultValue 为初始值，onSubmit 回车时回调 */
  const openInputDialog = useCallback(
    (label: string, defaultValue: string, onSubmit: (value: string) => void) => {
      setInputDialog({ open: true, label, defaultValue, onSubmit })
    },
    [],
  )

  /** 打开二次确认框：统一把 open 置 true，其余字段（danger/onConfirm 等）由调用方透传 */
  const openConfirmDialog = useCallback((state: ConfirmDialogPayload) => {
    setConfirmDialog({ open: true, ...state })
  }, [])

  /** 关闭输入对话框（保留 label/defaultValue，避免下次打开前的闪现） */
  const closeInputDialog = useCallback(() => {
    setInputDialog((prev) => ({ ...prev, open: false }))
  }, [])

  /** 关闭二次确认框（保留标题与回调配置） */
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
