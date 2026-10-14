/**
 * useThemeFontInit — 主题 / 护眼 / 字体偏好初始化与 DOM 应用
 *
 * 由应用根初始化（AppInit）挂载一次。
 *
 * 职责划分（重要）:
 * - **持久化归 store**：本 Hook 只负责"把 store 的值翻译成 DOM class / CSS 变量"，
 *   以及维护一份仅供首帧使用的 localStorage 缓存。
 * - **恢复只写内存**：启动时的恢复通过 `usePreferencesStore.setState(...)` 直接写内存，
 *   **绝不经过 setter**（setter 会触发整段回写后端）。历史缺陷：恢复路径调用 setter，
 *   在 configReady=false 期间把尚未加载的字段以默认值覆盖进后端配置。
 *
 * 本 Hook 的 localStorage 键只是首帧提示，读取后由后端配置覆盖；不是真源。
 */
import { useEffect } from 'react'
import { usePreferencesStore } from '@/stores/preferencesStore'
import type { FontFamilyOption, PreferenceValues } from '@/stores/preferencesStore'

const STORAGE_KEY_THEME = 'timewrite-theme'
const STORAGE_KEY_EYECARE = 'timewrite-eyecare'
const STORAGE_KEY_FONT = 'timewrite-font'
const STORAGE_KEY_FONT_SIZE = 'timewrite-font-size'

const FONT_FAMILY_MAP: Record<string, string> = {
  yahei: "'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  simhei: "SimHei, 'Noto Sans SC', sans-serif",
  simsun: "SimSun, 'Noto Serif SC', serif",
  kaiti: "KaiTi, 'Noto Serif SC', serif",
}

/**
 * 从 localStorage 恢复主题/护眼/字体偏好，并应用 DOM class/CSS 变量
 */
export function useThemeFontInit() {
  const { theme, eyeCareMode, fontFamily, fontSize } = usePreferencesStore()

  // 启动时从 localStorage 首帧缓存恢复（直接写内存，不经过 setter，因此不回写后端）
  useEffect(() => {
    const restored: Partial<
      Pick<PreferenceValues, 'theme' | 'eyeCareMode' | 'fontFamily' | 'fontSize'>
    > = {}

    const savedTheme = localStorage.getItem(STORAGE_KEY_THEME)
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      restored.theme = savedTheme
    }
    const savedEyeCare = localStorage.getItem(STORAGE_KEY_EYECARE)
    if (savedEyeCare === 'off' || savedEyeCare === 'warm' || savedEyeCare === 'green') {
      restored.eyeCareMode = savedEyeCare
    }
    const savedFont = localStorage.getItem(STORAGE_KEY_FONT)
    if (savedFont && savedFont in FONT_FAMILY_MAP) {
      restored.fontFamily = savedFont as FontFamilyOption
    }
    const savedFontSize = localStorage.getItem(STORAGE_KEY_FONT_SIZE)
    if (savedFontSize) {
      const size = parseInt(savedFontSize, 10)
      if (size >= 12 && size <= 24) restored.fontSize = size
    }

    if (Object.keys(restored).length > 0) {
      usePreferencesStore.setState(restored)
    }
  }, [])

  // 主题 + 护眼模式 → DOM class
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('eyecare-warm', 'eyecare-green')

    if (theme === 'dark') {
      root.classList.add('dark')
    } else if (theme === 'light') {
      root.classList.remove('dark')
    } else {
      root.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches)
    }

    if (eyeCareMode === 'warm') root.classList.add('eyecare-warm')
    else if (eyeCareMode === 'green') root.classList.add('eyecare-green')

    localStorage.setItem(STORAGE_KEY_THEME, theme)
    localStorage.setItem(STORAGE_KEY_EYECARE, eyeCareMode)
  }, [theme, eyeCareMode])

  // 字体 → CSS 变量
  useEffect(() => {
    document.documentElement.style.setProperty('--font-editor', FONT_FAMILY_MAP[fontFamily] ?? FONT_FAMILY_MAP.yahei)
    localStorage.setItem(STORAGE_KEY_FONT, fontFamily)
  }, [fontFamily])

  // 字号 → CSS 变量
  useEffect(() => {
    document.documentElement.style.setProperty('--font-editor-size', `${fontSize}px`)
    localStorage.setItem(STORAGE_KEY_FONT_SIZE, String(fontSize))
  }, [fontSize])
}
