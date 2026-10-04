/**
 * Toast 通知系统单元测试
 *
 * v1.9 收敛改造后：
 * - toastsAtom 是单一真源；
 * - removeToastAtom / clearAllToastsAtom 是派生 writable atom，委托到 toastsAtom；
 * - createToastItem 工厂统一构造逻辑，独立 API 与 useToast hook 共享。
 *
 * 本测试锁定：
 * - toastsAtom 默认值；
 * - removeToastAtom / clearAllToastsAtom 派生写入正确委托到 toastsAtom；
 * - createToastItem 工厂生成结构正确（含 action 与不含 action 两种）；
 * - 派生 atom 不破坏 toastsAtom 的既有语义（多 toast 共存、id 过滤）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from 'jotai'
import {
  toastsAtom,
  removeToastAtom,
  clearAllToastsAtom,
  createToastItem,
  type ToastItem,
} from '@/lib/toast'

describe('toast atom 收敛（v1.9 派生 atom 等价性）', () => {
  let store: ReturnType<typeof createStore>
  beforeEach(() => {
    store = createStore()
    store.set(clearAllToastsAtom)
  })

  it('toastsAtom 默认空队列', () => {
    expect(store.get(toastsAtom)).toEqual([])
  })

  it('removeToastAtom 按 id 移除单条通知（委托到 toastsAtom）', () => {
    const a: ToastItem = { id: 'a', type: 'info', message: 'A' }
    const b: ToastItem = { id: 'b', type: 'error', message: 'B' }
    store.set(toastsAtom, [a, b])

    store.set(removeToastAtom, 'a')

    expect(store.get(toastsAtom)).toEqual([b])
  })

  it('removeToastAtom 移除不存在的 id 不报错（幂等）', () => {
    const a: ToastItem = { id: 'a', type: 'info', message: 'A' }
    store.set(toastsAtom, [a])

    store.set(removeToastAtom, 'nonexistent')

    expect(store.get(toastsAtom)).toEqual([a])
  })

  it('clearAllToastsAtom 清空全部（委托到 toastsAtom）', () => {
    const a: ToastItem = { id: 'a', type: 'info', message: 'A' }
    const b: ToastItem = { id: 'b', type: 'error', message: 'B' }
    store.set(toastsAtom, [a, b])

    store.set(clearAllToastsAtom)

    expect(store.get(toastsAtom)).toEqual([])
  })

  it('store 间隔离：A store 的 toast 不影响 B store', () => {
    const a = createStore()
    const b = createStore()
    a.set(toastsAtom, [{ id: 'a1', type: 'info', message: 'A1' }])

    expect(a.get(toastsAtom)).toHaveLength(1)
    expect(b.get(toastsAtom)).toEqual([])
  })
})

describe('createToastItem 工厂', () => {
  it('生成正确结构（无 action）', () => {
    const item = createToastItem('success', '操作成功', 3000)
    expect(item.id).toBeTruthy()
    expect(item.type).toBe('success')
    expect(item.message).toBe('操作成功')
    expect(item.duration).toBe(3000)
    expect(item.action).toBeUndefined()
  })

  it('生成正确结构（带 action）', () => {
    const action = { label: '重试', onClick: () => {} }
    const item = createToastItem('error', '保存失败', 8000, action)
    expect(item.type).toBe('error')
    expect(item.message).toBe('保存失败')
    expect(item.duration).toBe(8000)
    expect(item.action).toBe(action)
  })

  it('每次调用生成不同 id（crypto.randomUUID）', () => {
    const a = createToastItem('info', 'A')
    const b = createToastItem('info', 'B')
    expect(a.id).not.toBe(b.id)
  })

  it('默认 duration=3000', () => {
    const item = createToastItem('info', 'msg')
    expect(item.duration).toBe(3000)
  })
})
