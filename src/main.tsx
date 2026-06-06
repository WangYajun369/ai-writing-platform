/**
 * MirageInk（幻境水墨）应用入口
 *
 * 挂载 React 根组件到 DOM，启动整个桌面端小说写作应用。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
