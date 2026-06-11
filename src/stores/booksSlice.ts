/**
 * 书库管理 Slice — 书籍/卷/章节的 CRUD 与排序
 */
import type { AppSlice } from './appTypes'

export const createBooksSlice: AppSlice = (set) => ({
  books: [],
  currentBookId: null,
  isLoadingBooks: false,
  volumes: [],
  chapters: [],
  currentChapterId: null,
  isLoadingChapters: false,
  dbStatus: 'idle' as const,
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
})
