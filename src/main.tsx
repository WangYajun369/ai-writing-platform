/**
 * TimeWrite（智写时光）应用入口
 *
 * 挂载 React 根组件到 DOM，启动整个桌面端小说写作应用。
 *
 * 右键菜单策略：
 * - App 根 div 层默认 preventDefault（全局禁用）
 * - 需要右键的组件使用 useContextMenu hook，内部 stopPropagation 放行
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
