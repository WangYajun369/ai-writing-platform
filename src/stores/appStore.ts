import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Book, Chapter, Volume, AiConfig, AiMessage } from '../types'

// ==================== App Store（全局业务状态）====================

/** localStorage 键名，用于持久化用户偏好设置 */
const PREFERENCES_KEY = 'time-write-preferences'
/** localStorage 键名，用于持久化 AI 配置 */
const AI_CONFIG_KEY = 'time-write-ai-config'
/** localStorage 键名，用于持久化 AI 对话记录（按 bookId 分组） */
const AI_CONVERSATIONS_KEY = 'time-write-ai-conversations'

/** 从 localStorage 读取持久化的用户偏好 */
function loadPreferences(): Partial<Pick<AppState, 'gridSize' | 'editorWidth'>> {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

/** 从 localStorage 读取持久化的 AI 配置 */
function loadAiConfig(): Partial<AiConfig> {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

/** 从 localStorage 读取持久化的 AI 对话记录 */
function loadAiConversations(): Record<string, AiMessage[]> {
  try {
    const raw = localStorage.getItem(AI_CONVERSATIONS_KEY)
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

/** 将 AI 配置写入 localStorage */
function saveAiConfig(config: AiConfig) {
  try {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config))
  } catch { /* ignore */ }
}

/** 将 AI 对话记录写入 localStorage */
function saveAiConversations(conversations: Record<string, AiMessage[]>) {
  try {
    localStorage.setItem(AI_CONVERSATIONS_KEY, JSON.stringify(conversations))
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

  // AI 对话记录（按 bookId 分组）
  aiConversations: Record<string, AiMessage[]>

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
  // AI 对话管理
  addAiMessage: (bookId: string, message: AiMessage) => void
  updateAiMessage: (bookId: string, messageId: string, patch: Partial<AiMessage>) => void
  setAiMessages: (bookId: string, messages: AiMessage[]) => void
  clearAiConversation: (bookId: string) => void
  persistAiConversation: (bookId: string) => void
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
const savedAiConfig = loadAiConfig()
const savedAiConversations = loadAiConversations()

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
      maxTokens: 131072,
      ...savedAiConfig,
    },
    aiConversations: savedAiConversations,
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
      set((s) => {
        const merged = { ...s.aiConfig, ...config }
        saveAiConfig(merged)
        return { aiConfig: merged }
      }),

    // AI 对话管理
    // 注意：updateAiMessage 在流式对话期间高频调用，不写 localStorage，
    // 避免同步 I/O 阻塞主线程导致白屏。持久化仅在 add/clear/set 时触发。
    addAiMessage: (bookId, message) =>
      set((s) => {
        const conversations = {
          ...s.aiConversations,
          [bookId]: [...(s.aiConversations[bookId] ?? []), message],
        }
        saveAiConversations(conversations)
        return { aiConversations: conversations }
      }),

    updateAiMessage: (bookId, messageId, patch) =>
      set((s) => {
        const msgs = s.aiConversations[bookId]
        if (!msgs) return s
        // 过滤掉 patch 中值为 undefined 的 key，避免覆盖已有字段
        const cleanPatch: Partial<AiMessage> = {}
        for (const key of Object.keys(patch) as (keyof AiMessage)[]) {
          if (patch[key] !== undefined) {
            ;(cleanPatch as Record<string, unknown>)[key] = patch[key]
          }
        }
        const conversations = {
          ...s.aiConversations,
          [bookId]: msgs.map((m) => (m.id === messageId ? { ...m, ...cleanPatch } : m)),
        }
        // 高频流式更新：仅更新内存，不写 localStorage
        return { aiConversations: conversations }
      }),

    setAiMessages: (bookId, messages) =>
      set((s) => {
        const conversations = { ...s.aiConversations, [bookId]: messages }
        saveAiConversations(conversations)
        return { aiConversations: conversations }
      }),

    clearAiConversation: (bookId) =>
      set((s) => {
        const conversations = { ...s.aiConversations }
        delete conversations[bookId]
        saveAiConversations(conversations)
        return { aiConversations: conversations }
      }),

    persistAiConversation: (_bookId) => {
      const conversations = useAppStore.getState().aiConversations
      saveAiConversations(conversations)
    },

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

/** 获取当前作品的 AI 对话记录（细粒度订阅，避免无关状态变更触发重渲染） */
export const useCurrentAiMessages = () => {
  const currentBookId = useAppStore((s) => s.currentBookId)
  const aiConversations = useAppStore((s) => s.aiConversations)
  if (!currentBookId) return []
  return aiConversations[currentBookId] ?? []
}
