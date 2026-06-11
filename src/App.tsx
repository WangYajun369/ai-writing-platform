/**
 * App 根组件 — TimeWrite（智写时光）
 *
 * 包裹 Jotai Provider 提供全局 UI 状态管理，委托 AppInit 完成
 * 主题初始化、console 拦截、独立窗口检测与路由分发。
 */
import { Provider as JotaiProvider } from 'jotai'
import AppInit from './components/app/AppInit'

export default function App() {
  return (
    <JotaiProvider>
      <AppInit />
    </JotaiProvider>
  )
}
