/**
 * TimeWrite（智写时光）应用入口
 *
 * 挂载 React 根组件到 DOM，启动整个桌面端小说写作应用。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/globals.css'

// 全局禁用鼠标右键菜单
document.addEventListener('contextmenu', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
