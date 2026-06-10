import { create } from 'zustand'
import type { Book, Chapter, Volume, AiConfig, AiMessage, AiChatConfig, AiToolCategory, AiToolPrompt, ConversationSummary } from '../types'
import { createStorage } from '../lib/utils'

// ==================== App Store（全局业务状态）====================

/** localStorage 键名，用于持久化 AI 配置 */
const AI_CONFIG_KEY = 'time-write-ai-config'

/** 编辑器状态持久化 */
const editorStateStore = createStorage<Record<string, EditorState>>('time-write-editor-state', {})

/** 用户偏好持久化 */
const preferencesStore = createStorage<Partial<UserPreferences>>('time-write-preferences', {})

/** AI 工具箱分类持久化 */
const AI_TOOL_CATEGORIES_KEY = 'time-write-ai-tool-categories'

/** AI 工具箱预设分类 + 提示词模板 */
const DEFAULT_AI_TOOL_CATEGORIES: AiToolCategory[] = [
  {
    id: 'general',
    name: '常用工具',
    color: 'linear-gradient(180deg, #E0EBFF -5%, #FFF2E7 99.73%)',
    tools: [
      { id: 'chapter-summary', name: '章节总结', description: '分析章节情节走向、人物弧光与伏笔埋设，生成精炼章节摘要', systemPrompt: '' },
      { id: 'outline-generation', name: '小说大纲生成', description: '灵感散乱难起步？AI产出多层级框架、章节骨架与关键节点，快速聚焦', systemPrompt: '' },
      { id: 'chapter-deep-polish', name: '章节深度润色', description: '从文笔、节奏、逻辑三个维度深度优化章节，提升整体质感', systemPrompt: '' },
      { id: 'novel-expand', name: '小说扩写', description: '灵感不够饱满？AI语义理解与风格对齐，延展段落、补足细节与情绪', systemPrompt: '' },
      { id: 'novel-continue', name: '小说续写', description: '把握人物动机与节奏韵律，顺势衔接情节并铺垫钩子，故事不断电', systemPrompt: '' },
      { id: 'novel-polish', name: '小说润色', description: '句子不顺、表达不亮？优化用词、句式与节奏，提升可读性与表现力', systemPrompt: '' },
      { id: 'novel-rewrite', name: '小说改写', description: '想换视角或焕新表达？保留关键信息与情绪张力，重构叙述角度与结构', systemPrompt: '' },
    ],
  },
  {
    id: 'plot-design',
    name: '剧情设计',
    color: 'linear-gradient(180deg, #FFE6F4 -1.2%, #F4FDFF 93.1%)',
    tools: [
      { id: 'main-plot-setting', name: '主线剧情设定', description: '梳理目标、冲突与阶段里程碑，搭建推进路径与节奏框架，全局可控', systemPrompt: '' },
      { id: 'subplot-decomposition', name: '支线剧情分解', description: '拆出人物线与任务线，明确起承转合与回扣点，支线服务主线、节奏更丰盈', systemPrompt: '' },
      { id: 'plot-twist', name: '剧情反转设定', description: '围绕人物动机与线索布置，推演合理性与前置铺垫，张力升级而不突兀', systemPrompt: '' },
      { id: 'core-conflict', name: '核心冲突生成器', description: '产出目标/价值/资源三维冲突，AI推演升级路径与代价，一键出冲突', systemPrompt: '' },
      { id: 'chapter-detailed-outline', name: '章节细纲生成', description: '细化场景目标、冲突与悬念铺陈，标注视角与镜头顺序，高效落稿', systemPrompt: '' },
      { id: 'system-setting', name: '系统设定生成器', description: '构建系统面板、规则与升级路径，平衡成长节奏与爽点控制', systemPrompt: '' },
    ],
  },
  {
    id: 'description',
    name: '描写辅助',
    color: 'linear-gradient(180deg, #E1F8FF 0%, #CEE7EE 69.22%)',
    tools: [
      { id: 'fight-description', name: '打斗描写', description: '依据人物境界与招式生成对招节奏和场景细节，分镜化刻画肢体与术法碰撞', systemPrompt: '' },
      { id: 'detail-description', name: '细节描写', description: '从"物—人—场"精确展开，捕捉触感、声光、气味与微动作，质感倍增', systemPrompt: '' },
      { id: 'sense-description', name: '感官描写', description: '联动视/听/嗅/味/触多通道生成表达，匹配心理回响，沉浸感拉满', systemPrompt: '' },
      { id: 'appearance-description', name: '外貌描写', description: '从五官、体态到穿搭色彩逐项生成，结合年龄与角色定位选择用词与比喻', systemPrompt: '' },
      { id: 'emotion-description', name: '情感描写', description: '刻画人物内心情绪波动，捕捉微妙心理变化与外显行为', systemPrompt: '' },
      { id: 'environment-description', name: '环境/场景描写', description: '生成富有画面感的环境与场景描述，营造氛围与空间感', systemPrompt: '' },
    ],
  },
  {
    id: 'world-building',
    name: '世界设定',
    color: 'linear-gradient(174deg, #CAEAF2 4.65%, #D5ECF4 95.23%)',
    tools: [
      { id: 'world-architecture', name: '世界架构设定', description: '搭建世界观底盘：地理、历史、文化、种族与力量体系，结构明晰可拓展', systemPrompt: '' },
      { id: 'character-setting', name: '人物设定', description: '生成身份背景、性格标签、目标缺陷与成长线，构建关系网与冲突来源', systemPrompt: '' },
      { id: 'faction-structure', name: '势力组织架构', description: '为宗门/朝廷/联盟搭建层级与职位，推演资源、职责与权力关系', systemPrompt: '' },
      { id: 'cultivation-system', name: '境界/功法等级', description: '搭建修行体系与功法品阶，推演突破门槛、瓶颈与加成', systemPrompt: '' },
      { id: 'item-setting', name: '物品设定', description: '生成法宝、丹药、装备等物品的来历、属性与使用规则', systemPrompt: '' },
    ],
  },
  {
    id: 'naming',
    name: '取名神器',
    color: 'linear-gradient(180deg, #E0DFDB 0%, #E0DFDB 100%)',
    tools: [
      { id: 'character-naming', name: '人物名字定制', description: '按性格/阵营/地域定制姓名，评估音律与象征，附昵称/字号', systemPrompt: '' },
      { id: 'novel-naming', name: '小说书名', description: '基于题材卖点生成多风格标题，控信息量与爆点词，附副题备选', systemPrompt: '' },
      { id: 'ancient-naming', name: '古风姓名', description: '按朝代语感与字库组合姓名，把控避讳、字形搭配与诗词来源', systemPrompt: '' },
      { id: 'faction-naming', name: '门派势力名称', description: '依据功法流派与地理风土生成独特门号，同步给出口号与象征物', systemPrompt: '' },
      { id: 'place-naming', name: '地点场景取名', description: '按地理/文化/语言生成地名，配别称与氛围描写', systemPrompt: '' },
    ],
  },
]

function loadAiToolCategories(): AiToolCategory[] {
  try {
    const raw = localStorage.getItem(AI_TOOL_CATEGORIES_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
    // 尝试从旧版 aiToolPrompts 迁移
    const oldRaw = localStorage.getItem('time-write-ai-tool-prompts')
    if (oldRaw) {
      const oldPrompts = JSON.parse(oldRaw)
      if (Array.isArray(oldPrompts) && oldPrompts.length > 0) {
        const migrated: AiToolCategory = {
          id: 'migrated',
          name: '自定义',
          color: 'linear-gradient(180deg, #E0EBFF -5%, #FFF2E7 99.73%)',
          tools: oldPrompts.map((p: Record<string, unknown>) => ({
            id: (p.id as string) || crypto.randomUUID(),
            name: (p.name as string) || '未命名',
            description: (p.description as string) || '',
            systemPrompt: (p.systemPrompt as string) || '',
          })),
        }
        saveAiToolCategories([migrated, ...DEFAULT_AI_TOOL_CATEGORIES])
        // 删除旧数据
        localStorage.removeItem('time-write-ai-tool-prompts')
        return [migrated, ...DEFAULT_AI_TOOL_CATEGORIES]
      }
    }
    return DEFAULT_AI_TOOL_CATEGORIES
  } catch {
    return DEFAULT_AI_TOOL_CATEGORIES
  }
}

function saveAiToolCategories(categories: AiToolCategory[]) {
  try {
    localStorage.setItem(AI_TOOL_CATEGORIES_KEY, JSON.stringify(categories))
  } catch { /* ignore */ }
}

/** AI 对话记录持久化 */
const aiConversationsStore = createStorage<Record<string, AiMessage[]>>('time-write-ai-conversations', {})

/** AI 对话历史摘要持久化（按 bookId 分组，滑动窗口溢出后的压缩上下文） */
const aiSummariesStore = createStorage<Record<string, ConversationSummary>>('time-write-ai-summaries', {})

/** 用户偏好类型 */
export type UserPreferences = {
  theme: 'light' | 'dark' | 'system'
  eyeCareMode: 'off' | 'warm' | 'green'
  fontFamily: 'simhei' | 'simsun' | 'kaiti' | 'yahei'
  fontSize: number
  gridSize: 'small' | 'medium' | 'large'
  editorWidth: 'mobile' | 'standard' | 'wide'
  /** 书库视图模式 */
  libraryViewMode: 'grid' | 'list'
  /** 书库排序方式 */
  librarySortBy: 'updatedAt' | 'createdAt' | 'title' | 'wordCount'
}

/** 编辑器恢复状态（记录用户上次编辑的作品、章节和光标位置） */
export interface EditorState {
  bookId: string
  chapterId: string
  scrollTop: number
  cursorPos: { from: number; to: number } | null
}

/** 保存指定作品的编辑器状态到 localStorage */
function saveEditorState(state: EditorState) {
  const all = editorStateStore.load()
  all[state.bookId] = state
  editorStateStore.save(all)
}

/** 获取指定作品上次的编辑器状态 */
export function getEditorState(bookId: string): EditorState | null {
  const all = editorStateStore.load()
  return all[bookId] ?? null
}

/** 将用户偏好写入 localStorage（含外观设置） */
function savePreferences(prefs: Partial<UserPreferences>) {
  const existing = preferencesStore.load()
  preferencesStore.save({ ...existing, ...prefs })
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
        contextWindowSize: 10,
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
    if (chatObj) {
      if (isLegacyChatApiKey(chatObj)) {
        const migratedChat = migrateChatApiKey(chatObj) as unknown as AiChatConfig;
        (result as unknown as Record<string, unknown>).chat = migratedChat
        needsSave = true
      }
      // 兼容缺少 contextWindowSize 的旧配置（使用 result.chat 防止覆盖上方迁移结果）
      const currentChat = (result as unknown as Record<string, unknown>).chat as Record<string, unknown>
      if (currentChat && currentChat.contextWindowSize === undefined) {
        currentChat.contextWindowSize = 10
        needsSave = true
      }
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

/** 将 AI 配置写入 localStorage */
function saveAiConfig(config: AiConfig) {
  try {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config))
  } catch { /* ignore */ }
}

/** 将 AI 对话记录写入 localStorage */
function saveAiConversations(conversations: Record<string, AiMessage[]>) {
  aiConversationsStore.save(conversations)
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

  // AI 对话历史摘要（按 bookId 分组，滑动窗口溢出后的压缩上下文）
  aiSummaries: Record<string, ConversationSummary>

  // AI 工具箱分类列表
  aiToolCategories: AiToolCategory[]

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

  // 书库页面缓存状态
  libraryViewMode: 'grid' | 'list'
  librarySortBy: 'updatedAt' | 'createdAt' | 'title' | 'wordCount'

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
  /** 回收站中作品数量 */
  trashCount: number
  setTrashCount: (count: number) => void
  setAiConfig: (config: Partial<AiConfig>) => void
  // AI 对话管理
  addAiMessage: (bookId: string, message: AiMessage) => void
  updateAiMessage: (bookId: string, messageId: string, patch: Partial<AiMessage>) => void
  deleteAiMessage: (bookId: string, messageId: string) => void
  setAiMessages: (bookId: string, messages: AiMessage[]) => void
  clearAiConversation: (bookId: string) => void
  persistAiConversation: (bookId: string) => void
  setConversationSummary: (bookId: string, summary: ConversationSummary) => void
  clearConversationSummary: (bookId: string) => void
  // AI 工具箱
  setAiToolCategories: (categories: AiToolCategory[]) => void
  addAiToolCategory: (category: AiToolCategory) => void
  updateAiToolCategory: (categoryId: string, patch: Partial<AiToolCategory>) => void
  deleteAiToolCategory: (categoryId: string) => void
  addAiToolPrompt: (categoryId: string, prompt: AiToolPrompt) => void
  updateAiToolPrompt: (categoryId: string, promptId: string, patch: Partial<AiToolPrompt>) => void
  deleteAiToolPrompt: (categoryId: string, promptId: string) => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setEyeCareMode: (mode: 'off' | 'warm' | 'green') => void
  setFontFamily: (font: AppState['fontFamily']) => void
  setFontSize: (size: number) => void
  setGridSize: (gridSize: AppState['gridSize']) => void
  setEditorWidth: (editorWidth: AppState['editorWidth']) => void
  setLibraryViewMode: (mode: AppState['libraryViewMode']) => void
  setLibrarySortBy: (sortBy: AppState['librarySortBy']) => void
  setAiConnectionStatus: (status: AppState['aiConnectionStatus'], detail?: string) => void
  setDbStatus: (status: AppState['dbStatus']) => void
  setLoadingBooks: (v: boolean) => void
  setLoadingChapters: (v: boolean) => void
  setAppVersion: (v: string) => void
  /** 保存当前编辑器状态（作品+章节+光标+滚动位置），下次打开自动恢复 */
  saveCurrentEditorState: (bookId: string, chapterId: string, scrollTop: number, cursorPos: { from: number; to: number } | null) => void
}

const savedPrefs = preferencesStore.load()
const savedAiConfig = loadAiConfig()
const savedAiConversations = aiConversationsStore.load()
const savedAiSummaries = aiSummariesStore.load()


export const useAppStore = create<AppState>()((set) => ({
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
        contextWindowSize: 10,
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
    aiSummaries: savedAiSummaries,
    aiToolCategories: loadAiToolCategories(),
    theme: savedPrefs.theme ?? 'system',
    eyeCareMode: savedPrefs.eyeCareMode ?? 'off',
    fontFamily: savedPrefs.fontFamily ?? 'yahei',
    fontSize: savedPrefs.fontSize ?? 16,
    gridSize: savedPrefs.gridSize ?? 'medium',
    editorWidth: savedPrefs.editorWidth ?? 'standard',
    libraryViewMode: savedPrefs.libraryViewMode ?? 'grid',
    librarySortBy: savedPrefs.librarySortBy ?? 'updatedAt',
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
    trashCount: 0,
    setTrashCount: (trashCount) => set({ trashCount }),

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

    // AI 工具箱分类管理
    setAiToolCategories: (categories) => {
      saveAiToolCategories(categories)
      set({ aiToolCategories: categories })
    },
    addAiToolCategory: (category) =>
      set((s) => {
        const categories = [...s.aiToolCategories, category]
        saveAiToolCategories(categories)
        return { aiToolCategories: categories }
      }),
    updateAiToolCategory: (categoryId, patch) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId ? { ...c, ...patch } : c,
        )
        saveAiToolCategories(categories)
        return { aiToolCategories: categories }
      }),
    deleteAiToolCategory: (categoryId) =>
      set((s) => {
        const categories = s.aiToolCategories.filter((c) => c.id !== categoryId)
        saveAiToolCategories(categories)
        return { aiToolCategories: categories }
      }),
    addAiToolPrompt: (categoryId, prompt) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId ? { ...c, tools: [...c.tools, prompt] } : c,
        )
        saveAiToolCategories(categories)
        return { aiToolCategories: categories }
      }),
    updateAiToolPrompt: (categoryId, promptId, patch) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId
            ? { ...c, tools: c.tools.map((p) => (p.id === promptId ? { ...p, ...patch } : p)) }
            : c,
        )
        saveAiToolCategories(categories)
        return { aiToolCategories: categories }
      }),
    deleteAiToolPrompt: (categoryId, promptId) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId ? { ...c, tools: c.tools.filter((p) => p.id !== promptId) } : c,
        )
        saveAiToolCategories(categories)
        return { aiToolCategories: categories }
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

    deleteAiMessage: (bookId, messageId) =>
      set((s) => {
        const msgs = s.aiConversations[bookId]
        if (!msgs) return s
        const idx = msgs.findIndex((m) => m.id === messageId)
        if (idx === -1) return s
        const target = msgs[idx]
        // 删除助手消息时，同步删除其前面的用户提问
        if (target.role === 'assistant') {
          const prevIdx = idx - 1
          const toRemove = new Set([idx])
          if (prevIdx >= 0 && msgs[prevIdx].role === 'user') {
            toRemove.add(prevIdx)
          }
          const filtered = msgs.filter((_, i) => !toRemove.has(i))
          const conversations = { ...s.aiConversations, [bookId]: filtered }
          saveAiConversations(conversations)
          return { aiConversations: conversations }
        }
        // 删除用户消息时，同步删除其后面的助手回答
        if (target.role === 'user') {
          const nextIdx = idx + 1
          const toRemove = new Set([idx])
          if (nextIdx < msgs.length && msgs[nextIdx].role === 'assistant') {
            toRemove.add(nextIdx)
          }
          const filtered = msgs.filter((_, i) => !toRemove.has(i))
          const conversations = { ...s.aiConversations, [bookId]: filtered }
          saveAiConversations(conversations)
          return { aiConversations: conversations }
        }
        return s
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
        // 同步清除对话摘要
        const summaries = { ...s.aiSummaries }
        delete summaries[bookId]
        aiSummariesStore.save(summaries)
        return { aiConversations: conversations, aiSummaries: summaries }
      }),

    setConversationSummary: (bookId, summary) =>
      set((s) => {
        const summaries = { ...s.aiSummaries, [bookId]: summary }
        aiSummariesStore.save(summaries)
        return { aiSummaries: summaries }
      }),

    clearConversationSummary: (bookId) =>
      set((s) => {
        const summaries = { ...s.aiSummaries }
        delete summaries[bookId]
        aiSummariesStore.save(summaries)
        return { aiSummaries: summaries }
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
    setLibraryViewMode: (libraryViewMode) => {
      savePreferences({ libraryViewMode })
      set({ libraryViewMode })
    },
    setLibrarySortBy: (librarySortBy) => {
      savePreferences({ librarySortBy })
      set({ librarySortBy })
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
