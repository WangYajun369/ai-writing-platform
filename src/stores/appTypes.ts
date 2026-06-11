/**
 * AppStore 类型定义、常量与 localStorage 工具函数
 */
import type { Book, Chapter, Volume, AiConfig, AiMessage, AiChatConfig, AiToolCategory, AiToolPrompt, ConversationSummary } from '../types'
import { createStorage } from '../lib/utils'
import type { StateCreator } from 'zustand'

// ==================== AI 工具箱预设常量 ====================

export const AI_CONFIG_KEY = 'time-write-ai-config'
export const AI_TOOL_CATEGORIES_KEY = 'time-write-ai-tool-categories'

export const DEFAULT_AI_TOOL_CATEGORIES: AiToolCategory[] = [
  {
    id: 'general', name: '常用工具',
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
    id: 'plot-design', name: '剧情设计',
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
    id: 'description', name: '描写辅助',
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
    id: 'world-building', name: '世界设定',
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
    id: 'naming', name: '取名神器',
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

// ==================== localStorage 存储实例 ====================

export const editorStateStore = createStorage<Record<string, EditorState>>('time-write-editor-state', {})
export const preferencesStore = createStorage<Partial<UserPreferences>>('time-write-preferences', {})
export const aiConversationsStore = createStorage<Record<string, AiMessage[]>>('time-write-ai-conversations', {})
export const aiSummariesStore = createStorage<Record<string, ConversationSummary>>('time-write-ai-summaries', {})

// ==================== 类型定义 ====================

export type UserPreferences = {
  theme: 'light' | 'dark' | 'system'
  eyeCareMode: 'off' | 'warm' | 'green'
  fontFamily: 'simhei' | 'simsun' | 'kaiti' | 'yahei'
  fontSize: number
  gridSize: 'small' | 'medium' | 'large'
  editorWidth: 'mobile' | 'standard' | 'wide'
  libraryViewMode: 'grid' | 'list'
  librarySortBy: 'updatedAt' | 'createdAt' | 'title' | 'wordCount'
}

export interface EditorState {
  bookId: string
  chapterId: string
  scrollTop: number
  cursorPos: { from: number; to: number } | null
}

export interface AppState {
  books: Book[]
  currentBookId: string | null
  isLoadingBooks: boolean
  volumes: Volume[]
  chapters: Chapter[]
  currentChapterId: string | null
  isLoadingChapters: boolean
  dbStatus: 'idle' | 'connected' | 'error'
  aiConnectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  aiConnectionDetail: string
  aiConfig: AiConfig
  aiConversations: Record<string, AiMessage[]>
  aiSummaries: Record<string, ConversationSummary>
  aiToolCategories: AiToolCategory[]
  theme: 'light' | 'dark' | 'system'
  eyeCareMode: 'off' | 'warm' | 'green'
  fontFamily: 'simhei' | 'simsun' | 'kaiti' | 'yahei'
  fontSize: number
  gridSize: 'small' | 'medium' | 'large'
  editorWidth: 'mobile' | 'standard' | 'wide'
  libraryViewMode: 'grid' | 'list'
  librarySortBy: 'updatedAt' | 'createdAt' | 'title' | 'wordCount'
  appVersion: string
  trashCount: number
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
  setTrashCount: (count: number) => void
  setAiConfig: (config: Partial<AiConfig>) => void
  addAiMessage: (bookId: string, message: AiMessage) => void
  updateAiMessage: (bookId: string, messageId: string, patch: Partial<AiMessage>) => void
  deleteAiMessage: (bookId: string, messageId: string) => void
  setAiMessages: (bookId: string, messages: AiMessage[]) => void
  clearAiConversation: (bookId: string) => void
  persistAiConversation: (bookId: string) => void
  setConversationSummary: (bookId: string, summary: ConversationSummary) => void
  clearConversationSummary: (bookId: string) => void
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
  saveCurrentEditorState: (bookId: string, chapterId: string, scrollTop: number, cursorPos: { from: number; to: number } | null) => void
}

/** Zustand slice 创建器 —— 允许返回 Partial<AppState> */
export type AppSlice = StateCreator<AppState, [], [], Partial<AppState>>

// ==================== AI 工具分类持久化 ====================

export function loadAiToolCategories(): AiToolCategory[] {
  try {
    const raw = localStorage.getItem(AI_TOOL_CATEGORIES_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
    const oldRaw = localStorage.getItem('time-write-ai-tool-prompts')
    if (oldRaw) {
      const oldPrompts = JSON.parse(oldRaw)
      if (Array.isArray(oldPrompts) && oldPrompts.length > 0) {
        const migrated: AiToolCategory = {
          id: 'migrated', name: '自定义',
          color: 'linear-gradient(180deg, #E0EBFF -5%, #FFF2E7 99.73%)',
          tools: oldPrompts.map((p: Record<string, unknown>) => ({
            id: (p.id as string) || crypto.randomUUID(),
            name: (p.name as string) || '未命名',
            description: (p.description as string) || '',
            systemPrompt: (p.systemPrompt as string) || '',
          })),
        }
        saveAiToolCategories([migrated, ...DEFAULT_AI_TOOL_CATEGORIES])
        localStorage.removeItem('time-write-ai-tool-prompts')
        return [migrated, ...DEFAULT_AI_TOOL_CATEGORIES]
      }
    }
    return DEFAULT_AI_TOOL_CATEGORIES
  } catch {
    return DEFAULT_AI_TOOL_CATEGORIES
  }
}

export function saveAiToolCategories(categories: AiToolCategory[]) {
  try { localStorage.setItem(AI_TOOL_CATEGORIES_KEY, JSON.stringify(categories)) } catch { /* ignore */ }
}

// ==================== 编辑器状态持久化 ====================

export function saveEditorState(state: EditorState) {
  const all = editorStateStore.load()
  all[state.bookId] = state
  editorStateStore.save(all)
}

export function getEditorState(bookId: string): EditorState | null {
  const all = editorStateStore.load()
  return all[bookId] ?? null
}

export function savePreferences(prefs: Partial<UserPreferences>) {
  const existing = preferencesStore.load()
  preferencesStore.save({ ...existing, ...prefs })
}

// ==================== AI 配置迁移 ====================

export function isLegacyAiConfig(raw: Record<string, unknown>): boolean {
  return raw.chat == null || typeof raw.chat !== 'object'
    || raw.rag == null || typeof raw.rag !== 'object'
}

export function migrateLegacyAiConfig(raw: Record<string, unknown>): AiConfig {
  const oldProvider = (raw.provider as string) || 'bigmodel'
  const oldApiKey = raw.apiKey as string | undefined
  return {
    chat: {
      provider: (oldProvider as AiChatConfig['provider']),
      endpoint: (raw.endpoint as string) || 'https://open.bigmodel.cn/api/paas/v4',
      model: (raw.model as string) || 'glm-5.1',
      temperature: (raw.temperature as number) ?? 0.7,
      maxTokens: (raw.maxTokens as number) || 131072,
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

export function isLegacyChatApiKey(chat: Record<string, unknown>): boolean {
  return chat.apiKey !== undefined && chat.bigmodelApiKey === undefined && chat.deepseekApiKey === undefined
}

export function migrateChatApiKey(chat: Record<string, unknown>): Record<string, unknown> {
  const oldKey = chat.apiKey as string | undefined
  const { apiKey: _, ...rest } = chat
  return { ...rest, bigmodelApiKey: oldKey, deepseekApiKey: oldKey }
}

export function isLegacyRagConfig(rag: Record<string, unknown>): boolean {
  return rag.apiKey !== undefined || rag.provider === undefined
}

export function migrateRagConfig(rag: Record<string, unknown>): Record<string, unknown> {
  const oldKey = rag.apiKey as string | undefined
  const { apiKey: _, deepseekApiKey: __, ...rest } = rag
  const provider = (rag.provider as string) === 'deepseek' ? 'bigmodel' : (rag.provider as string) || 'bigmodel'
  const endpoint = rag.endpoint as string || 'https://open.bigmodel.cn/api/paas/v4'
  const embeddingModel = rag.embeddingModel as string || 'embedding-3'
  return { provider, endpoint, embeddingModel, bigmodelApiKey: oldKey || (rag.bigmodelApiKey as string), ...rest }
}

export function loadAiConfig(): Partial<AiConfig> {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (isLegacyAiConfig(parsed)) {
      const migrated = migrateLegacyAiConfig(parsed)
      saveAiConfig(migrated)
      return migrated
    }
    const result = parsed as unknown as AiConfig
    let needsSave = false
    const chatObj = parsed.chat as Record<string, unknown> | undefined
    if (chatObj) {
      if (isLegacyChatApiKey(chatObj)) {
        const migratedChat = migrateChatApiKey(chatObj) as unknown as AiChatConfig;
        (result as unknown as Record<string, unknown>).chat = migratedChat
        needsSave = true
      }
      const currentChat = (result as unknown as Record<string, unknown>).chat as Record<string, unknown>
      if (currentChat && currentChat.contextWindowSize === undefined) {
        currentChat.contextWindowSize = 10
        needsSave = true
      }
    }
    const ragObj = parsed.rag as Record<string, unknown> | undefined
    if (ragObj && isLegacyRagConfig(ragObj)) {
      const migratedRag = migrateRagConfig(ragObj);
      (result as unknown as Record<string, unknown>).rag = migratedRag
      needsSave = true
    }
    if (needsSave) saveAiConfig(result)
    return result
  } catch { return {} }
}

export function saveAiConfig(config: AiConfig) {
  try { localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config)) } catch { /* ignore */ }
}

export function saveAiConversations(conversations: Record<string, AiMessage[]>) {
  aiConversationsStore.save(conversations)
}
