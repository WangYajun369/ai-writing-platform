/**
 * Toast 通知系统
 *
 * 基于 Jotai atom 的轻量级全局通知组件。
 * 支持 success / error / warning / info 四种类型，自动消失。
 *
 * ## Atom 设计（v1.9 收敛后）
 *
 * - `toastsAtom`：通知队列单一真源；
 * - `removeToastAtom`：派生 writable atom（按 id 移除单条），委托到 toastsAtom。
 *
 * 两者都已收敛为「1 真源 + 1 派生」模式，无散乱 atom。
 *
 * ## API 统一（v1.9 重构）
 *
 * 独立 `toast` API 与 `useToast` hook 共享 `createToastItem` 工厂，
 * 接口完全一致：都支持 `success` / `error` / `warning` / `info` / `action`。
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

/** 当前通知队列 atom（独立 toast API 与 useToast hook 共用同一列表）。
 *  单一真源：所有推送 / 移除操作最终都汇聚到此 atom。 */
export const toastsAtom = atom<ToastItem[]>([])

/** 按 id 移除单条通知（供定时器/动作按钮关闭时调用）。
 *
 * v1.9 改为 export：便于测试与外部组件（如自定义关闭按钮）直接使用。
 * 内部委托到 toastsAtom，仍是「1 真源 + 1 派生」模式。 */
export const removeToastAtom = atom<null, [string], void>(
  null,
  (get, set, id: string) => {
    set(toastsAtom, get(toastsAtom).filter((t) => t.id !== id))
  },
)

/** 清空全部通知的派生 atom（v1.9 新增）。
 *  用于「错误恢复后清屏」「页面切换时清理」等场景。 */
export const clearAllToastsAtom = atom<null, [], void>(null, (_, set) => {
  set(toastsAtom, [])
})

/** 创建 toast 项的纯工厂函数（独立 API 与 useToast 共用，避免逻辑重复）。
 *
 * 抽出为独立函数便于单测，且保证两条推送路径（getDefaultStore 与 useSetAtom）
 * 生成结构完全一致的 ToastItem。 */
export function createToastItem(
  type: ToastType,
  message: string,
  duration = 3000,
  action?: ToastAction,
): ToastItem {
  return {
    id: crypto.randomUUID(),
    type,
    message,
    duration,
    action,
  }
}

function pushToast(type: ToastType, message: string, duration = 3000, action?: ToastAction) {
  const store = getDefaultStore()
  const item = createToastItem(type, message, duration, action)
  store.set(toastsAtom, (prev) => [...prev, item])
  if (duration > 0) {
    setTimeout(() => store.set(removeToastAtom, item.id), duration)
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
 * Toast hook — 返回操作函数（与独立 API 接口完全一致，但通过 Jotai hook 获取 store）
 *
 * v1.9 改造：
 * - 内部用 `createToastItem` 工厂，与独立 `toast` API 共享构造逻辑；
 * - 新增 `action` 方法，补齐与独立 API 的能力差；
 * - 返回接口与 `toast` 对象一一对应，便于在 React 组件内替换。
 *
 * @example
 * const t = useToast()
 * t.success('操作成功')
 * t.action('error', '保存失败', { label: '重试', onClick: () => retry() })
 */
export function useToast() {
  const setToasts = useSetAtom(toastsAtom)
  const removeToast = useSetAtom(removeToastAtom)

  const push = useCallback(
    (type: ToastType, message: string, duration = 3000, action?: ToastAction) => {
      const item = createToastItem(type, message, duration, action)
      setToasts((prev) => [...prev, item])
      if (duration > 0) {
        setTimeout(() => removeToast(item.id), duration)
      }
    },
    [setToasts, removeToast],
  )

  return {
    success: useCallback((msg: string) => push('success', msg), [push]),
    error: useCallback((msg: string) => push('error', msg, 5000), [push]),
    warning: useCallback((msg: string) => push('warning', msg, 4000), [push]),
    info: useCallback((msg: string) => push('info', msg), [push]),
    action: useCallback(
      (type: ToastType, msg: string, action: ToastAction) =>
        push(type, msg, 8000, action),
      [push],
    ),
    push,
  }
}
