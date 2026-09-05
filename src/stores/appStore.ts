/**
 * 领域 store 出口 + 跨域便捷选择器
 *
 * Phase 3 问题 3 收尾：原「单一 store + slice」架构已拆为三个真正独立的领域 store：
 * - useBooksStore（书库）       见 @/stores/booksStore
 * - useAiStore（AI 能力）       见 @/stores/aiStore
 * - usePreferencesStore（偏好） 见 @/stores/preferencesStore
 *
 * 本文件保留：
 * 1. 三个独立 store 的再导出（组件可直接 import 各自领域 store，订阅互不干扰）；
 * 2. 跨域便捷选择器（useCurrentBook / useCurrentChapter / useCurrentAiMessages）
 *    与 getEditorState 等工具再导出，保持旧 import 路径向后兼容。
 */
import { useBooksStore } from './booksStore'
import { useAiStore } from './aiStore'
import { usePreferencesStore } from './preferencesStore'
import type { AiMessage } from '../types'

export { useBooksStore, useAiStore, usePreferencesStore }
export { getEditorState } from './appTypes'
export type { AppState, AppSlice, EditorState, UserPreferences } from './appTypes'

// ==================== 跨域便捷选择器 ====================

/** 当前选中的书籍 */
export const useCurrentBook = () => {
  const books = useBooksStore((s) => s.books)
  const currentBookId = useBooksStore((s) => s.currentBookId)
  return books.find((b) => b.id === currentBookId) ?? null
}

/** 当前选中的章节 */
export const useCurrentChapter = () => {
  const chapters = useBooksStore((s) => s.chapters)
  const currentChapterId = useBooksStore((s) => s.currentChapterId)
  return chapters.find((c) => c.id === currentChapterId) ?? null
}

/** 当前作品（书）的 AI 对话消息 */
export const useCurrentAiMessages = (): AiMessage[] => {
  const aiConversations = useAiStore((s) => s.aiConversations)
  const currentBookId = useBooksStore((s) => s.currentBookId)
  return currentBookId ? (aiConversations[currentBookId] ?? []) : []
}
