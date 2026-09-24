/**
 * uiAtoms（Jotai）单元测试
 *
 * 23 个 UI atom 是跨组件/跨窗口共享的瞬时状态总线，
 * 本测试锁定默认值、读写语义与「计数器 atom 作为响应式触发器」的项目惯例。
 */
import { describe, it, expect } from 'vitest'
import { createStore } from 'jotai'
import {
  sidebarOpenAtom,
  aiPanelOpenAtom,
  zenModeAtom,
  modalStackAtom,
  wordCountAtom,
  contentRefreshAtom,
  editorCursorPositionAtom,
  isSavingAtom,
  debugWindowOpenAtom,
} from '@/stores/uiAtoms'

describe('uiAtoms 默认值', () => {
  it('布局与编辑器初始状态', () => {
    const store = createStore()
    expect(store.get(sidebarOpenAtom)).toBe(true)
    expect(store.get(aiPanelOpenAtom)).toBe(false)
    expect(store.get(zenModeAtom)).toBe(false)
    expect(store.get(isSavingAtom)).toBe(false)
    expect(store.get(modalStackAtom)).toEqual([])
    expect(store.get(wordCountAtom)).toEqual({ chapter: 0, total: 0 })
    expect(store.get(editorCursorPositionAtom)).toBeNull()
    expect(store.get(debugWindowOpenAtom)).toBe(false)
  })
})

describe('uiAtoms 读写', () => {
  it('面板开关可切换且 store 间隔离', () => {
    const a = createStore()
    const b = createStore()
    a.set(aiPanelOpenAtom, true)
    expect(a.get(aiPanelOpenAtom)).toBe(true)
    expect(b.get(aiPanelOpenAtom)).toBe(false)
  })

  it('modalStack 支持压栈/出栈语义', () => {
    const store = createStore()
    store.set(modalStackAtom, ['import'])
    store.set(modalStackAtom, (prev) => [...prev, 'confirm'])
    expect(store.get(modalStackAtom)).toEqual(['import', 'confirm'])
    store.set(modalStackAtom, (prev) => prev.slice(0, -1))
    expect(store.get(modalStackAtom)).toEqual(['import'])
  })

  it('contentRefreshAtom 作为计数器触发器递增', () => {
    const store = createStore()
    expect(store.get(contentRefreshAtom)).toBe(0)
    store.set(contentRefreshAtom, (c) => c + 1)
    store.set(contentRefreshAtom, (c) => c + 1)
    expect(store.get(contentRefreshAtom)).toBe(2)
  })

  it('光标位置可保存与清空', () => {
    const store = createStore()
    store.set(editorCursorPositionAtom, { from: 10, to: 12 })
    expect(store.get(editorCursorPositionAtom)).toEqual({ from: 10, to: 12 })
    store.set(editorCursorPositionAtom, null)
    expect(store.get(editorCursorPositionAtom)).toBeNull()
  })
})
