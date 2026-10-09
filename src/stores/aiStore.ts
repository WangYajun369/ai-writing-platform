/**
 * aiStore — AI 领域独立 store（AI 配置/对话记录/工具箱分类/连接状态/应用版本）
 *
 * v1.9 架构优化:AI 配置与工具箱分类的持久化层从 localStorage 迁移到后端
 * 统一 config 模块(configClient.ai / configClient.aiToolCategories)。
 *
 * 启动流程:
 * 1. store 初始化用默认配置(同步,首帧不阻塞)
 * 2. AppInit 调用 `initFromConfig()` 从后端拉取真实 aiConfig + aiToolCategories
 * 3. 各 setter 同步更新内存 + 异步写后端
 *
 * 仍保留 localStorage 的:
 * - aiConversations / aiSummaries(按书增长,属运行时状态)
 * - 防抖持久化策略(流式期间避免写放大)
 */
import { create } from 'zustand'
import type { AiConfig, AiMessage, ConversationSummary, AiToolCategory } from '../types'
import {
  aiConversationsStore, aiSummariesStore,
  saveAiConversations,
} from './appTypes'
import { configClient } from '@/lib/configClient'
import { DEFAULT_AI_TOOL_CATEGORIES } from './appTypes'

/** AI 配置默认值(与后端 `defaults::default_ai_config` 对齐) */
export const defaultAiConfig: AiConfig = {
  chat: {
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    maxTokens: 131072,
    thinkingEnabled: true,
    contextWindowSize: 10,
  },
  rag: {
    provider: 'bigmodel',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    embeddingModel: 'embedding-3',
  },
}

export interface AiState {
  aiConnectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  aiConnectionDetail: string
  aiConversations: Record<string, AiMessage[]>
  aiSummaries: Record<string, ConversationSummary>
  aiToolCategories: AiToolCategory[]
  appVersion: string
  aiConfig: AiConfig

  /** 从后端 config 模块加载 aiConfig + aiToolCategories(AppInit 调用) */
  initFromConfig: () => Promise<void>
  setAiConfig: (config: Partial<AiConfig>) => void

  // —— AI 对话管理 ——
  addAiMessage: (bookId: string, message: AiMessage) => void
  updateAiMessage: (bookId: string, messageId: string, patch: Partial<AiMessage>) => void
  deleteAiMessage: (bookId: string, messageId: string) => void
  setAiMessages: (bookId: string, messages: AiMessage[]) => void
  clearAiConversation: (bookId: string) => void
  persistAiConversation: (bookId: string) => void
  setConversationSummary: (bookId: string, summary: ConversationSummary) => void
  clearConversationSummary: (bookId: string) => void

  // —— AI 工具箱分类管理 ——
  setAiToolCategories: (categories: AiToolCategory[]) => void
  addAiToolCategory: (category: AiToolCategory) => void
  updateAiToolCategory: (categoryId: string, patch: Partial<AiToolCategory>) => void
  deleteAiToolCategory: (categoryId: string) => void
  addAiToolPrompt: (categoryId: string, prompt: AiToolCategory['tools'][number]) => void
  updateAiToolPrompt: (categoryId: string, promptId: string, patch: Partial<AiToolCategory['tools'][number]>) => void
  deleteAiToolPrompt: (categoryId: string, promptId: string) => void

  setAiConnectionStatus: (status: AiState['aiConnectionStatus'], detail?: string) => void
  setAppVersion: (appVersion: string) => void
}

/** 把 aiConfig 异步写后端(失败静默) */
function persistAiConfigToBackend(config: AiConfig): void {
  void configClient.ai.set(config).catch(() => {
    /* ignore */
  })
}

/** 把 aiToolCategories 异步写后端(失败静默) */
function persistAiToolCategoriesToBackend(categories: AiToolCategory[]): void {
  void configClient.aiToolCategories.set(categories).catch(() => {
    /* ignore */
  })
}

export const useAiStore = create<AiState>()((set, get) => {
  const savedAiConversations = aiConversationsStore.load()
  const savedAiSummaries = aiSummariesStore.load()

  return {
    aiConnectionStatus: 'idle',
    aiConnectionDetail: '',
    aiConversations: savedAiConversations,
    aiSummaries: savedAiSummaries,
    aiToolCategories: DEFAULT_AI_TOOL_CATEGORIES,
    appVersion: '',
    aiConfig: defaultAiConfig,

    initFromConfig: async () => {
      try {
        const remoteConfig = await configClient.ai.get()
        // 浅合并:后端返回的字段覆盖默认值,缺失字段保留默认
        set({
          aiConfig: {
            chat: { ...defaultAiConfig.chat, ...remoteConfig.chat },
            rag: { ...defaultAiConfig.rag, ...remoteConfig.rag },
          },
        })
      } catch {
        /* 后端读取失败,保持默认值 */
      }
      try {
        const remoteCats = await configClient.aiToolCategories.get()
        // 只校验「是数组」，不再要求 length > 0。
        // 后端对数组段是「有持久化记录则整体替换默认值」（config/commands.rs:49-51），
        // 因此 [] 是用户主动删空分类的真实状态；旧写法会把删空的分类在重启后「复活」。
        // 无持久化记录时后端返回内置默认分类（29 个工具），不会走到这里。
        if (Array.isArray(remoteCats)) {
          set({ aiToolCategories: remoteCats })
        }
      } catch {
        /* 后端读取失败,保持默认值 */
      }
    },

    setAiConfig: (config) =>
      set((s) => {
        const merged: AiConfig = {
          chat: config.chat ? { ...s.aiConfig.chat, ...config.chat } : s.aiConfig.chat,
          rag: config.rag ? { ...s.aiConfig.rag, ...config.rag } : s.aiConfig.rag,
        }
        persistAiConfigToBackend(merged)
        return { aiConfig: merged }
      }),

    // —— AI 对话管理 ——
    // 写入先在内存即时生效，持久化统一走 800ms 防抖合并（Phase 4 问题 4：
    // 避免流式期间逐条全量 JSON.stringify 造成写放大）；用户显式删除/清空、
    // 流结束（persistAiConversation）与页面卸载时机则立即落盘。
    addAiMessage: (bookId, message) => {
      set((s) => ({
        aiConversations: {
          ...s.aiConversations,
          [bookId]: [...(s.aiConversations[bookId] ?? []), message],
        },
      }))
      scheduleAiConversationPersist()
    },

    updateAiMessage: (bookId, messageId, patch) =>
      set((s) => {
        const msgs = s.aiConversations[bookId]
        if (!msgs) return s
        // 过滤掉 patch 中值为 undefined 的 key
        const cleanPatch: Record<string, unknown> = {}
        for (const key of Object.keys(patch)) {
          const val = (patch as Record<string, unknown>)[key]
          if (val !== undefined) cleanPatch[key] = val
        }
        const conversations = {
          ...s.aiConversations,
          [bookId]: msgs.map((m) => (m.id === messageId ? { ...m, ...cleanPatch } as AiMessage : m)),
        }
        return { aiConversations: conversations }
      }),

    deleteAiMessage: (bookId, messageId) => {
      const msgs = get().aiConversations[bookId]
      if (!msgs) return
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx === -1) return
      const target = msgs[idx]
      let filtered: AiMessage[] | null = null
      // 成对删除：对话以 user→assistant 交替出现，删助手消息时连带删除它前面的
      // 提问，删用户消息时连带删除紧随其后的回复，避免留下悬空的一轮对话。
      if (target.role === 'assistant') {
        const prevIdx = idx - 1
        const toRemove = new Set([idx])
        if (prevIdx >= 0 && msgs[prevIdx].role === 'user') toRemove.add(prevIdx)
        filtered = msgs.filter((_, i) => !toRemove.has(i))
      } else if (target.role === 'user') {
        const nextIdx = idx + 1
        const toRemove = new Set([idx])
        if (nextIdx < msgs.length && msgs[nextIdx].role === 'assistant') toRemove.add(nextIdx)
        filtered = msgs.filter((_, i) => !toRemove.has(i))
      }
      if (!filtered) return
      set({ aiConversations: { ...get().aiConversations, [bookId]: filtered } })
      flushAiConversations()
    },

    setAiMessages: (bookId, messages) => {
      set({ aiConversations: { ...get().aiConversations, [bookId]: messages } })
      flushAiConversations()
    },

    clearAiConversation: (bookId) => {
      const conversations = { ...get().aiConversations }
      delete conversations[bookId]
      const summaries = { ...get().aiSummaries }
      delete summaries[bookId]
      set({ aiConversations: conversations, aiSummaries: summaries })
      aiSummariesStore.save(summaries)
      flushAiConversations()
    },

    persistAiConversation: () => {
      flushAiConversations()
    },

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

    // —— AI 工具箱分类管理 ——
    // 写入策略：结构性变更（新增/删除分类或工具、整段替换）立即落盘，保证用户操作
    // 不丢；文本编辑（重命名 / System Prompt）走 500ms 防抖，避免逐键全量
    // JSON.stringify(29+ 工具) + IPC 造成写放大。
    setAiToolCategories: (categories) => {
      set({ aiToolCategories: categories })
      // 必须先覆盖待写快照再 flush，否则会把上一次未触发的防抖旧值写回后端
      setAiToolCategoriesPersist(categories)
    },
    addAiToolCategory: (category) =>
      set((s) => {
        const categories = [...s.aiToolCategories, category]
        setAiToolCategoriesPersist(categories)
        return { aiToolCategories: categories }
      }),
    updateAiToolCategory: (categoryId, patch) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId ? { ...c, ...patch } : c,
        )
        scheduleAiToolCategoriesPersist(categories)
        return { aiToolCategories: categories }
      }),
    deleteAiToolCategory: (categoryId) =>
      set((s) => {
        const categories = s.aiToolCategories.filter((c) => c.id !== categoryId)
        setAiToolCategoriesPersist(categories)
        return { aiToolCategories: categories }
      }),
    addAiToolPrompt: (categoryId, prompt) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId ? { ...c, tools: [...c.tools, prompt] } : c,
        )
        setAiToolCategoriesPersist(categories)
        return { aiToolCategories: categories }
      }),
    updateAiToolPrompt: (categoryId, promptId, patch) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId
            ? { ...c, tools: c.tools.map((p) => (p.id === promptId ? { ...p, ...patch } : p)) }
            : c,
        )
        scheduleAiToolCategoriesPersist(categories)
        return { aiToolCategories: categories }
      }),
    deleteAiToolPrompt: (categoryId, promptId) =>
      set((s) => {
        const categories = s.aiToolCategories.map((c) =>
          c.id === categoryId ? { ...c, tools: c.tools.filter((p) => p.id !== promptId) } : c,
        )
        setAiToolCategoriesPersist(categories)
        return { aiToolCategories: categories }
      }),

    setAiConnectionStatus: (aiConnectionStatus, aiConnectionDetail = '') =>
      set({ aiConnectionStatus, aiConnectionDetail }),
    setAppVersion: (appVersion) => set({ appVersion }),
  }
})

// ============================================================================
// AI 工具箱分类持久化调度
// ============================================================================
// 设置页的分类名 / 工具名 / 工具描述 / System Prompt 均为 onChange 直连 store，
// 每次按键都会全量序列化整个分类树。结构性操作（增删）要求即时可靠，文本编辑
// 只需最终一致，故分成「立即写」与「防抖写」两条路径。
const AI_TOOL_CATEGORIES_DEBOUNCE_MS = 500
let aiToolCategoriesPersistTimer: ReturnType<typeof setTimeout> | null = null
/** 防抖窗口内待落盘的最新快照（避免闭包捕获旧值） */
let pendingAiToolCategories: AiToolCategory[] | null = null

/** 立即把当前内存分类写后端（结构性变更与卸载兜底调用） */
export function flushAiToolCategories(): void {
  if (aiToolCategoriesPersistTimer !== null) {
    clearTimeout(aiToolCategoriesPersistTimer)
    aiToolCategoriesPersistTimer = null
  }
  const categories = pendingAiToolCategories ?? useAiStore.getState().aiToolCategories
  pendingAiToolCategories = null
  persistAiToolCategoriesToBackend(categories)
}

/** 防抖调度一次分类持久化（文本编辑场景，连续输入只落一次盘） */
function scheduleAiToolCategoriesPersist(categories: AiToolCategory[]): void {
  pendingAiToolCategories = categories
  if (aiToolCategoriesPersistTimer !== null) clearTimeout(aiToolCategoriesPersistTimer)
  aiToolCategoriesPersistTimer = setTimeout(flushAiToolCategories, AI_TOOL_CATEGORIES_DEBOUNCE_MS)
}

/** 结构性变更：立即落盘（先取消挂起的防抖，避免重复写） */
function setAiToolCategoriesPersist(categories: AiToolCategory[]): void {
  pendingAiToolCategories = categories
  flushAiToolCategories()
}

// ============================================================================
// AI 对话防抖持久化（Phase 4 问题 4）
// ============================================================================
// 问题背景：流式对话期间 addAiMessage / updateAssistant 写入频繁，若每次
// 都全量 JSON.stringify 整个 aiConversations 并写入 localStorage，属于明显
// 的写放大与主线程卡顿来源。
// 策略：内存即时生效（set 即渲染），持久化统一 800ms 防抖合并；
// 用户显式删除/清空、流结束（persistAiConversation）与卸载时机立即 flush。
const AI_PERSIST_DEBOUNCE_MS = 800
let aiPersistTimer: ReturnType<typeof setTimeout> | null = null

/** 立即把当前内存对话写盘（导出供流结束 / 卸载兜底等场景直接调用） */
export function flushAiConversations(): void {
  if (aiPersistTimer !== null) {
    clearTimeout(aiPersistTimer)
    aiPersistTimer = null
  }
  saveAiConversations(useAiStore.getState().aiConversations)
}

/** 防抖调度一次对话持久化（连续多次写入只落一次盘） */
function scheduleAiConversationPersist(): void {
  if (aiPersistTimer !== null) clearTimeout(aiPersistTimer)
  aiPersistTimer = setTimeout(flushAiConversations, AI_PERSIST_DEBOUNCE_MS)
}

// 页面卸载 / 进入后台前兜底 flush（webview 关闭时防抖回调可能被吞，无法依赖 setTimeout）
if (typeof window !== 'undefined') {
  const flushOnHidden = () => {
    if (document.visibilityState === 'hidden') {
      flushAiConversations()
      flushAiToolCategories()
    }
  }
  const flushAll = () => {
    flushAiConversations()
    flushAiToolCategories()
  }
  window.addEventListener('beforeunload', flushAll)
  document.addEventListener('visibilitychange', flushOnHidden)
}
