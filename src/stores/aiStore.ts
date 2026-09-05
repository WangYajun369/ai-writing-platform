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

    deleteAiMessage: (bookId, messageId) =>
      set((s) => {
        const msgs = s.aiConversations[bookId]
        if (!msgs) return s
        const idx = msgs.findIndex((m) => m.id === messageId)
        if (idx === -1) return s
        const target = msgs[idx]
        if (target.role === 'assistant') {
          const prevIdx = idx - 1
          const toRemove = new Set([idx])
          if (prevIdx >= 0 && msgs[prevIdx].role === 'user') toRemove.add(prevIdx)
          const filtered = msgs.filter((_, i) => !toRemove.has(i))
          const conversations = { ...s.aiConversations, [bookId]: filtered }
          saveAiConversations(conversations)
          return { aiConversations: conversations }
        }
        if (target.role === 'user') {
          const nextIdx = idx + 1
          const toRemove = new Set([idx])
          if (nextIdx < msgs.length && msgs[nextIdx].role === 'assistant') toRemove.add(nextIdx)
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
        const summaries = { ...s.aiSummaries }
        delete summaries[bookId]
        aiSummariesStore.save(summaries)
        return { aiConversations: conversations, aiSummaries: summaries }
      }),

    persistAiConversation: (_bookId) => {
      const conversations = get().aiConversations
      saveAiConversations(conversations)
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
