/**
 * 前端路由定义 — MirageInk（幻境水墨）
 *
 * 基于 React Router v7，使用 lazy 加载优化首屏性能。
 * 路由表：/ → 书库，/editor/:bookId → 编辑器，/settings → 设置。
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import LibraryPage from '../pages/LibraryPage'

const EditorPage = lazy(() => import('../pages/EditorPage'))
const SettingsPage = lazy(() => import('../pages/SettingsPage'))

/**
 * 路由懒加载过渡组件
 *
 * 在页面代码按需下载时展示一个居中的加载动画。
 */
function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-[#0a0a0a]">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-900 dark:border-gray-600 dark:border-t-white rounded-full animate-spin" />
        <p className="text-sm text-gray-500 dark:text-gray-400">加载中...</p>
      </div>
    </div>
  )
}

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/editor/:bookId" element={<EditorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
