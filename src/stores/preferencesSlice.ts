/**
 * 用户偏好 Slice — 主题/护眼/字体/网格/编辑器宽度/书库视图/编辑器状态恢复
 */
import type { AppSlice } from './appTypes'
import { savePreferences, saveEditorState } from './appTypes'

export const prefsDefaults = {
  theme: 'system' as const,
  eyeCareMode: 'off' as const,
  fontFamily: 'yahei' as const,
  fontSize: 16,
  gridSize: 'medium' as const,
  editorWidth: 'standard' as const,
  libraryViewMode: 'grid' as const,
  librarySortBy: 'updatedAt' as const,
}

export const createPreferencesSlice: AppSlice = (set) => ({
  ...prefsDefaults,

  setTheme: (theme) => {
    savePreferences({ theme })
    set({ theme })
  },
  setEyeCareMode: (eyeCareMode) => {
    savePreferences({ eyeCareMode })
    set({ eyeCareMode })
  },
  setFontFamily: (fontFamily) => {
    savePreferences({ fontFamily })
    set({ fontFamily })
  },
  setFontSize: (fontSize) => {
    savePreferences({ fontSize })
    set({ fontSize })
  },
  setGridSize: (gridSize) => {
    savePreferences({ gridSize })
    set({ gridSize })
  },
  setEditorWidth: (editorWidth) => {
    savePreferences({ editorWidth })
    set({ editorWidth })
  },
  setLibraryViewMode: (libraryViewMode) => {
    savePreferences({ libraryViewMode })
    set({ libraryViewMode })
  },
  setLibrarySortBy: (librarySortBy) => {
    savePreferences({ librarySortBy })
    set({ librarySortBy })
  },
  saveCurrentEditorState: (bookId, chapterId, scrollTop, cursorPos) => {
    saveEditorState({ bookId, chapterId, scrollTop, cursorPos })
  },
})
