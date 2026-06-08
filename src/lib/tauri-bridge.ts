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

  /** 设置书籍封面：传入本地文件路径，后端复制到应用数据目录并更新数据库 */
  async setCover(id: string, sourcePath: string): Promise<Book> {
    return invoke<Book>('set_book_cover', { id, sourcePath })
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

  async save(chapterId: string, contentHtml: string, wordCount: number): Promise<{ wordCount: number; bookWordCount: number }> {
    return invoke<{ wordCount: number; bookWordCount: number }>('save_chapter', { chapterId, contentHtml, wordCount })
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

  async restore(snapshotId: string): Promise<{ wordCount: number; bookWordCount: number }> {
    return invoke<{ wordCount: number; bookWordCount: number }>('restore_snapshot', { snapshotId })
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

export interface ChatMessage {
  role: string
  content: string
}

export interface StreamChatArgs {
  provider: string
  endpoint: string
  model: string
  temperature: number
  maxTokens?: number
  apiKey?: string
  messages: ChatMessage[]
  /** DeepSeek 思考模式开关，为 true 时注入 thinking: { type: "enabled" } */
  thinkingEnabled?: boolean
}

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  inputChars: number
  outputChars: number
}

export interface StreamEvent {
  content: string
  /** 思考过程（智谱/DeepSeek 推理模型的 reasoning_content） */
  thinking: string
  /** 当前阶段："thinking" | "answering" | "done" */
  phase: string
  done: boolean
  error?: string | null
  usage?: UsageInfo | null
}

export interface ConnectionTestResult {
  ok: boolean
  detail: string
}

export interface EmbeddingProgress {
  chaptersEmbedded: number
  worldCardsEmbedded: number
  totalChapters: number
  totalWorldCards: number
  model: string
}

export interface EmbeddingStatus {
  totalChapters: number
  totalWorldCards: number
  indexedChapters: number
  indexedWorldCards: number
  stale: boolean
}

export interface RagResultItem {
  snippet: string
  sourceType: string
  sourceId: string
  sourceTitle: string
  distance: number
}

export const aiApi = {
  /** RAG 语义检索：优先使用向量搜索，无 embedding 时降级为关键词搜索 */
  async ragSearch(
    bookId: string,
    query: string,
    topN = 5,
    endpoint?: string,
    apiKey?: string,
    embeddingModel?: string,
  ) {
    return invoke<RagResultItem[]>(
      'rag_search',
      { bookId, query, topN, endpoint: endpoint ?? null, apiKey: apiKey ?? null, embeddingModel: embeddingModel ?? null }
    )
  },

  /** 检查指定书籍的 Embedding 索引状态（是否过期） */
  async checkEmbeddingStatus(bookId: string): Promise<EmbeddingStatus> {
    return invoke<EmbeddingStatus>('check_embedding_status', { bookId })
  },

  /** 为指定书籍的所有章节和世界观卡片生成 Embedding 向量 */
  async triggerEmbedding(bookId: string, endpoint: string, apiKey: string, embeddingModel: string): Promise<EmbeddingProgress> {
    return invoke<EmbeddingProgress>('trigger_embedding', { bookId, endpoint, apiKey, embeddingModel })
  },

  /** 流式 AI 对话（Rust 侧处理 HTTP 流式请求，前端通过事件接收） */
  async streamChat(args: StreamChatArgs): Promise<string> {
    return invoke<string>('stream_ai_chat', { args })
  },

  /** 测试 AI 服务连接 */
  async testConnection(provider: string, endpoint: string, apiKey?: string): Promise<ConnectionTestResult> {
    return invoke<ConnectionTestResult>('test_ai_connection', { provider, endpoint, apiKey })
  },

  /** 测试 RAG Embedding 服务连接 */
  async testRagConnection(endpoint: string, apiKey: string, embeddingModel: string): Promise<ConnectionTestResult> {
    return invoke<ConnectionTestResult>('test_rag_connection', { endpoint, apiKey, embeddingModel })
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
