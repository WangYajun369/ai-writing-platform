import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Book, Chapter, Volume, AiConfig } from '../types'

// ==================== App Store（全局业务状态）====================

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

  // AI 配置
  aiConfig: AiConfig

  // 主题
  theme: 'light' | 'dark' | 'system'

  // 护眼模式：关闭 / 暖黄色 / 豆沙绿
  eyeCareMode: 'off' | 'warm' | 'green'

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
  setDbStatus: (status: AppState['dbStatus']) => void
  setLoadingBooks: (v: boolean) => void
  setLoadingChapters: (v: boolean) => void
}

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
