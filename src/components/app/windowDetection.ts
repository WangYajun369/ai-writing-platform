/**
 * 检测是否为独立窗口模式（世界观/版本历史/章节总结/AI工具箱/调试控制台）
 *
 * URL 参数仅在挂载时确定，不会变化。
 */

export interface WorldWindowInfo {
  isWorld: boolean
  bookId: string | null
  initialTab?: 'outline' | undefined
}

export interface HistoryWindowInfo {
  isHistory: boolean
  chapterId: string | null
  bookId: string | null
  chapterTitle: string | null
}

export interface SummaryWindowInfo {
  isSummary: boolean
  chapterId: string | null
  bookId: string | null
  chapterTitle: string | null
}

export interface AiToolboxWindowInfo {
  isAiToolbox: boolean
}

export interface DebugWindowInfo {
  isDebug: boolean
}

export interface VocabWindowInfo {
  isVocab: boolean
}

export function detectWorldWindow(): WorldWindowInfo {
  const params = new URLSearchParams(window.location.search)
  if (params.get('worldwin') === '1') {
    const tab = (params.get('tab') === 'outline' ? 'outline' : undefined) as 'outline' | undefined
    return { isWorld: true, bookId: params.get('bookId'), initialTab: tab }
  }
  return { isWorld: false, bookId: null }
}

export function detectHistoryWindow(): HistoryWindowInfo {
  const params = new URLSearchParams(window.location.search)
  if (params.get('historywin') === '1') {
    return {
      isHistory: true,
      chapterId: params.get('chapterId'),
      bookId: params.get('bookId'),
      chapterTitle: params.get('chapterTitle'),
    }
  }
  return { isHistory: false, chapterId: null, bookId: null, chapterTitle: null }
}

export function detectSummaryWindow(): SummaryWindowInfo {
  const params = new URLSearchParams(window.location.search)
  if (params.get('summarywin') === '1') {
    return {
      isSummary: true,
      chapterId: params.get('chapterId'),
      bookId: params.get('bookId'),
      chapterTitle: params.get('chapterTitle'),
    }
  }
  return { isSummary: false, chapterId: null, bookId: null, chapterTitle: null }
}

export function detectAiToolboxWindow(): AiToolboxWindowInfo {
  const params = new URLSearchParams(window.location.search)
  if (params.get('aitoolboxwin') === '1') return { isAiToolbox: true }
  return { isAiToolbox: false }
}

export function detectDebugWindow(): DebugWindowInfo {
  const params = new URLSearchParams(window.location.search)
  if (params.get('debugwin') === '1') return { isDebug: true }
  return { isDebug: false }
}

export function detectVocabWindow(): VocabWindowInfo {
  const params = new URLSearchParams(window.location.search)
  if (params.get('vocabwin') === '1') return { isVocab: true }
  return { isVocab: false }
}

export interface TasksWindowInfo {
  isTasks: boolean
  /** 命令面板深链目标视图区段：今日 / 全部任务 */
  section?: 'today' | 'all'
}

export function detectTasksWindow(): TasksWindowInfo {
  const params = new URLSearchParams(window.location.search)
  if (params.get('taskswin') !== '1') return { isTasks: false }
  const s = params.get('section')
  const section = s === 'all' || s === 'today' ? s : undefined
  return { isTasks: true, section }
}
