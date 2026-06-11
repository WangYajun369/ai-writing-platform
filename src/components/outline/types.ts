import type { Chapter, Volume } from '@/types'

export interface OutlinePanelProps {
  bookId: string
}

export interface InputDialogState {
  open: boolean
  label: string
  defaultValue: string
  onSubmit: (value: string) => void
}

export interface ConfirmDialogState {
  open: boolean
  title: string
  message: string
  onConfirm: () => void
  confirmLabel?: string
  danger?: boolean
}

/** 拍平后的列表项 */
export type FlatItem =
  | { type: 'chapter'; id: string; chapter: Chapter; indent: boolean }
  | { type: 'volume'; id: string; volume: Volume; collapsed: boolean }
