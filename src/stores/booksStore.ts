/**
 * booksStore — 书库领域独立 store（书籍/卷/章节/回收站计数/DB 状态）
 *
 * Phase 3 问题 3 收尾：由原 booksSlice 升级为真正独立的 Zustand store，
 * 不再与 ai/preferences 共享一个 store 实例，领域间订阅互不干扰。
 */
import { create } from 'zustand'
import type { Book, Chapter, Volume } from '../types'

export interface BooksState {
  books: Book[]
  currentBookId: string | null
  isLoadingBooks: boolean
  volumes: Volume[]
  chapters: Chapter[]
  currentChapterId: string | null
  isLoadingChapters: boolean
  dbStatus: 'idle' | 'connected' | 'error'
  trashCount: number

  setBooks: (books: Book[]) => void
  setCurrentBookId: (id: string | null) => void
  setVolumes: (volumes: Volume[]) => void
  setChapters: (chapters: Chapter[]) => void
  setCurrentChapterId: (id: string | null) => void
  setTrashCount: (count: number) => void
  setDbStatus: (status: BooksState['dbStatus']) => void
  setLoadingBooks: (v: boolean) => void
  setLoadingChapters: (v: boolean) => void

  updateChapter: (id: string, patch: Partial<Chapter>) => void
  addChapter: (chapter: Chapter) => void
  removeChapter: (id: string) => void
  reorderVolumes: (orderedIds: string[]) => void
  reorderChapters: (orderedIds: string[]) => void
  moveChapterToVolume: (
    chapterId: string,
    volumeId: string | null,
    sortOrder?: number,
  ) => void
  updateBook: (id: string, patch: Partial<Book>) => void
  addBook: (book: Book) => void
  removeBook: (id: string) => void
}

export const useBooksStore = create<BooksState>()((set) => ({
  books: [],
  currentBookId: null,
  isLoadingBooks: false,
  volumes: [],
  chapters: [],
  currentChapterId: null,
  isLoadingChapters: false,
  dbStatus: 'idle',
  trashCount: 0,

  setBooks: (books) => set({ books }),
  setCurrentBookId: (id) => set({ currentBookId: id }),
  setVolumes: (volumes) => set({ volumes }),
  setChapters: (chapters) => set({ chapters }),
  setCurrentChapterId: (id) => set({ currentChapterId: id }),
  setTrashCount: (trashCount) => set({ trashCount }),
  setDbStatus: (dbStatus) => set({ dbStatus }),
  setLoadingBooks: (v) => set({ isLoadingBooks: v }),
  setLoadingChapters: (v) => set({ isLoadingChapters: v }),

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
          ? {
              ...c,
              volumeId: volumeId ?? undefined,
              sortOrder: sortOrder ?? c.sortOrder,
            }
          : c,
      ),
    })),

  updateBook: (id, patch) =>
    set((s) => ({
      books: s.books.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    })),

  addBook: (book) => set((s) => ({ books: [...s.books, book] })),
  removeBook: (id) => set((s) => ({ books: s.books.filter((b) => b.id !== id) })),
}))
