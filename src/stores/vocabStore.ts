/**
 * 英语生词本全局数据 Store（生词本独立窗口内使用）
 *
 * words：生词本 Tab 当前过滤（状态 + 搜索词）下的分页缓冲（默认每页 50 条），
 *        由后端 `vocab_list_page` 过滤并分页，前端虚拟滚动按需 loadMore。
 * due：今日到期队列（复习 Tab）
 * stats：统计概览（统计 Tab / 窗口摘要 / 主窗口徽标计数）
 * freshWords：需首次学习的新词（复习 Tab「先学今日新词」用，独立加载、数量天然较小）
 */
import { create } from 'zustand'
import { vocabApi } from '@/lib/tauri-bridge'
import type { VocabStats, VocabWord, VocabStatus } from '@/types'

/** 生词本分页每页条数（虚拟滚动步长） */
export const WORD_PAGE_SIZE = 50

type WordFilter = VocabStatus | 'all'

interface VocabState {
  stats: VocabStats | null
  /** 生词本 Tab 当前过滤下的分页缓冲（服务端已按状态 + 搜索词过滤） */
  words: VocabWord[]
  /** 当前过滤条件下匹配总数（用于判断是否还有下一页） */
  wordsTotal: number
  /** 缓冲是否还有下一页可加载 */
  wordsHasMore: boolean
  wordsStatus: WordFilter
  wordsQuery: string
  wordsPage: number
  /** 需首次学习的新词（learning 且从未复习），仅取前若干条供复习入口 */
  freshWords: VocabWord[]
  /** 「复习已掌握词」批量回炉：待消费的一批种子词；被复习 Tab 消费后清空 */
  pendingReviewSeed: VocabWord[] | null
  due: VocabWord[]
  /** 各生词的关联条数（列表徽标），key 为生词 id */
  relationCounts: Record<string, number>
  loading: boolean
  loaded: boolean
  loadStats: () => Promise<void>
  loadDue: () => Promise<void>
  /** 按当前 wordsStatus / wordsQuery 重新加载第 0 页 */
  refreshWordList: () => Promise<void>
  /** 追加下一页到缓冲（无更多或加载中则忽略） */
  loadMoreWords: () => Promise<void>
  setFilter: (f: WordFilter) => void
  setQuery: (q: string) => void
  /** 加载「先学今日新词」入口数据 */
  loadFreshWords: () => Promise<void>
  /** 发起「复习已掌握词」：置入种子词，由窗口切到复习 Tab、复习 Tab 消费开会话 */
  requestReview: (words: VocabWord[]) => void
  /** 清空待消费的种子词 */
  clearPendingReview: () => void
  /** 全量刷新（增删改/复习/事件触发后调用） */
  refreshAll: () => Promise<void>
}

export const useVocabStore = create<VocabState>((set, get) => ({
  stats: null,
  words: [],
  wordsTotal: 0,
  wordsHasMore: false,
  wordsStatus: 'all',
  wordsQuery: '',
  wordsPage: 0,
  freshWords: [],
  pendingReviewSeed: null,
  due: [],
  relationCounts: {},
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

  loadDue: async () => {
    try {
      const due = await vocabApi.due()
      set({ due })
    } catch (err) {
      console.error('加载到期队列失败', err)
    }
  },

  refreshWordList: async () => {
    const { wordsStatus, wordsQuery } = get()
    try {
      const page = await vocabApi.listPage(wordsStatus, wordsQuery, 0, WORD_PAGE_SIZE)
      set({
        words: page.items,
        wordsTotal: page.total,
        wordsHasMore: page.items.length < page.total,
        wordsPage: 0,
      })
    } catch (err) {
      console.error('加载生词列表失败', err)
    }
  },

  loadMoreWords: async () => {
    const { wordsStatus, wordsQuery, wordsPage, words, wordsTotal } = get()
    if (words.length >= wordsTotal) return
    const next = wordsPage + 1
    try {
      const page = await vocabApi.listPage(wordsStatus, wordsQuery, next, WORD_PAGE_SIZE)
      set({
        words: [...words, ...page.items],
        wordsPage: next,
        wordsHasMore: words.length + page.items.length < wordsTotal,
      })
    } catch (err) {
      console.error('加载更多生词失败', err)
    }
  },

  setFilter: (f) => {
    set({ wordsStatus: f })
    void get().refreshWordList()
  },

  setQuery: (q) => {
    set({ wordsQuery: q })
    void get().refreshWordList()
  },

  loadFreshWords: async () => {
    try {
      // 仅取 learning 子集（天然远小于全量），客户端筛出从未复习者
      const learning = await vocabApi.list('learning', '')
      const fresh = learning
        .filter((w) => !w.lastReviewAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 9)
      set({ freshWords: fresh })
    } catch (err) {
      console.error('加载新词失败', err)
    }
  },

  requestReview: (words) => {
    set({ pendingReviewSeed: words })
  },

  clearPendingReview: () => {
    set({ pendingReviewSeed: null })
  },

  refreshAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const [stats, due, counts] = await Promise.all([
        vocabApi.stats(),
        vocabApi.due(),
        vocabApi.relationsCounts(),
      ])
      const relationCounts: Record<string, number> = {}
      for (const c of counts) relationCounts[c.wordId] = c.count
      set({ stats, due, relationCounts, loaded: true })
      // 生词本分页缓冲与新词入口随全量刷新一并重建
      await Promise.all([get().refreshWordList(), get().loadFreshWords()])
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
