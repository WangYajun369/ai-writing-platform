/**
 * preferencesStore — 用户偏好领域独立 store
 * （主题/护眼/字体/网格/编辑器宽度/书库视图/编辑器状态恢复）
 *
 * Phase 3 问题 3 收尾：由原 preferencesSlice 升级为真正独立的 Zustand store。
 */
import { create } from 'zustand'
import { savePreferences, saveEditorState } from './appTypes'

export type ThemeMode = 'light' | 'dark' | 'system'
export type EyeCareMode = 'off' | 'warm' | 'green'
export type FontFamilyOption = 'yahei' | 'simhei' | 'simsun' | 'kaiti'
export type GridSizeOption = 'small' | 'medium' | 'large'
export type EditorWidthOption = 'standard' | 'wide' | 'mobile'
export type LibraryViewModeOption = 'grid' | 'list'
export type LibrarySortByOption = 'updatedAt' | 'createdAt' | 'title' | 'wordCount'

/** 可持久化的偏好值集合（默认值 + 存储结构） */
export type PreferenceValues = {
  theme: ThemeMode
  eyeCareMode: EyeCareMode
  fontFamily: FontFamilyOption
  fontSize: number
  gridSize: GridSizeOption
  editorWidth: EditorWidthOption
  libraryViewMode: LibraryViewModeOption
  librarySortBy: LibrarySortByOption
}

export const prefsDefaults: PreferenceValues = {
  theme: 'system',
  eyeCareMode: 'off',
  fontFamily: 'yahei',
  fontSize: 16,
  gridSize: 'medium',
  editorWidth: 'standard',
  libraryViewMode: 'grid',
  librarySortBy: 'updatedAt',
}

export type PreferencesState = PreferenceValues & {
  setTheme: (theme: ThemeMode) => void
  setEyeCareMode: (eyeCareMode: EyeCareMode) => void
  setFontFamily: (fontFamily: FontFamilyOption) => void
  setFontSize: (fontSize: number) => void
  setGridSize: (gridSize: GridSizeOption) => void
  setEditorWidth: (editorWidth: EditorWidthOption) => void
  setLibraryViewMode: (libraryViewMode: LibraryViewModeOption) => void
  setLibrarySortBy: (librarySortBy: LibrarySortByOption) => void
  saveCurrentEditorState: (
    bookId: string,
    chapterId: string,
    scrollTop: number,
    cursorPos: { from: number; to: number } | null,
  ) => void
}

export const usePreferencesStore = create<PreferencesState>()((set) => ({
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
}))
