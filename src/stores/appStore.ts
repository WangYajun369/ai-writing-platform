import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Book, Chapter, Volume, AiConfig, AiMessage, AiChatConfig } from '../types'

// ==================== App Store（全局业务状态）====================

/** localStorage 键名，用于持久化用户偏好设置 */
const PREFERENCES_KEY = 'time-write-preferences'
/** localStorage 键名，用于持久化 AI 配置 */
const AI_CONFIG_KEY = 'time-write-ai-config'
/** localStorage 键名，用于持久化 AI 对话记录（按 bookId 分组） */
const AI_CONVERSATIONS_KEY = 'time-write-ai-conversations'
/** localStorage 键名，用于持久化编辑器状态（按 bookId 保存当前编辑位置） */
const EDITOR_STATE_KEY = 'time-write-editor-state'

/** 编辑器恢复状态（记录用户上次编辑的作品、章节和光标位置） */
export interface EditorState {
  bookId: string
  chapterId: string
  scrollTop: number
  cursorPos: { from: number; to: number } | null
}

/** 从 localStorage 读取所有作品的编辑器状态 */
function loadAllEditorStates(): Record<string, EditorState> {
  try {
    const raw = localStorage.getItem(EDITOR_STATE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

/** 保存指定作品的编辑器状态到 localStorage */
function saveEditorState(state: EditorState) {
  try {
    const all = loadAllEditorStates()
    all[state.bookId] = state
    localStorage.setItem(EDITOR_STATE_KEY, JSON.stringify(all))
  } catch { /* ignore */ }
}

/** 获取指定作品上次的编辑器状态 */
export function getEditorState(bookId: string): EditorState | null {
  const all = loadAllEditorStates()
  return all[bookId] ?? null
}

/** 从 localStorage 读取持久化的用户偏好（含外观设置） */
function loadPreferences(): Partial<Pick<AppState, 'theme' | 'eyeCareMode' | 'fontFamily' | 'fontSize' | 'gridSize' | 'editorWidth'>> {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

/** 检测旧版扁平 AiConfig 格式（无 .chat/.rag 嵌套），转为新格式 */
function isLegacyAiConfig(raw: Record<string, unknown>): boolean {
  // chat 或 rag 为假值（undefined/null/非对象）视为旧格式
  return raw.chat == null || typeof raw.chat !== 'object'
    || raw.rag == null || typeof raw.rag !== 'object'
}

/** 将旧版扁平 AiConfig 迁移为 chat + rag 解耦结构 */
function migrateLegacyAiConfig(raw: Record<string, unknown>): AiConfig {
  const oldProvider = (raw.provider as string) || 'bigmodel'
  const oldApiKey = raw.apiKey as string | undefined
  return {
    chat: {
      provider: (oldProvider as AiChatConfig['provider']),
      endpoint: (raw.endpoint as string) || 'https://open.bigmodel.cn/api/paas/v4',
      model: (raw.model as string) || 'glm-5.1',
      temperature: (raw.temperature as number) ?? 0.7,
      maxTokens: (raw.maxTokens as number) || 131072,
      // 旧格式的 apiKey 同时赋给两个 provider，用户后续可独立修改
      bigmodelApiKey: oldApiKey,
      deepseekApiKey: oldApiKey,
      thinkingEnabled: false,
    },
    rag: {
      enabled: true,
      provider: 'bigmodel',
      endpoint: (raw.endpoint as string) || 'https://open.bigmodel.cn/api/paas/v4',
      embeddingModel: (raw.embeddingModel as string) || 'embedding-3',
      bigmodelApiKey: oldApiKey,
    },
  }
}

/** 检测 chat 子对象是否还使用旧版 apiKey 字段（未拆分为 bigmodelApiKey/deepseekApiKey） */
function isLegacyChatApiKey(chat: Record<string, unknown>): boolean {
  return chat.apiKey !== undefined && chat.bigmodelApiKey === undefined && chat.deepseekApiKey === undefined
}

/** 将 chat 中的旧 apiKey 迁移到 bigmodelApiKey + deepseekApiKey */
function migrateChatApiKey(chat: Record<string, unknown>): Record<string, unknown> {
  const oldKey = chat.apiKey as string | undefined
  const { apiKey: _, ...rest } = chat
  return { ...rest, bigmodelApiKey: oldKey, deepseekApiKey: oldKey }
}

/** 检测 rag 子对象是否还使用旧版 apiKey 字段或缺少 provider */
function isLegacyRagConfig(rag: Record<string, unknown>): boolean {
  return rag.apiKey !== undefined || rag.provider === undefined
}

/** 将 rag 中的旧 apiKey 迁移到 bigmodelApiKey，补充 provider，并移除不支持的 deepseek 配置 */
function migrateRagConfig(rag: Record<string, unknown>): Record<string, unknown> {
  const oldKey = rag.apiKey as string | undefined
  const { apiKey: _, deepseekApiKey: __, ...rest } = rag
  // 如果旧的 provider 是 deepseek（不提供 Embeddings API），重置为 bigmodel 默认值
  const provider = (rag.provider as string) === 'deepseek' ? 'bigmodel' : (rag.provider as string) || 'bigmodel'
  const endpoint = rag.endpoint as string || 'https://open.bigmodel.cn/api/paas/v4'
  const embeddingModel = rag.embeddingModel as string || 'embedding-3'
  return { provider, endpoint, embeddingModel, bigmodelApiKey: oldKey || (rag.bigmodelApiKey as string), ...rest }
}

/** 从 localStorage 读取持久化的 AI 配置，自动兼容旧格式 */
function loadAiConfig(): Partial<AiConfig> {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (isLegacyAiConfig(parsed)) {
      const migrated = migrateLegacyAiConfig(parsed)
      saveAiConfig(migrated)
      return migrated
    }
    // 兼容 chat 子对象中仍使用旧 apiKey 字段的情况
    const result = parsed as unknown as AiConfig
    let needsSave = false
    const chatObj = parsed.chat as Record<string, unknown> | undefined
    if (chatObj && isLegacyChatApiKey(chatObj)) {
      const migratedChat = migrateChatApiKey(chatObj) as unknown as AiChatConfig;
      (result as unknown as Record<string, unknown>).chat = migratedChat
      needsSave = true
    }
    // 兼容 rag 子对象中仍使用旧 apiKey 字段或缺少 provider
    const ragObj = parsed.rag as Record<string, unknown> | undefined
    if (ragObj && isLegacyRagConfig(ragObj)) {
      const migratedRag = migrateRagConfig(ragObj);
      (result as unknown as Record<string, unknown>).rag = migratedRag
      needsSave = true
    }
    if (needsSave) saveAiConfig(result)
    return result
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

/** 将用户偏好写入 localStorage（含外观设置） */
function savePreferences(prefs: Partial<Pick<AppState, 'theme' | 'eyeCareMode' | 'fontFamily' | 'fontSize' | 'gridSize' | 'editorWidth'>>) {
  try {
    // 合并已有偏好，避免覆盖未传入的字段
    const existing = loadPreferences()
    const merged = { ...existing, ...prefs }
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(merged))
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
  fontFamily: 'simhei' | 'simsun' | 'kaiti' | 'yahei'

  // 全局字体大小（px）
  fontSize: number

  // 作品列表网格大小
  gridSize: 'small' | 'medium' | 'large'

  // 编辑器显示宽度
  editorWidth: 'mobile' | 'standard' | 'wide'

  // 应用版本号（从 tauri.conf.json 运行时获取，前端统一使用此值）
  appVersion: string

  // Actions
  setBooks: (books: Book[]) => void
  setCurrentBookId: (id: string | null) => void
  setVolumes: (volumes: Volume[]) => void
  setChapters: (chapters: Chapter[]) => void
  setCurrentChapterId: (id: string | null) => void
  updateChapter: (id: string, patch: Partial<Chapter>) => void
  addChapter: (chapter: Chapter) => void
  removeChapter: (id: string) => void
  reorderVolumes: (orderedIds: string[]) => void
  reorderChapters: (orderedIds: string[]) => void
  moveChapterToVolume: (chapterId: string, volumeId: string | null, sortOrder?: number) => void
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
  setAppVersion: (v: string) => void
  /** 保存当前编辑器状态（作品+章节+光标+滚动位置），下次打开自动恢复 */
  saveCurrentEditorState: (bookId: string, chapterId: string, scrollTop: number, cursorPos: { from: number; to: number } | null) => void
}

const savedPrefs = loadPreferences()
const savedAiConfig = loadAiConfig()
const savedAiConversations = loadAiConversations()

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
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
      chat: {
        provider: 'bigmodel',
        endpoint: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-5.1',
        temperature: 0.7,
        maxTokens: 131072,
        thinkingEnabled: true,
      },
      rag: {
        enabled: true,
        provider: 'bigmodel',
        endpoint: 'https://open.bigmodel.cn/api/paas/v4',
        embeddingModel: 'embedding-3',
      },
      ...savedAiConfig,
    },
    aiConversations: savedAiConversations,
    theme: savedPrefs.theme ?? 'system',
    eyeCareMode: savedPrefs.eyeCareMode ?? 'off',
    fontFamily: savedPrefs.fontFamily ?? 'yahei',
    fontSize: savedPrefs.fontSize ?? 16,
    gridSize: savedPrefs.gridSize ?? 'medium',
    editorWidth: savedPrefs.editorWidth ?? 'standard',
    appVersion: '',

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

    reorderVolumes: (orderedIds) =>
      set((s) => ({
        volumes: s.volumes.map((v) => {
          const idx = orderedIds.indexOf(v.id)
          return idx !== -1 ? { ...v, sortOrder: idx } : v
        }),
      })),

    reorderChapters: (orderedIds) =>
      set((s) => ({
        chapters: s.chapters.map((c) => {
          const idx = orderedIds.indexOf(c.id)
          return idx !== -1 ? { ...c, sortOrder: idx } : c
        }),
      })),

    moveChapterToVolume: (chapterId, volumeId, sortOrder) =>
      set((s) => ({
        chapters: s.chapters.map((c) =>
          c.id === chapterId
            ? { ...c, volumeId: volumeId ?? undefined, sortOrder: sortOrder ?? c.sortOrder }
            : c,
        ),
      })),

    updateBook: (id, patch) =>
      set((s) => ({
        books: s.books.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      })),

    addBook: (book) => set((s) => ({ books: [...s.books, book] })),
    removeBook: (id) => set((s) => ({ books: s.books.filter((b) => b.id !== id) })),

    setAiConfig: (config) =>
      set((s) => {
        // 防御：仅合并实际传入的子配置，避免 undefined 覆盖现有值
        const merged: AiConfig = {
          chat: config.chat ? { ...s.aiConfig.chat, ...config.chat } : s.aiConfig.chat,
          rag: config.rag ? { ...s.aiConfig.rag, ...config.rag } : s.aiConfig.rag,
        }
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
    setAiConnectionStatus: (aiConnectionStatus, aiConnectionDetail = '') =>
      set({ aiConnectionStatus, aiConnectionDetail }),
    setDbStatus: (dbStatus) => set({ dbStatus }),
    setLoadingBooks: (v) => set({ isLoadingBooks: v }),
    setLoadingChapters: (v) => set({ isLoadingChapters: v }),
    setAppVersion: (appVersion) => set({ appVersion }),
    saveCurrentEditorState: (bookId, chapterId, scrollTop, cursorPos) => {
      saveEditorState({ bookId, chapterId, scrollTop, cursorPos })
    },
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
