import { useEffect } from 'react'
import { useAppStore } from '@/stores/appStore'

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
  const {
    theme, eyeCareMode, fontFamily, fontSize,
    setTheme, setEyeCareMode, setFontFamily, setFontSize,
  } = useAppStore()

  // 启动时从 localStorage 恢复
  useEffect(() => {
    const savedTheme = localStorage.getItem(STORAGE_KEY_THEME)
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') setTheme(savedTheme)
    const savedEyeCare = localStorage.getItem(STORAGE_KEY_EYECARE)
    if (savedEyeCare === 'off' || savedEyeCare === 'warm' || savedEyeCare === 'green') setEyeCareMode(savedEyeCare)
    const savedFont = localStorage.getItem(STORAGE_KEY_FONT)
    if (savedFont && savedFont in FONT_FAMILY_MAP) setFontFamily(savedFont as 'simhei' | 'simsun' | 'kaiti' | 'yahei')
    const savedFontSize = localStorage.getItem(STORAGE_KEY_FONT_SIZE)
    if (savedFontSize) {
      const size = parseInt(savedFontSize, 10)
      if (size >= 12 && size <= 24) setFontSize(size)
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
