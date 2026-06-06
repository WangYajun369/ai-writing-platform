/**
 * App 根组件 — MirageInk（幻境水墨）
 *
 * 包裹 Jotai Provider 提供全局 UI 状态管理，承担主题初始化逻辑。
 */
import { useEffect } from 'react'
import { Provider as JotaiProvider } from 'jotai'
import AppRouter from './router'
import { useAppStore } from './stores/appStore'

/**
 * 应用初始化组件
 *
 * 根据当前主题设置切换 dark class，监听系统偏好变化。
 */
function AppInit() {
  const { setTheme, theme } = useAppStore()

  useEffect(() => {
    // 应用主题
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else if (theme === 'light') {
      root.classList.remove('dark')
    } else {
      // system
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) {
        root.classList.add('dark')
      }
    }
  }, [theme, setTheme])

  return <AppRouter />
}

export default function App() {
  return (
    <JotaiProvider>
      <AppInit />
    </JotaiProvider>
  )
}
