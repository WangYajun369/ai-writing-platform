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

  /** 软删除：移入回收站，数据完整保留 */
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

  /** 列出回收站中已删除的作品 */
  async listDeleted(): Promise<Book[]> {
    return invoke<Book[]>('list_deleted_books')
  },

  /** 从回收站恢复作品 */
  async restore(id: string): Promise<void> {
    return invoke<void>('restore_book', { id })
  },

  /** 彻底删除作品及其全部数据 */
  async hardDelete(id: string): Promise<void> {
    return invoke<void>('hard_delete_book', { id })
  },

  /** 一键清空回收站 */
  async clearTrash(): Promise<number> {
    return invoke<number>('clear_book_trash')
  },
}

// ==================== 卷管理 ====================

export const volumeApi = {
  async listByBook(bookId: string): Promise<Volume[]> {
    return invoke<Volume[]>('list_volumes', { bookId })
  },

  async listDeleted(bookId: string): Promise<Volume[]> {
    return invoke<Volume[]>('list_deleted_volumes', { bookId })
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

  async restore(id: string): Promise<void> {
    return invoke<void>('restore_volume', { id })
  },

  async hardDelete(id: string): Promise<void> {
    return invoke<void>('hard_delete_volume', { id })
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

  async listDeleted(bookId: string): Promise<Chapter[]> {
    return invoke<Chapter[]>('list_deleted_chapters', { bookId })
  },

  async restore(chapterId: string): Promise<{ volumeId: string | null }> {
    return invoke<{ volumeId: string | null }>('restore_chapter', { chapterId })
  },

  async hardDelete(chapterId: string): Promise<void> {
    return invoke<void>('hard_delete_chapter', { chapterId })
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

  /** 移动章节到指定卷（或根目录） */
  async moveToVolume(chapterId: string, volumeId: string | null): Promise<void> {
    return invoke<void>('move_chapter_to_volume', { chapterId, volumeId })
  },

  /** 保存章节的 AI 总结内容 */
  async saveSummary(chapterId: string, summary: string): Promise<void> {
    return invoke<void>('save_chapter_summary', { chapterId, summary })
  },

  /** 清除章节的 AI 总结内容 */
  async clearSummary(chapterId: string): Promise<void> {
    return invoke<void>('clear_chapter_summary', { chapterId })
  },

  /** 获取章节的总结信息 */
  async getSummary(chapterId: string): Promise<{ summary: string | null; summaryAt: string | null }> {
    return invoke<{ summary: string | null; summaryAt: string | null }>('get_chapter_summary', { chapterId })
  },

  /** 保存章节大纲 */
  async saveOutline(chapterId: string, outline: string): Promise<void> {
    return invoke<void>('save_chapter_outline', { chapterId, outline })
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

export interface ChapterSummary {
  summary: string
  originalChars: number
  summaryChars: number
  thinking: string
}

/** 对话总结参数 */
export interface SummarizeConversationArgs {
  endpoint: string
  model: string
  apiKey?: string
  temperature: number
  maxTokens?: number
  messages: ChatMessage[]
  previousSummary?: string
  thinkingEnabled?: boolean
}

/** 对话总结结果 */
export interface ConversationSummary {
  summary: string
  coveredCount: number
  summaryChars: number
  thinking: string
}

export interface SummarizeArgs {
  endpoint: string
  model: string
  apiKey?: string
  temperature: number
  maxTokens?: number
  chapterTitle: string
  chapterContent: string
  thinkingEnabled?: boolean
  /** 用户自定义 system prompt，为空时使用后端默认提示 */
  systemPrompt?: string
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

  /** 总结章节内容（非流式） */
  async summarizeChapter(args: SummarizeArgs): Promise<ChapterSummary> {
    return invoke<ChapterSummary>('summarize_chapter', { args })
  },

  /** 总结历史对话（用于滑动窗口 context 压缩） */
  async summarizeConversation(args: SummarizeConversationArgs): Promise<ConversationSummary> {
    return invoke<ConversationSummary>('summarize_conversation', { args })
  },
}

// ==================== 图片处理 ====================

export const imageApi = {
  /** 处理图片：压缩 + 缩放 + Base64 编码，返回 data: URL */
  async process(sourcePath: string, maxWidth = 1200, quality = 80): Promise<string> {
    return invoke<string>('process_image', { sourcePath, maxWidth, quality })
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

  /** 导出全部数据（数据库 + localStorage 缓存）到 JSON 文件 */
  async exportAllData(outputPath: string, cacheJson: string): Promise<void> {
    return invoke<void>('export_all_data', { outputPath, cacheJson })
  },

  /** 导出单个作品的完整数据（数据库 + localStorage 缓存）到加密 .tw 文件 */
  async exportSingleBook(bookId: string, outputPath: string, cacheJson: string): Promise<void> {
    return invoke<void>('export_single_book', { bookId, outputPath, cacheJson })
  },

  /** 统一导入备份文件（自动根据 backupType 选择全量/单作品导入），返回 { cache, backupType } */
  async importBackup(filePath: string): Promise<{ cache: unknown; backupType: string }> {
    return invoke<{ cache: unknown; backupType: string }>('import_backup', { filePath })
  },
}

// ==================== 调试控制台 ====================

export interface LogEntry {
  timestamp: string
  level: string
  message: string
  /** 源文件完整路径 */
  file?: string
  /** 文件名 */
  fileName?: string
  /** 行号 */
  line?: number
}

/** 数据库校验 — 单条问题 */
export interface ValidationIssue {
  table: string
  column?: string
  /** missing_table | missing_column | integrity_error | orphan_record */
  issueType: string
  detail: string
}

/** 数据库校验总结果 */
export interface ValidationResult {
  ok: boolean
  tablesCount: number
  issues: ValidationIssue[]
}

export const debugApi = {
  /** 打开调试控制台窗口 */
  async open(): Promise<void> {
    return invoke<void>('open_debug_window')
  },

  /** 关闭调试控制台窗口 */
  async close(): Promise<void> {
    return invoke<void>('close_debug_window')
  },

  /** 获取所有已缓存的日志（调试窗口启动时调用） */
  async getLogs(): Promise<LogEntry[]> {
    return invoke<LogEntry[]>('get_debug_logs')
  },

  /** 清空所有日志 */
  async clear(): Promise<void> {
    return invoke<void>('clear_debug_logs')
  },

  /** 校验本地 SQLite 数据库表结构和数据完整性 */
  async validateDatabase(): Promise<ValidationResult> {
    return invoke<ValidationResult>('validate_database')
  },
}
