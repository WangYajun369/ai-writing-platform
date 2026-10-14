/**
 * preferencesStore — 用户偏好领域独立 store
 * （主题/护眼/字体/网格/编辑器宽度/书库视图/编辑器状态恢复）
 *
 * v1.9 架构优化:配置持久化层从 localStorage 迁移到后端统一 config 模块
 * (configClient.preferences → IPC → app_config 表)。
 *
 * 启动流程:
 * 1. store 初始化用 prefsDefaults(同步,避免 SSR / 首帧闪烁),configReady=false
 * 2. AppInit 调用 `initFromConfig()` 从后端拉取真实配置覆盖默认值,并置 configReady=true
 * 3. 各 set 方法同步更新内存 + 异步写后端(configClient.preferences.set)
 *    写入为「字段级 patch」：只发变更的顶层键，后端与既有记录浅合并
 *
 * 写入契约:configReady=false 期间一切回写被丢弃 —— 启动早期内存只有默认值,
 * 若此时落盘会覆盖后端已持久化的 gridSize / editorWidth / librarySortBy 等字段
 * (历史缺陷:useThemeFontInit 的 localStorage 恢复曾触发该覆盖)。
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
  /** 开发者模式：开启后显示「系统检查」设置页与首页「调试控制台」入口 */
  developerMode: boolean
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
  developerMode: false,
}

/**
 * 可持久化字段清单（唯一真源）。
 *
 * 显式枚举而非直接写 `get()`：运行时状态（如 `configReady`）不会被误写进
 * 后端配置，新增偏好字段时必须在此登记，避免"写了却没落盘"的静默丢失。
 * 现在仅 [`persistAll`]（resetToDefaults 降级路径）读取该清单做整段写回，
 * 常规 setter 走字段级 patch。
 */
const PERSISTED_KEYS = [
  'theme',
  'eyeCareMode',
  'fontFamily',
  'fontSize',
  'gridSize',
  'editorWidth',
  'libraryViewMode',
  'librarySortBy',
  'developerMode',
] as const satisfies readonly (keyof PreferenceValues)[]

/** 从 store 状态中摘出可持久化字段（剔除运行时状态与 action） */
function pickPersisted(state: PreferenceValues): PreferenceValues {
  const out = {} as PreferenceValues
  for (const key of PERSISTED_KEYS) {
    // 逐字段拷贝，避免把运行时状态一起送进后端
    Object.assign(out, { [key]: state[key] })
  }
  return out
}

export type PreferencesState = PreferenceValues & {
  /**
   * 后端配置是否已加载完成（运行时状态，不持久化）。
   *
   * 未完成前一律不回写：启动早期内存里只有默认值，此时写后端会把已持久化
   * 的 gridSize / editorWidth / librarySortBy 等字段覆盖为默认值。
   */
  configReady: boolean
  /** 从后端 config 模块加载真实配置覆盖默认值(AppInit 调用) */
  initFromConfig: () => Promise<void>
  /** 将全部偏好重置为默认值（删除后端记录 + 内存复位） */
  resetToDefaults: () => Promise<void>
  setTheme: (theme: ThemeMode) => void
  setEyeCareMode: (eyeCareMode: EyeCareMode) => void
  setFontFamily: (fontFamily: FontFamilyOption) => void
  setFontSize: (fontSize: number) => void
  setGridSize: (gridSize: GridSizeOption) => void
  setEditorWidth: (editorWidth: EditorWidthOption) => void
  setLibraryViewMode: (libraryViewMode: LibraryViewModeOption) => void
  setLibrarySortBy: (librarySortBy: LibrarySortByOption) => void
  setDeveloperMode: (developerMode: boolean) => void
  saveCurrentEditorState: (
    bookId: string,
    chapterId: string,
    scrollTop: number,
    cursorPos: { from: number; to: number } | null,
  ) => void
}

/** 把变更字段以「字段级 patch」写后端(各 setter 内部调用)。
 *
 * 只发送发生变化的顶层键，由后端 `set_config` 与既有持久化记录浅合并 ——
 * 避免整段覆盖写把后端已持久化、但前端未持有的字段（或并发窗口的修改）截断。 */
function persistPatch(patch: Partial<PreferenceValues>): void {
  // 配置未加载完成前不回写：此时内存中是默认值，落盘会覆盖已持久化配置
  if (!usePreferencesStore.getState().configReady) return
  // 异步写后端,失败静默(与原 localStorage 失败处理一致)
  void configClient.preferences.set<Partial<PreferenceValues>>(patch).catch(() => {
    /* ignore: 配置写入失败不阻塞 UI */
  })
}

/** 整段写回全部偏好（仅 resetToDefaults 降级路径使用：后端 reset 失败时兜底覆盖） */
function persistAll(state: PreferencesState): void {
  if (!state.configReady) return
  void configClient.preferences.set<PreferenceValues>(pickPersisted(state)).catch(() => {
    /* ignore: 配置写入失败不阻塞 UI */
  })
}

export const usePreferencesStore = create<PreferencesState>()((set, get) => ({
  ...prefsDefaults,
  configReady: false,

  initFromConfig: async () => {
    let remote: Partial<PreferenceValues> | null = null
    try {
      remote = await configClient.preferences.get<PreferenceValues>()
    } catch {
      /* 后端读取失败,保持内存现值 */
    }
    if (remote) {
      // 浅合并:仅覆盖后端返回的字段,缺失字段保留默认值
      set({ ...prefsDefaults, ...remote, configReady: true })
      return
    }
    // 读取失败:只开门,不回退内存 —— 避免抹掉 localStorage 首帧提示已恢复的值
    set({ configReady: true })
  },

  resetToDefaults: async () => {
    try {
      const remote = await configClient.preferences.reset<PreferenceValues>()
      set({ ...prefsDefaults, ...(remote ?? {}), configReady: true })
      return
    } catch {
      /* 后端重置失败:退化为把默认值写回后端,保证用户意图生效 */
    }
    set({ ...prefsDefaults, configReady: true })
    persistAll(get())
  },

  setTheme: (theme) => {
    set({ theme })
    persistPatch({ theme })
  },
  setEyeCareMode: (eyeCareMode) => {
    set({ eyeCareMode })
    persistPatch({ eyeCareMode })
  },
  setFontFamily: (fontFamily) => {
    set({ fontFamily })
    persistPatch({ fontFamily })
  },
  setFontSize: (fontSize) => {
    set({ fontSize })
    persistPatch({ fontSize })
  },
  setGridSize: (gridSize) => {
    set({ gridSize })
    persistPatch({ gridSize })
  },
  setEditorWidth: (editorWidth) => {
    set({ editorWidth })
    persistPatch({ editorWidth })
  },
  setLibraryViewMode: (libraryViewMode) => {
    set({ libraryViewMode })
    persistPatch({ libraryViewMode })
  },
  setLibrarySortBy: (librarySortBy) => {
    set({ librarySortBy })
    persistPatch({ librarySortBy })
  },
  setDeveloperMode: (developerMode) => {
    set({ developerMode })
    persistPatch({ developerMode })
  },
  saveCurrentEditorState: (bookId, chapterId, scrollTop, cursorPos) => {
    // 编辑器状态属于运行时状态,仍走 localStorage(数据量按书增长,不属配置)
    saveEditorState({ bookId, chapterId, scrollTop, cursorPos })
  },
}))
