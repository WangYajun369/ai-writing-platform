/**
 * 英语生词本全局数据 Store（生词本独立窗口内使用）
 *
 * words：全部词条（生词本 Tab）
 * due：今日到期队列（复习 Tab）
 * stats：统计概览（统计 Tab / 窗口摘要 / 主窗口徽标计数）
 */
import { create } from 'zustand'
import { vocabApi } from '@/lib/tauri-bridge'
import type { VocabStats, VocabWord } from '@/types'

interface VocabState {
  stats: VocabStats | null
  words: VocabWord[]
  due: VocabWord[]
  loading: boolean
  loaded: boolean
  loadStats: () => Promise<void>
  loadWords: () => Promise<void>
  loadDue: () => Promise<void>
  /** 全量刷新（增删改/复习/事件触发后调用） */
  refreshAll: () => Promise<void>
}

export const useVocabStore = create<VocabState>((set, get) => ({
  stats: null,
  words: [],
  due: [],
  loading: false,
  loaded: false,

  loadStats: async () => {
    try {
      const stats = await vocabApi.stats()
      set({ stats })
    } catch (err) {
      console.error('加载生词统计失败', err)
    }
  },

  loadWords: async () => {
    try {
      const words = await vocabApi.list('all', '')
      set({ words })
    } catch (err) {
      console.error('加载生词列表失败', err)
    }
  },

  loadDue: async () => {
    try {
      const due = await vocabApi.due()
      set({ due })
    } catch (err) {
      console.error('加载到期队列失败', err)
    }
  },

  refreshAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const [stats, words, due] = await Promise.all([vocabApi.stats(), vocabApi.list('all', ''), vocabApi.due()])
      set({ stats, words, due, loaded: true })
    } catch (err) {
      console.error('刷新生词数据失败', err)
    } finally {
      set({ loading: false })
    }
  },
}))

/** 便捷：刷新统计与队列（主窗口徽标也可复用） */
export async function refreshVocabBadgeData(): Promise<number> {
  try {
    const stats = await vocabApi.stats()
    return stats.dueToday
  } catch {
    return 0
  }
}
