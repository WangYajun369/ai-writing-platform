/**
 * preferencesStore — 用户偏好领域独立 store
 * （主题/护眼/字体/网格/编辑器宽度/书库视图/编辑器状态恢复）
 *
 * v1.9 架构优化:配置持久化层从 localStorage 迁移到后端统一 config 模块
 * (configClient.preferences → IPC → app_config 表)。
 *
 * 启动流程:
 * 1. store 初始化用 prefsDefaults(同步,避免 SSR / 首帧闪烁)
 * 2. AppInit 调用 `initFromConfig()` 从后端拉取真实配置覆盖默认值
 * 3. 各 set 方法同步更新内存 + 异步写后端(configClient.preferences.set)
 */
import { create } from 'zustand'
import { saveEditorState } from './appTypes'
import { configClient } from '@/lib/configClient'

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
  /** 从后端 config 模块加载真实配置覆盖默认值(AppInit 调用) */
  initFromConfig: () => Promise<void>
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

/** 把当前内存的全部偏好写后端(各 setter 内部调用) */
function persistToBackend(state: PreferenceValues): void {
  // 异步写后端,失败静默(与原 localStorage 失败处理一致)
  void configClient.preferences.set<PreferenceValues>(state).catch(() => {
    /* ignore: 配置写入失败不阻塞 UI */
  })
}

export const usePreferencesStore = create<PreferencesState>()((set, get) => ({
  ...prefsDefaults,

  initFromConfig: async () => {
    try {
      const remote = await configClient.preferences.get<PreferenceValues>()
      // 浅合并:仅覆盖后端返回的字段,缺失字段保留默认值
      set({ ...prefsDefaults, ...remote })
    } catch {
      /* 后端读取失败,保持默认值 */
    }
  },

  setTheme: (theme) => {
    set({ theme })
    persistToBackend(get())
  },
  setEyeCareMode: (eyeCareMode) => {
    set({ eyeCareMode })
    persistToBackend(get())
  },
  setFontFamily: (fontFamily) => {
    set({ fontFamily })
    persistToBackend(get())
  },
  setFontSize: (fontSize) => {
    set({ fontSize })
    persistToBackend(get())
  },
  setGridSize: (gridSize) => {
    set({ gridSize })
    persistToBackend(get())
  },
  setEditorWidth: (editorWidth) => {
    set({ editorWidth })
    persistToBackend(get())
  },
  setLibraryViewMode: (libraryViewMode) => {
    set({ libraryViewMode })
    persistToBackend(get())
  },
  setLibrarySortBy: (librarySortBy) => {
    set({ librarySortBy })
    persistToBackend(get())
  },
  saveCurrentEditorState: (bookId, chapterId, scrollTop, cursorPos) => {
    // 编辑器状态属于运行时状态,仍走 localStorage(数据量按书增长,不属配置)
    saveEditorState({ bookId, chapterId, scrollTop, cursorPos })
  },
}))
