/**
 * Tauri IPC 桥接层
 * 封装所有 invoke 调用，提供统一的类型安全接口
 */
import { invoke } from '@tauri-apps/api/core'
import type { Book, Chapter, Volume, Snapshot, WorldCard } from '@/types'

// ==================== 书籍管理 ====================

export const bookApi = {
  async list(): Promise<Book[]> {
    return invoke<Book[]>('list_books')
  },

  async create(params: Omit<Book, 'id' | 'createdAt' | 'updatedAt' | 'wordCount' | 'todayCount'>): Promise<Book> {
    return invoke<Book>('create_book', { params })
  },

  async update(id: string, params: Partial<Book>): Promise<Book> {
    return invoke<Book>('update_book', { id, params })
  },

  async delete(id: string): Promise<void> {
    return invoke<void>('delete_book', { id })
  },

  async getById(id: string): Promise<Book> {
    return invoke<Book>('get_book', { id })
  },
}

// ==================== 卷管理 ====================

export const volumeApi = {
  async listByBook(bookId: string): Promise<Volume[]> {
    return invoke<Volume[]>('list_volumes', { bookId })
  },

  async create(bookId: string, title: string, sortOrder: number): Promise<Volume> {
    return invoke<Volume>('create_volume', { bookId, title, sortOrder })
  },

  async update(id: string, title: string): Promise<void> {
    return invoke<void>('update_volume', { id, title })
  },

  async delete(id: string): Promise<void> {
    return invoke<void>('delete_volume', { id })
  },

  async reorder(ids: string[]): Promise<void> {
    return invoke<void>('reorder_volumes', { ids })
  },
}

// ==================== 章节管理 ====================

export const chapterApi = {
  async listByBook(bookId: string): Promise<Chapter[]> {
    return invoke<Chapter[]>('list_chapters', { bookId })
  },

  async getContent(chapterId: string): Promise<string> {
    return invoke<string>('get_chapter_content', { chapterId })
  },

  async create(params: {
    bookId: string
    volumeId?: string
    title: string
    sortOrder: number
  }): Promise<Chapter> {
    return invoke<Chapter>('create_chapter', { params })
  },

  async save(chapterId: string, contentHtml: string): Promise<{ wordCount: number; bookWordCount: number }> {
    return invoke<{ wordCount: number; bookWordCount: number }>('save_chapter', { chapterId, contentHtml })
  },

  async updateStatus(chapterId: string, status: Chapter['status']): Promise<void> {
    return invoke<void>('update_chapter_status', { chapterId, status })
  },

  async rename(chapterId: string, title: string): Promise<void> {
    return invoke<void>('rename_chapter', { chapterId, title })
  },

  async delete(chapterId: string): Promise<void> {
    return invoke<void>('delete_chapter', { chapterId })
  },

  async reorder(chapterIds: string[]): Promise<void> {
    return invoke<void>('reorder_chapters', { chapterIds })
  },
}

// ==================== 版本快照 ====================

export const snapshotApi = {
  async list(chapterId: string): Promise<Snapshot[]> {
    return invoke<Snapshot[]>('list_snapshots', { chapterId })
  },

  async create(chapterId: string, label?: string): Promise<Snapshot> {
    return invoke<Snapshot>('create_snapshot', { chapterId, label })
  },

  async getContent(snapshotId: string): Promise<string> {
    return invoke<string>('get_snapshot_content', { snapshotId })
  },

  async restore(snapshotId: string): Promise<void> {
    return invoke<void>('restore_snapshot', { snapshotId })
  },

  async delete(snapshotId: string): Promise<void> {
    return invoke<void>('delete_snapshot', { snapshotId })
  },
}

// ==================== 世界观资料库 ====================

export const worldCardApi = {
  async listByBook(bookId: string): Promise<WorldCard[]> {
    return invoke<WorldCard[]>('list_world_cards', { bookId })
  },

  async create(params: Omit<WorldCard, 'id' | 'createdAt' | 'updatedAt' | 'vectorized'>): Promise<WorldCard> {
    return invoke<WorldCard>('create_world_card', { params })
  },

  async update(id: string, params: Partial<WorldCard>): Promise<WorldCard> {
    return invoke<WorldCard>('update_world_card', { id, params })
  },

  async delete(id: string): Promise<void> {
    return invoke<void>('delete_world_card', { id })
  },

  async search(bookId: string, query: string): Promise<WorldCard[]> {
    return invoke<WorldCard[]>('search_world_cards', { bookId, query })
  },
}

// ==================== AI & 向量检索 ====================

export const aiApi = {
  async ragSearch(bookId: string, query: string, topN = 5) {
    return invoke<Array<{ snippet: string; sourceId: string; sourceTitle: string; distance: number }>>(
      'rag_search',
      { bookId, query, topN }
    )
  },

  async triggerEmbedding(bookId: string): Promise<void> {
    return invoke<void>('trigger_embedding', { bookId })
  },
}

// ==================== 导入导出 ====================

export const importExportApi = {
  async exportBook(bookId: string, format: 'txt' | 'md' | 'html', outputPath: string): Promise<void> {
    return invoke<void>('export_book', { bookId, format, outputPath })
  },

  async importTxt(bookId: string, filePath: string): Promise<{ chaptersCreated: number }> {
    return invoke<{ chaptersCreated: number }>('import_txt', { bookId, filePath })
  },
}
