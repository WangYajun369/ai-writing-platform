/**
 * preferencesStore 单元测试
 *
 * 领域 store 是 Phase 3 拆分后的真正独立 Zustand store：
 * 本测试锁定默认值、setter 状态更新与 localStorage 持久化副作用。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreferencesStore, prefsDefaults } from '@/stores/preferencesStore'

describe('preferencesStore', () => {
  beforeEach(() => {
    localStorage.clear()
    usePreferencesStore.setState({ ...prefsDefaults })
  })

  it('默认值与 prefsDefaults 一致', () => {
    const s = usePreferencesStore.getState()
    expect(s.theme).toBe('system')
    expect(s.eyeCareMode).toBe('off')
    expect(s.fontFamily).toBe('yahei')
    expect(s.fontSize).toBe(16)
    expect(s.gridSize).toBe('medium')
    expect(s.editorWidth).toBe('standard')
  })

  it('setTheme 更新状态并持久化', () => {
    usePreferencesStore.getState().setTheme('dark')
    expect(usePreferencesStore.getState().theme).toBe('dark')
    // 持久化副作用：localStorage 中能找到写入痕迹
    const keys = Object.keys(localStorage)
    expect(keys.length).toBeGreaterThan(0)
    const persisted = keys
      .map((k) => localStorage.getItem(k) ?? '')
      .join('\n')
    expect(persisted).toContain('dark')
  })

  it('多个 setter 独立更新互不干扰', () => {
    const st = usePreferencesStore.getState()
    st.setFontSize(20)
    st.setEyeCareMode('warm')
    st.setLibrarySortBy('wordCount')
    const s = usePreferencesStore.getState()
    expect(s.fontSize).toBe(20)
    expect(s.eyeCareMode).toBe('warm')
    expect(s.librarySortBy).toBe('wordCount')
    expect(s.theme).toBe('system') // 未触及的字段保持默认
  })

  it('saveCurrentEditorState 不改动偏好字段', () => {
    const st = usePreferencesStore.getState()
    st.saveCurrentEditorState('b1', 'c1', 120, { from: 5, to: 9 })
    const s = usePreferencesStore.getState()
    expect(s.theme).toBe('system')
    expect(s.fontSize).toBe(16)
  })
})
