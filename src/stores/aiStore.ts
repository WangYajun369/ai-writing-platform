/**
 * aiStore — AI 领域独立 store（AI 配置/对话记录/工具箱分类/连接状态/应用版本）
 *
 * Phase 3 问题 3 收尾：由原 aiSlice 升级为真正独立的 Zustand store。
 */
import { create } from 'zustand'
import type { AiConfig, AiMessage, ConversationSummary, AiToolCategory } from '../types'
import {
  loadAiConfig, saveAiConfig,
  loadAiToolCategories, saveAiToolCategories,
  aiConversationsStore, aiSummariesStore,
  saveAiConversations,
} from './appTypes'

export interface AiState {
  aiConnectionStatus: 'idle' | 'testing' | 'connected' | 'error'
  aiConnectionDetail: string
  aiConversations: Record<string, AiMessage[]>
  aiSummaries: Record<string, ConversationSummary>
  aiToolCategories: AiToolCategory[]
  appVersion: string
  aiConfig: AiConfig

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

export const useAiStore = create<AiState>()((set, get) => {
  const savedAiConfig = loadAiConfig()
  const savedAiConversations = aiConversationsStore.load()
  const savedAiSummaries = aiSummariesStore.load()

  return {
    aiConnectionStatus: 'idle',
    aiConnectionDetail: '',
    aiConversations: savedAiConversations,
    aiSummaries: savedAiSummaries,
    aiToolCategories: loadAiToolCategories(),
    appVersion: '',
    aiConfig: {
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
      ...savedAiConfig,
    } as AiConfig,

    setAiConfig: (config) =>
      set((s) => {
        const merged: AiConfig = {
          chat: config.chat ? { ...s.aiConfig.chat, ...config.chat } : s.aiConfig.chat,
          rag: config.rag ? { ...s.aiConfig.rag, ...config.rag } : s.aiConfig.rag,
        }
        saveAiConfig(merged)
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

    setAiConnectionStatus: (aiConnectionStatus, aiConnectionDetail = '') =>
      set({ aiConnectionStatus, aiConnectionDetail }),
    setAppVersion: (appVersion) => set({ appVersion }),
  }
})

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
    if (document.visibilityState === 'hidden') flushAiConversations()
  }
  window.addEventListener('beforeunload', flushAiConversations)
  document.addEventListener('visibilitychange', flushOnHidden)
}
