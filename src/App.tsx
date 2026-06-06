/**
 * App 根组件 — MirageInk（幻境水墨）
 *
 * 包裹 Jotai Provider 提供全局 UI 状态管理，承担主题与护眼模式初始化逻辑。
 */
import { useEffect } from 'react'
import { Provider as JotaiProvider } from 'jotai'
import AppRouter from './router'
import { useAppStore } from './stores/appStore'

const STORAGE_KEY_THEME = 'mirageink-theme'
const STORAGE_KEY_EYECARE = 'mirageink-eyecare'

/**
 * 应用初始化组件
 *
 * 根据当前主题与护眼模式切换 dark / eyecare class，并持久化到 localStorage。
 */
function AppInit() {
  const { setTheme, theme, eyeCareMode, setEyeCareMode } = useAppStore()

  // 启动时从 localStorage 恢复偏好
  useEffect(() => {
    const savedTheme = localStorage.getItem(STORAGE_KEY_THEME)
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      setTheme(savedTheme)
    }
    const savedEyeCare = localStorage.getItem(STORAGE_KEY_EYECARE)
    if (savedEyeCare === 'off' || savedEyeCare === 'warm' || savedEyeCare === 'green') {
      setEyeCareMode(savedEyeCare)
    }
  }, [])

  // 主题 + 护眼模式应用
  useEffect(() => {
    const root = document.documentElement

    // 移除所有护眼模式 class
    root.classList.remove('eyecare-warm', 'eyecare-green')

    // 主题
    if (theme === 'dark') {
      root.classList.add('dark')
    } else if (theme === 'light') {
      root.classList.remove('dark')
    } else {
      // system
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) {
        root.classList.add('dark')
      } else {
        root.classList.remove('dark')
      }
    }

    // 护眼模式
    if (eyeCareMode === 'warm') {
      root.classList.add('eyecare-warm')
    } else if (eyeCareMode === 'green') {
      root.classList.add('eyecare-green')
    }

    // 持久化
    localStorage.setItem(STORAGE_KEY_THEME, theme)
    localStorage.setItem(STORAGE_KEY_EYECARE, eyeCareMode)
  }, [theme, eyeCareMode])

  return <AppRouter />
}

export default function App() {
  return (
    <JotaiProvider>
      <AppInit />
    </JotaiProvider>
  )
}
