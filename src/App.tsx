import { useEffect } from 'react'
import { Provider as JotaiProvider } from 'jotai'
import AppRouter from './router'
import { useAppStore } from './stores/appStore'

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
