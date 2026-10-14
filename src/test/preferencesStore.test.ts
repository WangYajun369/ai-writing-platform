/**
 * preferencesStore 单元测试
 *
 * 领域 store 是 Phase 3 拆分后的真正独立 Zustand store。
 * v1.9 架构优化后,偏好持久化层从 localStorage 迁移到后端 config 模块,
 * 各 setter 同步更新内存 + 异步写后端(configClient.preferences.set)。
 * 本测试锁定默认值、setter 状态更新、写入门控(configReady)与编辑器状态副作用。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePreferencesStore, prefsDefaults } from '@/stores/preferencesStore'

// mock configClient.preferences(避免实际 IPC 调用)
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
    // configReady=true 表示后端配置已加载完成,允许回写
    usePreferencesStore.setState({ ...prefsDefaults, configReady: true })
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

  it('configReady=false 期间 setter 不触发后端写入（P0 回归保护）', async () => {
    const { configClient } = await import('@/lib/configClient')
    const setSpy = vi.mocked(configClient.preferences.set)
    setSpy.mockClear()
    usePreferencesStore.setState({ ...prefsDefaults, configReady: false })

    usePreferencesStore.getState().setEditorWidth('wide')
    usePreferencesStore.getState().setGridSize('large')

    // 内存已更新
    expect(usePreferencesStore.getState().editorWidth).toBe('wide')
    // 但绝不落盘：避免用默认值覆盖后端已持久化的其它字段
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('启动时序：localStorage 恢复 + 后端加载完成后，后端值胜出且全程零回写', async () => {
    const { configClient } = await import('@/lib/configClient')
    const getSpy = vi.mocked(configClient.preferences.get)
    const setSpy = vi.mocked(configClient.preferences.set)
    setSpy.mockClear()
    // 后端已持久化的真实值（网格/宽度非默认）
    getSpy.mockResolvedValue({
      ...prefsDefaults,
      theme: 'light',
      gridSize: 'large',
      editorWidth: 'wide',
    })

    usePreferencesStore.setState({ ...prefsDefaults, configReady: false })

    // 1) 模拟 useThemeFontInit 的首帧缓存恢复：只写内存
    usePreferencesStore.setState({ theme: 'dark', fontFamily: 'kaiti', fontSize: 20 })

    // 2) 后端配置加载（AppInit 的 useConfigInit）
    const initPromise = usePreferencesStore.getState().initFromConfig()

    // 恢复阶段不得有任何回写
    expect(setSpy).not.toHaveBeenCalled()
    await initPromise

    // 后端值为准，且仍然没有回写
    const s = usePreferencesStore.getState()
    expect(s.configReady).toBe(true)
    expect(s.theme).toBe('light')
    expect(s.gridSize).toBe('large')
    expect(s.editorWidth).toBe('wide')
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('setter 只下发变更的字段（字段级 patch），运行时状态不外泄', async () => {
    const { configClient } = await import('@/lib/configClient')
    const setSpy = vi.mocked(configClient.preferences.set)
    setSpy.mockClear()
    usePreferencesStore.setState({ ...prefsDefaults, configReady: true })

    usePreferencesStore.getState().setEditorWidth('mobile')

    const payload = setSpy.mock.calls[0][0] as Record<string, unknown>
    // 只发发生变化的顶层键，由后端与既有持久化记录浅合并
    expect(Object.keys(payload)).toEqual(['editorWidth'])
    expect(payload.editorWidth).toBe('mobile')
    expect(payload.configReady).toBeUndefined()
  })

  it('initFromConfig 读取失败时保留内存现值（不回退默认值）', async () => {
    const { configClient } = await import('@/lib/configClient')
    const getSpy = vi.mocked(configClient.preferences.get)
    getSpy.mockRejectedValue(new Error('E_CONFIG_READ'))

    usePreferencesStore.setState({ ...prefsDefaults, configReady: false })
    usePreferencesStore.setState({ theme: 'dark' })

    await usePreferencesStore.getState().initFromConfig()

    const s = usePreferencesStore.getState()
    expect(s.theme).toBe('dark') // 首帧缓存提示未被抹掉
    expect(s.configReady).toBe(true) // 但仍开门，保证后续修改能落盘
  })

  it('resetToDefaults 复位内存并持久化默认值', async () => {
    const { configClient } = await import('@/lib/configClient')
    const resetSpy = vi.mocked(configClient.preferences.reset)
    const setSpy = vi.mocked(configClient.preferences.set)
    setSpy.mockClear()
    resetSpy.mockRejectedValue(new Error('E_CONFIG_RESET')) // 降级路径
    usePreferencesStore.setState({ ...prefsDefaults, configReady: true, editorWidth: 'wide', gridSize: 'large' })

    await usePreferencesStore.getState().resetToDefaults()

    const s = usePreferencesStore.getState()
    expect(s.editorWidth).toBe('standard')
    expect(s.gridSize).toBe('medium')
    // 降级时把默认值写回后端，保证用户意图生效
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect((setSpy.mock.calls[0][0] as { editorWidth: string }).editorWidth).toBe('standard')
  })
})
