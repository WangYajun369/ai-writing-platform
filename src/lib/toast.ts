/**
 * Toast 通知系统
 *
 * 基于 Jotai atom 的轻量级全局通知组件。
 * 支持 success / error / warning / info 四种类型，自动消失。
 */
import { atom, useSetAtom, getDefaultStore } from 'jotai'
import { useCallback } from 'react'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

/** Toast 动作按钮（如「前往更新」），点击后关闭该通知并执行回调 */
export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: string
  type: ToastType
  message: string
  duration?: number
  action?: ToastAction
}

export const toastsAtom = atom<ToastItem[]>([])

const removeToastAtom = atom(null, (get, set, id: string) => {
  set(toastsAtom, get(toastsAtom).filter((t) => t.id !== id))
})

function pushToast(type: ToastType, message: string, duration = 3000, action?: ToastAction) {
  const store = getDefaultStore()
  const id = crypto.randomUUID()
  store.set(toastsAtom, (prev) => [...prev, { id, type, message, duration, action }])
  if (duration > 0) {
    setTimeout(() => store.set(removeToastAtom, id), duration)
  }
}

/** 独立 toast API（可在非 React 上下文中调用） */
export const toast = {
  success: (msg: string) => pushToast('success', msg),
  error: (msg: string) => pushToast('error', msg, 5000),
  warning: (msg: string) => pushToast('warning', msg, 4000),
  info: (msg: string) => pushToast('info', msg),
  /** 带动作按钮的通知（错误类建议动作使用），点击执行后自动关闭 */
  action: (type: ToastType, msg: string, action: ToastAction) =>
    pushToast(type, msg, 8000, action),
}

/**
 * Toast hook — 返回操作函数（与独立 API 功能相同，但通过 Jotai hook 获取 store）
 *
 * @example
 * const t = useToast()
 * t.success('操作成功')
 */
export function useToast() {
  const setToasts = useSetAtom(toastsAtom)
  const removeToast = useSetAtom(removeToastAtom)

  const push = useCallback(
    (type: ToastType, message: string, duration = 3000) => {
      const id = crypto.randomUUID()
      setToasts((prev) => [...prev, { id, type, message, duration }])
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration)
      }
    },
    [setToasts, removeToast],
  )

  return {
    success: useCallback((msg: string) => push('success', msg), [push]),
    error: useCallback((msg: string) => push('error', msg, 5000), [push]),
    warning: useCallback((msg: string) => push('warning', msg, 4000), [push]),
    info: useCallback((msg: string) => push('info', msg), [push]),
    push,
  }
}
