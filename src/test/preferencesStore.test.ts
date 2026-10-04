/**
 * preferencesStore 单元测试
 *
 * 领域 store 是 Phase 3 拆分后的真正独立 Zustand store。
 * v1.9 架构优化后,偏好持久化层从 localStorage 迁移到后端 config 模块,
 * 各 setter 同步更新内存 + 异步写后端(configClient.preferences.set)。
 * 本测试锁定默认值、setter 状态更新与编辑器状态持久化副作用。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePreferencesStore, prefsDefaults } from '@/stores/preferencesStore'

// mock configClient.preferences.set(避免实际 IPC 调用)
vi.mock('@/lib/configClient', () => ({
  configClient: {
    preferences: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue({}),
    },
  },
}))

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

  it('setTheme 更新状态并触发后端持久化', async () => {
    const { configClient } = await import('@/lib/configClient')
    const setSpy = vi.mocked(configClient.preferences.set)
    setSpy.mockClear()
    usePreferencesStore.getState().setTheme('dark')
    expect(usePreferencesStore.getState().theme).toBe('dark')
    // 异步写后端被调用(失败静默,无需 await)
    expect(setSpy).toHaveBeenCalledTimes(1)
    // 写入的载荷应包含新 theme 值
    const payload = setSpy.mock.calls[0][0] as { theme: string }
    expect(payload.theme).toBe('dark')
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

  it('saveCurrentEditorState 走 localStorage(运行时状态,不改后端配置)', async () => {
    const { configClient } = await import('@/lib/configClient')
    const setSpy = vi.mocked(configClient.preferences.set)
    setSpy.mockClear()
    const st = usePreferencesStore.getState()
    st.saveCurrentEditorState('b1', 'c1', 120, { from: 5, to: 9 })
    const s = usePreferencesStore.getState()
    expect(s.theme).toBe('system')
    expect(s.fontSize).toBe(16)
    // 编辑器状态走 localStorage,不应触发后端配置写入
    expect(setSpy).not.toHaveBeenCalled()
    // localStorage 中能找到编辑器状态
    const keys = Object.keys(localStorage)
    expect(keys.length).toBeGreaterThan(0)
  })
})
