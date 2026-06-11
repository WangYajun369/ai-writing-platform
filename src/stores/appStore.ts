/**
 * AppStore — 全局业务状态（Zustand）
 *
 * 使用 slice 模式将不同领域的状态与操作分离到独立文件，
 * 对外暴露统一的 useAppStore hook，保持向后兼容。
 */
import { create } from 'zustand'
import type { AppState } from './appTypes'
import { createBooksSlice } from './booksSlice'
import { createAiSlice } from './aiSlice'
import { createPreferencesSlice, prefsDefaults } from './preferencesSlice'
import { preferencesStore } from './appTypes'

// Re-export 类型与工具函数，保持原有导入路径不变
export type { UserPreferences, EditorState } from './appTypes'
export { getEditorState } from './appTypes'

// 启动时从 localStorage 恢复偏好默认值
const savedPrefs = preferencesStore.load()

export const useAppStore = create<AppState>()((...a) => {
  const books = createBooksSlice(...a)
  const ai = createAiSlice(...a)
  const prefs = createPreferencesSlice(...a)
  return {
    ...books,
    ...ai,
    ...prefs,
    // 用 localStorage 值覆盖偏好默认值
    theme: savedPrefs.theme ?? prefsDefaults.theme,
    eyeCareMode: savedPrefs.eyeCareMode ?? prefsDefaults.eyeCareMode,
    fontFamily: savedPrefs.fontFamily ?? prefsDefaults.fontFamily,
    fontSize: savedPrefs.fontSize ?? prefsDefaults.fontSize,
    gridSize: savedPrefs.gridSize ?? prefsDefaults.gridSize,
    editorWidth: savedPrefs.editorWidth ?? prefsDefaults.editorWidth,
    libraryViewMode: savedPrefs.libraryViewMode ?? prefsDefaults.libraryViewMode,
    librarySortBy: savedPrefs.librarySortBy ?? prefsDefaults.librarySortBy,
  } as AppState
})

// ==================== 便捷选择器 ====================

export const useCurrentBook = () => {
  const { books, currentBookId } = useAppStore()
  return books.find((b) => b.id === currentBookId) ?? null
}

export const useCurrentChapter = () => {
  const { chapters, currentChapterId } = useAppStore()
  return chapters.find((c) => c.id === currentChapterId) ?? null
}

/** 获取当前作品的 AI 对话记录（细粒度订阅） */
export const useCurrentAiMessages = () => {
  const currentBookId = useAppStore((s) => s.currentBookId)
  const aiConversations = useAppStore((s) => s.aiConversations)
  if (!currentBookId) return []
  return aiConversations[currentBookId] ?? []
}
