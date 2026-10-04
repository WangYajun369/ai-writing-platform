/**
 * uiAtoms（Jotai）单元测试
 *
 * 23 个 UI atom 是跨组件/跨窗口共享的瞬时状态总线，
 * 本测试锁定默认值、读写语义与「计数器 atom 作为响应式触发器」的项目惯例。
 *
 * v1.9 收敛后追加：5 个独立窗口 atom 改为派生 atom（委托到 windowOpenStateAtom），
 * 既有读写语义必须保持等价 —— 本测试同时验证派生 atom 与底层 atom 的一致性。
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
  triggerContentRefreshAtom,
  editorCursorPositionAtom,
  isSavingAtom,
  debugWindowOpenAtom,
  aiToolboxWindowOpenAtom,
  historyWindowOpenAtom,
  worldWindowOpenAtom,
  summaryWindowOpenAtom,
  windowOpenStateAtom,
  type WindowLabel,
  editorStateAtom,
  editorFocusAtom,
  editorInstanceAtom,
  diffViewModeAtom,
  lastSavedAtom,
  editorScrollPositionAtom,
  layoutStateAtom,
  searchOpenAtom,
  hoverKeywordAtom,
  historyPanelOpenAtom,
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

  it('contentRefreshAtom 作为类型化信号递增（v1.9 改造后）', () => {
    const store = createStore()
    // 默认值：source='manual', nonce=0
    expect(store.get(contentRefreshAtom)).toEqual({ source: 'manual', nonce: 0 })
    // 通过 triggerContentRefreshAtom 触发，带 source
    store.set(triggerContentRefreshAtom, 'snapshot')
    store.set(triggerContentRefreshAtom, 'editor')
    const signal = store.get(contentRefreshAtom)
    expect(signal.nonce).toBe(2)
    expect(signal.source).toBe('editor') // 最后一次写入的 source
  })

  it('光标位置可保存与清空', () => {
    const store = createStore()
    store.set(editorCursorPositionAtom, { from: 10, to: 12 })
    expect(store.get(editorCursorPositionAtom)).toEqual({ from: 10, to: 12 })
    store.set(editorCursorPositionAtom, null)
    expect(store.get(editorCursorPositionAtom)).toBeNull()
  })
})

describe('独立窗口标记收敛（v1.9 派生 atom 等价性）', () => {
  // 收敛后 5 个独立窗口 atom 改为派生 atom，委托到 windowOpenStateAtom。
  // 既有调用点零迁移：useAtom / useAtomValue / useSetAtom / store.get / store.set 行为不变。
  // 以下测试同时验证派生 atom 与底层 atom 的一致性。

  it('windowOpenStateAtom 默认全部关闭', () => {
    const store = createStore()
    expect(store.get(windowOpenStateAtom)).toEqual({
      aiToolbox: false,
      history: false,
      world: false,
      summary: false,
      debug: false,
    })
  })

  it('派生 atom 默认值与底层一致', () => {
    const store = createStore()
    expect(store.get(aiToolboxWindowOpenAtom)).toBe(false)
    expect(store.get(historyWindowOpenAtom)).toBe(false)
    expect(store.get(worldWindowOpenAtom)).toBe(false)
    expect(store.get(summaryWindowOpenAtom)).toBe(false)
    expect(store.get(debugWindowOpenAtom)).toBe(false)
  })

  it('派生 atom 写入会反映到底层 atom', () => {
    const store = createStore()
    store.set(aiToolboxWindowOpenAtom, true)
    expect(store.get(windowOpenStateAtom).aiToolbox).toBe(true)
    expect(store.get(aiToolboxWindowOpenAtom)).toBe(true)
    // 其他窗口不应受影响
    expect(store.get(windowOpenStateAtom).history).toBe(false)
    expect(store.get(historyWindowOpenAtom)).toBe(false)
  })

  it('底层 atom 写入会反映到派生 atom', () => {
    const store = createStore()
    store.set(windowOpenStateAtom, {
      aiToolbox: false,
      history: true,
      world: false,
      summary: false,
      debug: false,
    })
    expect(store.get(historyWindowOpenAtom)).toBe(true)
    expect(store.get(aiToolboxWindowOpenAtom)).toBe(false)
  })

  it('多个窗口可同时打开（互不干扰）', () => {
    const store = createStore()
    store.set(debugWindowOpenAtom, true)
    store.set(worldWindowOpenAtom, true)
    expect(store.get(debugWindowOpenAtom)).toBe(true)
    expect(store.get(worldWindowOpenAtom)).toBe(true)
    expect(store.get(aiToolboxWindowOpenAtom)).toBe(false)
    expect(store.get(windowOpenStateAtom)).toMatchObject({
      debug: true,
      world: true,
      aiToolbox: false,
    })
  })

  it('store 间隔离：A 窗口开关不影响 B store', () => {
    const a = createStore()
    const b = createStore()
    a.set(debugWindowOpenAtom, true)
    expect(a.get(debugWindowOpenAtom)).toBe(true)
    expect(b.get(debugWindowOpenAtom)).toBe(false)
    expect(b.get(windowOpenStateAtom).debug).toBe(false)
  })

  it('WindowLabel 类型覆盖全部独立窗口（编译期断言）', () => {
    // 若 WindowLabel 联合类型与底层 windowOpenStateAtom 的键不同步，
    // 以下断言会在编译期失败：TS 会拒绝缺键的对象字面量。
    const labels: WindowLabel[] = [
      'aiToolbox',
      'history',
      'world',
      'summary',
      'debug',
    ]
    expect(labels).toHaveLength(5)
    // 验证 windowOpenStateAtom 的键与 WindowLabel 完全一致
    const store = createStore()
    const state = store.get(windowOpenStateAtom)
    const keys = Object.keys(state).sort()
    expect(labels.slice().sort()).toEqual(keys)
  })
})

describe('编辑器会话状态收敛（v1.9 派生 atom 等价性）', () => {
  // 收敛后 8 个编辑器会话 atom 改为派生 atom，委托到 editorStateAtom。
  // 既有调用点零迁移：useAtom / useAtomValue / useSetAtom / store.get / store.set 行为不变。
  // 以下测试同时验证派生 atom 与底层 atom 的双向一致性。

  it('editorStateAtom 默认值与原 8 个独立 atom 默认值一致', () => {
    const store = createStore()
    const state = store.get(editorStateAtom)
    expect(state.focus).toBe(false)
    expect(state.instance).toBeNull()
    expect(state.diffViewMode).toBe('side-by-side')
    expect(state.isSaving).toBe(false)
    expect(state.lastSaved).toBeNull()
    expect(state.wordCount).toEqual({ chapter: 0, total: 0 })
    expect(state.scrollPosition).toBe(0)
    expect(state.cursorPosition).toBeNull()
    // 派生 atom 默认值与底层一致
    expect(store.get(editorFocusAtom)).toBe(state.focus)
    expect(store.get(editorInstanceAtom)).toBeNull()
    expect(store.get(diffViewModeAtom)).toBe(state.diffViewMode)
    expect(store.get(isSavingAtom)).toBe(state.isSaving)
    expect(store.get(lastSavedAtom)).toBeNull()
    expect(store.get(wordCountAtom)).toEqual(state.wordCount)
    expect(store.get(editorScrollPositionAtom)).toBe(state.scrollPosition)
    expect(store.get(editorCursorPositionAtom)).toBeNull()
  })

  it('派生 atom 写入会反映到底层 editorStateAtom', () => {
    const store = createStore()
    store.set(editorFocusAtom, true)
    expect(store.get(editorStateAtom).focus).toBe(true)
    expect(store.get(editorFocusAtom)).toBe(true)
    // 其他字段不应受影响
    expect(store.get(editorStateAtom).isSaving).toBe(false)
  })

  it('底层 editorStateAtom 写入会反映到派生 atom', () => {
    const store = createStore()
    const now = new Date()
    store.set(editorStateAtom, {
      focus: true,
      instance: null,
      diffViewMode: 'inline',
      isSaving: true,
      lastSaved: now,
      wordCount: { chapter: 100, total: 5000 },
      scrollPosition: 42,
      cursorPosition: { from: 10, to: 20 },
    })
    expect(store.get(editorFocusAtom)).toBe(true)
    expect(store.get(diffViewModeAtom)).toBe('inline')
    expect(store.get(isSavingAtom)).toBe(true)
    expect(store.get(lastSavedAtom)).toBe(now)
    expect(store.get(wordCountAtom)).toEqual({ chapter: 100, total: 5000 })
    expect(store.get(editorScrollPositionAtom)).toBe(42)
    expect(store.get(editorCursorPositionAtom)).toEqual({ from: 10, to: 20 })
  })

  it('更新多个派生 atom 不会相互覆盖（每次都合并到 editorStateAtom）', () => {
    const store = createStore()
    store.set(editorFocusAtom, true)
    store.set(isSavingAtom, true)
    store.set(wordCountAtom, { chapter: 50, total: 3000 })
    const state = store.get(editorStateAtom)
    expect(state).toMatchObject({
      focus: true,
      isSaving: true,
      wordCount: { chapter: 50, total: 3000 },
    })
    // 其他字段保持默认
    expect(state.diffViewMode).toBe('side-by-side')
    expect(state.scrollPosition).toBe(0)
  })

  it('cursorPosition 可清空（写入 null）', () => {
    const store = createStore()
    store.set(editorCursorPositionAtom, { from: 5, to: 8 })
    expect(store.get(editorStateAtom).cursorPosition).toEqual({ from: 5, to: 8 })
    store.set(editorCursorPositionAtom, null)
    expect(store.get(editorStateAtom).cursorPosition).toBeNull()
    expect(store.get(editorCursorPositionAtom)).toBeNull()
  })

  it('store 间隔离：A store 的编辑器状态不影响 B store', () => {
    const a = createStore()
    const b = createStore()
    a.set(editorFocusAtom, true)
    a.set(isSavingAtom, true)
    expect(a.get(editorStateAtom).focus).toBe(true)
    expect(b.get(editorStateAtom).focus).toBe(false)
    expect(b.get(editorFocusAtom)).toBe(false)
    expect(b.get(isSavingAtom)).toBe(false)
  })

  it('contentRefreshAtom 独立保留（不进入 editorStateAtom）', () => {
    // contentRefresh 是类型化信号 atom，独立保留以保持语义解耦
    const store = createStore()
    expect(store.get(contentRefreshAtom).nonce).toBe(0)
    store.set(triggerContentRefreshAtom, 'manual')
    expect(store.get(contentRefreshAtom).nonce).toBe(1)
    // 不应污染 editorStateAtom
    const state = store.get(editorStateAtom)
    expect(
      (state as unknown as Record<string, unknown>).contentRefresh,
    ).toBeUndefined()
  })
})

describe('布局开关状态收敛（v1.9 派生 atom 等价性）', () => {
  // 收敛后 6 个布局/UI 开关 atom 改为派生 atom，委托到 layoutStateAtom。
  // 既有调用点零迁移：useAtom / useAtomValue / useSetAtom / store.get / store.set 行为不变。
  // 以下测试同时验证派生 atom 与底层 atom 的双向一致性。

  it('layoutStateAtom 默认值与原 6 个独立 atom 默认值一致', () => {
    const store = createStore()
    const state = store.get(layoutStateAtom)
    expect(state.sidebar).toBe(true)
    expect(state.aiPanel).toBe(false)
    expect(state.historyPanel).toBe(false)
    expect(state.zen).toBe(false)
    expect(state.search).toBe(false)
    expect(state.hoverKeyword).toBeNull()
    // 派生 atom 默认值与底层一致
    expect(store.get(sidebarOpenAtom)).toBe(state.sidebar)
    expect(store.get(aiPanelOpenAtom)).toBe(state.aiPanel)
    expect(store.get(historyPanelOpenAtom)).toBe(state.historyPanel)
    expect(store.get(zenModeAtom)).toBe(state.zen)
    expect(store.get(searchOpenAtom)).toBe(state.search)
    expect(store.get(hoverKeywordAtom)).toBeNull()
  })

  it('派生 atom 写入会反映到底层 layoutStateAtom', () => {
    const store = createStore()
    store.set(sidebarOpenAtom, false)
    expect(store.get(layoutStateAtom).sidebar).toBe(false)
    expect(store.get(sidebarOpenAtom)).toBe(false)
    // 其他字段不应受影响
    expect(store.get(layoutStateAtom).aiPanel).toBe(false)
  })

  it('底层 layoutStateAtom 写入会反映到派生 atom', () => {
    const store = createStore()
    store.set(layoutStateAtom, {
      sidebar: false,
      aiPanel: true,
      historyPanel: true,
      zen: true,
      search: true,
      hoverKeyword: '主角',
    })
    expect(store.get(sidebarOpenAtom)).toBe(false)
    expect(store.get(aiPanelOpenAtom)).toBe(true)
    expect(store.get(historyPanelOpenAtom)).toBe(true)
    expect(store.get(zenModeAtom)).toBe(true)
    expect(store.get(searchOpenAtom)).toBe(true)
    expect(store.get(hoverKeywordAtom)).toBe('主角')
  })

  it('更新多个派生 atom 不会相互覆盖', () => {
    const store = createStore()
    store.set(aiPanelOpenAtom, true)
    store.set(zenModeAtom, true)
    store.set(hoverKeywordAtom, '伏笔')
    const state = store.get(layoutStateAtom)
    expect(state).toMatchObject({
      aiPanel: true,
      zen: true,
      hoverKeyword: '伏笔',
    })
    // 其他字段保持默认
    expect(state.sidebar).toBe(true)
    expect(state.search).toBe(false)
  })

  it('hoverKeyword 可清空（写入 null）', () => {
    const store = createStore()
    store.set(hoverKeywordAtom, '人物')
    expect(store.get(layoutStateAtom).hoverKeyword).toBe('人物')
    store.set(hoverKeywordAtom, null)
    expect(store.get(layoutStateAtom).hoverKeyword).toBeNull()
    expect(store.get(hoverKeywordAtom)).toBeNull()
  })

  it('store 间隔离：A store 的布局状态不影响 B store', () => {
    const a = createStore()
    const b = createStore()
    a.set(sidebarOpenAtom, false)
    a.set(zenModeAtom, true)
    expect(a.get(layoutStateAtom).sidebar).toBe(false)
    expect(b.get(layoutStateAtom).sidebar).toBe(true)
    expect(b.get(sidebarOpenAtom)).toBe(true)
    expect(b.get(zenModeAtom)).toBe(false)
  })
})
