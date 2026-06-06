import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Book, Chapter, Volume, AiConfig } from '../types'

// ==================== App Store（全局业务状态）====================

/** localStorage 键名，用于持久化用户偏好设置 */
const PREFERENCES_KEY = 'mirage-ink-preferences'

/** 从 localStorage 读取持久化的用户偏好 */
function loadPreferences(): Partial<Pick<AppState, 'gridSize' | 'editorWidth'>> {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

/** 将用户偏好写入 localStorage */
function savePreferences(prefs: Pick<AppState, 'gridSize' | 'editorWidth'>) {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs))
  } catch { /* ignore */ }
}

interface AppState {
  // 书籍列表
  books: Book[]
  currentBookId: string | null
  isLoadingBooks: boolean

  // 当前书籍的卷/章节树
  volumes: Volume[]
  chapters: Chapter[]
  currentChapterId: string | null
  isLoadingChapters: boolean

  // 数据库连接状态
  dbStatus: 'idle' | 'connected' | 'error'

  // AI 连接状态
  aiConnectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  aiConnectionDetail: string

  // AI 配置
  aiConfig: AiConfig

  // 主题
  theme: 'light' | 'dark' | 'system'

  // 护眼模式：关闭 / 暖黄色 / 豆沙绿
  eyeCareMode: 'off' | 'warm' | 'green'

  // 全局字体
  fontFamily: 'serif' | 'simhei' | 'simsun' | 'kaiti' | 'yahei'

  // 全局字体大小（px）
  fontSize: number

  // 作品列表网格大小
  gridSize: 'small' | 'medium' | 'large'

  // 编辑器显示宽度
  editorWidth: 'mobile' | 'standard' | 'wide'

  // Actions
  setBooks: (books: Book[]) => void
  setCurrentBookId: (id: string | null) => void
  setVolumes: (volumes: Volume[]) => void
  setChapters: (chapters: Chapter[]) => void
  setCurrentChapterId: (id: string | null) => void
  updateChapter: (id: string, patch: Partial<Chapter>) => void
  addChapter: (chapter: Chapter) => void
  removeChapter: (id: string) => void
  updateBook: (id: string, patch: Partial<Book>) => void
  addBook: (book: Book) => void
  removeBook: (id: string) => void
  setAiConfig: (config: Partial<AiConfig>) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setEyeCareMode: (mode: 'off' | 'warm' | 'green') => void
  setFontFamily: (font: AppState['fontFamily']) => void
  setFontSize: (size: number) => void
  setGridSize: (gridSize: AppState['gridSize']) => void
  setEditorWidth: (editorWidth: AppState['editorWidth']) => void
  setAiConnectionStatus: (status: AppState['aiConnectionStatus'], detail?: string) => void
  setDbStatus: (status: AppState['dbStatus']) => void
  setLoadingBooks: (v: boolean) => void
  setLoadingChapters: (v: boolean) => void
}

const savedPrefs = loadPreferences()

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set) => ({
    books: [],
    currentBookId: null,
    isLoadingBooks: false,
    volumes: [],
    chapters: [],
    currentChapterId: null,
    isLoadingChapters: false,
    dbStatus: 'idle',
    aiConnectionStatus: 'idle',
    aiConnectionDetail: '',
    aiConfig: {
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b',
      embeddingModel: 'bge-m3',
      temperature: 0.7,
      maxTokens: 2048,
    },
    theme: 'system',
    eyeCareMode: 'off',
    fontFamily: 'serif',
    fontSize: 16,
    gridSize: savedPrefs.gridSize ?? 'medium',
    editorWidth: savedPrefs.editorWidth ?? 'standard',

    setBooks: (books) => set({ books }),
    setCurrentBookId: (id) => set({ currentBookId: id }),
    setVolumes: (volumes) => set({ volumes }),
    setChapters: (chapters) => set({ chapters }),
    setCurrentChapterId: (id) => set({ currentChapterId: id }),

    updateChapter: (id, patch) =>
      set((s) => ({
        chapters: s.chapters.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),

    addChapter: (chapter) =>
      set((s) => ({ chapters: [...s.chapters, chapter] })),

    removeChapter: (id) =>
      set((s) => ({ chapters: s.chapters.filter((c) => c.id !== id) })),

    updateBook: (id, patch) =>
      set((s) => ({
        books: s.books.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      })),

    addBook: (book) => set((s) => ({ books: [...s.books, book] })),
    removeBook: (id) => set((s) => ({ books: s.books.filter((b) => b.id !== id) })),

    setAiConfig: (config) =>
      set((s) => ({ aiConfig: { ...s.aiConfig, ...config } })),

    setTheme: (theme) => set({ theme }),
    setEyeCareMode: (eyeCareMode) => set({ eyeCareMode }),
    setFontFamily: (fontFamily) => set({ fontFamily }),
    setFontSize: (fontSize) => set({ fontSize }),
    setGridSize: (gridSize) => {
      savePreferences({ gridSize, editorWidth: useAppStore.getState().editorWidth })
      set({ gridSize })
    },
    setEditorWidth: (editorWidth) => {
      savePreferences({ gridSize: useAppStore.getState().gridSize, editorWidth })
      set({ editorWidth })
    },
    setAiConnectionStatus: (aiConnectionStatus, aiConnectionDetail = '') =>
      set({ aiConnectionStatus, aiConnectionDetail }),
    setDbStatus: (dbStatus) => set({ dbStatus }),
    setLoadingBooks: (v) => set({ isLoadingBooks: v }),
    setLoadingChapters: (v) => set({ isLoadingChapters: v }),
  }))
)

// 便捷选择器
export const useCurrentBook = () => {
  const { books, currentBookId } = useAppStore()
  return books.find((b) => b.id === currentBookId) ?? null
}

export const useCurrentChapter = () => {
  const { chapters, currentChapterId } = useAppStore()
  return chapters.find((c) => c.id === currentChapterId) ?? null
}
