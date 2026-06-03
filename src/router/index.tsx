import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LibraryPage from '../pages/LibraryPage'
import EditorPage from '../pages/EditorPage'
import SettingsPage from '../pages/SettingsPage'

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/editor/:bookId" element={<EditorPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* 未匹配路由重定向到首页 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
