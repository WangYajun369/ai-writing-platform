/**
 * Tauri IPC 桥接层
 * 封装所有 invoke 调用，提供统一的类型安全接口。
 *
 * 禁止在其他文件中直接 import { invoke } from '@tauri-apps/api/core'。
 * 所有 IPC 调用必须通过此模块的 API 对象进行。
 */
import { invoke } from '@tauri-apps/api/core'
import type { IpcCommand } from '@/types/ipc-commands'
import type { Book, Chapter, Volume, Snapshot, WorldCard, Diary, DiaryMeta, CreateBookParams, UpdateBookParams, SaveDiaryParams, Schedule, SaveScheduleParams, VocabWord, VocabStats, VocabReviewLog, AddVocabWordArgs, UpdateVocabWordArgs, DictStatus, DictLookupResult, AiWordExplain, ExplainWordArgs, WordCheckResult, TtsSpeakResult, TaskProject, ProjectView, TaskCard, TaskSubtask, TaskTag, TaskStatus, TaskTemplate, TodayOverview, MigrateResult, DeletedTaskItem, ProjectStatus, CreateProjectArgs, UpdateProjectArgs, CreateTaskArgs, UpdateTaskArgs, CreateTemplateArgs, UpdateTemplateArgs, Attachment, ActivityLog, ProjectWeeklyStat, UpdateTagArgs, AgentTrace } from '@/types'

/**
 * 类型化 invoke：命令名接受 IpcCommand 联合类型约束。
 *
 * 收益：Rust 端重命名命令而忘记同步时，前端 invoke 会立即编译报错
 * （字符串字面量不再是 IpcCommand 成员），无需运行时才发现 not found。
 *
 * 用法：typedInvoke<Book[]>('list_books')
 *       typedInvoke<Book>('create_book', { params })
 */
function typedInvoke<T>(cmd: IpcCommand, args?: Record<string, unknown>): Promise<T> {
  return args === undefined ? invoke<T>(cmd) : invoke<T>(cmd, args)
}

// ==================== 书籍管理 ====================

export const bookApi = {
  async list(): Promise<Book[]> {
    return typedInvoke<Book[]>('list_books')
  },

  async create(params: CreateBookParams): Promise<Book> {
    return typedInvoke<Book>('create_book', { params })
  },

  async update(id: string, params: UpdateBookParams): Promise<Book> {
    return typedInvoke<Book>('update_book', { id, params })
  },

  /** 软删除：移入回收站，数据完整保留 */
  async delete(id: string): Promise<void> {
    return typedInvoke<void>('delete_book', { id })
  },

  async getById(id: string): Promise<Book> {
    return typedInvoke<Book>('get_book', { id })
  },

  /** 设置书籍封面：传入本地文件路径，后端复制到应用数据目录并更新数据库 */
  async setCover(id: string, sourcePath: string): Promise<Book> {
    return typedInvoke<Book>('set_book_cover', { id, sourcePath })
  },

  /** 直接保存已处理的 Base64 data URL 作为封面（前端已完成裁剪/压缩） */
  async setCoverData(id: string, dataUrl: string): Promise<Book> {
    return typedInvoke<Book>('set_book_cover_data', { id, dataUrl })
  },

  /** 列出回收站中已删除的作品 */
  async listDeleted(): Promise<Book[]> {
    return typedInvoke<Book[]>('list_deleted_books')
  },

  /** 从回收站恢复作品 */
  async restore(id: string): Promise<void> {
    return typedInvoke<void>('restore_book', { id })
  },

  /** 彻底删除作品及其全部数据 */
  async hardDelete(id: string): Promise<void> {
    return typedInvoke<void>('hard_delete_book', { id })
  },

  /** 一键清空回收站 */
  async clearTrash(): Promise<number> {
    return typedInvoke<number>('clear_book_trash')
  },
}

// ==================== 卷管理 ====================

export const volumeApi = {
  async listByBook(bookId: string): Promise<Volume[]> {
    return typedInvoke<Volume[]>('list_volumes', { bookId })
  },

  async listDeleted(bookId: string): Promise<Volume[]> {
    return typedInvoke<Volume[]>('list_deleted_volumes', { bookId })
  },

  async create(bookId: string, title: string, sortOrder: number): Promise<Volume> {
    return typedInvoke<Volume>('create_volume', { bookId, title, sortOrder })
  },

  async update(id: string, title: string): Promise<void> {
    return typedInvoke<void>('update_volume', { id, title })
  },

  async delete(id: string): Promise<void> {
    return typedInvoke<void>('delete_volume', { id })
  },

  async restore(id: string): Promise<void> {
    return typedInvoke<void>('restore_volume', { id })
  },

  async hardDelete(id: string): Promise<void> {
    return typedInvoke<void>('hard_delete_volume', { id })
  },

  async reorder(ids: string[]): Promise<void> {
    return typedInvoke<void>('reorder_volumes', { ids })
  },
}

// ==================== 章节管理 ====================

export const chapterApi = {
  async listByBook(bookId: string): Promise<Chapter[]> {
    return typedInvoke<Chapter[]>('list_chapters', { bookId })
  },

  async listDeleted(bookId: string): Promise<Chapter[]> {
    return typedInvoke<Chapter[]>('list_deleted_chapters', { bookId })
  },

  async restore(chapterId: string): Promise<{ volumeId: string | null; bookWordCount: number }> {
    return typedInvoke<{ volumeId: string | null; bookWordCount: number }>('restore_chapter', { chapterId })
  },

  /** 彻底删除章节，返回更新后的全书字数 */
  async hardDelete(chapterId: string): Promise<{ bookWordCount: number }> {
    return typedInvoke<{ bookWordCount: number }>('hard_delete_chapter', { chapterId })
  },

  async getContent(chapterId: string): Promise<string> {
    return typedInvoke<string>('get_chapter_content', { chapterId })
  },

  async create(params: {
    bookId: string
    volumeId?: string
    title: string
    sortOrder: number
  }): Promise<Chapter> {
    return typedInvoke<Chapter>('create_chapter', { params })
  },

  async save(chapterId: string, contentHtml: string, wordCount: number): Promise<{ wordCount: number; bookWordCount: number }> {
    return typedInvoke<{ wordCount: number; bookWordCount: number }>('save_chapter', { chapterId, contentHtml, wordCount })
  },

  async updateStatus(chapterId: string, status: Chapter['status']): Promise<void> {
    return typedInvoke<void>('update_chapter_status', { chapterId, status })
  },

  async rename(chapterId: string, title: string): Promise<void> {
    return typedInvoke<void>('rename_chapter', { chapterId, title })
  },

  /** 软删除章节，返回更新后的全书字数 */
  async delete(chapterId: string): Promise<{ bookWordCount: number }> {
    return typedInvoke<{ bookWordCount: number }>('delete_chapter', { chapterId })
  },

  async reorder(chapterIds: string[]): Promise<void> {
    return typedInvoke<void>('reorder_chapters', { chapterIds })
  },

  /** 移动章节到指定卷（或根目录） */
  async moveToVolume(chapterId: string, volumeId: string | null): Promise<void> {
    return typedInvoke<void>('move_chapter_to_volume', { chapterId, volumeId })
  },

  /** 保存章节的 AI 总结内容 */
  async saveSummary(chapterId: string, summary: string): Promise<void> {
    return typedInvoke<void>('save_chapter_summary', { chapterId, summary })
  },

  /** 清除章节的 AI 总结内容 */
  async clearSummary(chapterId: string): Promise<void> {
    return typedInvoke<void>('clear_chapter_summary', { chapterId })
  },

  /** 获取章节的总结信息 */
  async getSummary(chapterId: string): Promise<{ summary: string | null; summaryAt: string | null }> {
    return typedInvoke<{ summary: string | null; summaryAt: string | null }>('get_chapter_summary', { chapterId })
  },

  /** 保存章节大纲 */
  async saveOutline(chapterId: string, outline: string): Promise<void> {
    return typedInvoke<void>('save_chapter_outline', { chapterId, outline })
  },
}

// ==================== 版本快照 ====================

export const snapshotApi = {
  async list(chapterId: string): Promise<Snapshot[]> {
    return typedInvoke<Snapshot[]>('list_snapshots', { chapterId })
  },

  async create(chapterId: string, label?: string): Promise<Snapshot> {
    return typedInvoke<Snapshot>('create_snapshot', { chapterId, label })
  },

  async getContent(snapshotId: string): Promise<string> {
    return typedInvoke<string>('get_snapshot_content', { snapshotId })
  },

  async restore(snapshotId: string): Promise<{ wordCount: number; bookWordCount: number }> {
    return typedInvoke<{ wordCount: number; bookWordCount: number }>('restore_snapshot', { snapshotId })
  },

  async delete(snapshotId: string): Promise<void> {
    return typedInvoke<void>('delete_snapshot', { snapshotId })
  },
}

// ==================== 世界观资料库 ====================

export const worldCardApi = {
  async listByBook(bookId: string): Promise<WorldCard[]> {
    return typedInvoke<WorldCard[]>('list_world_cards', { bookId })
  },

  async create(params: Omit<WorldCard, 'id' | 'createdAt' | 'updatedAt' | 'vectorized'>): Promise<WorldCard> {
    return typedInvoke<WorldCard>('create_world_card', { params })
  },

  async update(id: string, params: Partial<WorldCard>): Promise<WorldCard> {
    return typedInvoke<WorldCard>('update_world_card', { id, params })
  },

  async delete(id: string): Promise<void> {
    return typedInvoke<void>('delete_world_card', { id })
  },

  /** FTS5 全文搜索世界观卡片 */
  async search(bookId: string, query: string): Promise<WorldCard[]> {
    return typedInvoke<WorldCard[]>('search_world_cards', { bookId, query })
  },
}

// ==================== 日记管理 ====================

export const diaryApi = {
  /** 列出指定年月（1-12）的日记摘要，按日期升序 */
  async listMonth(year: number, month: number): Promise<DiaryMeta[]> {
    return typedInvoke<DiaryMeta[]>('list_month_diaries', { year, month })
  },

  /** 列出全部日记摘要（不含正文），按日期升序（书页式「看日记」浏览用） */
  async listAll(): Promise<DiaryMeta[]> {
    return typedInvoke<DiaryMeta[]>('list_all_diaries')
  },

  /** 按日期（YYYY-MM-DD）获取日记全文，不存在时返回 null */
  async get(date: string): Promise<Diary | null> {
    return typedInvoke<Diary | null>('get_diary', { date })
  },

  /** 保存日记（该日期已存在则覆盖，否则新建） */
  async save(params: SaveDiaryParams): Promise<Diary> {
    return typedInvoke<Diary>('save_diary', { params })
  },

  /** 按日期删除日记 */
  async delete(date: string): Promise<void> {
    return typedInvoke<void>('delete_diary', { date })
  },
}

// ==================== 日程管理 ====================

export const scheduleApi = {
  /** 列出某日期下的全部日程 */
  async listByDate(date: string): Promise<Schedule[]> {
    return typedInvoke<Schedule[]>('list_schedules_by_date', { date })
  },

  /** 列出某年某月下的全部日程（日历状态点用） */
  async listMonth(year: number, month: number): Promise<Schedule[]> {
    return typedInvoke<Schedule[]>('list_schedules_by_month', { year, month })
  },

  /** 保存日程（id 存在则更新，否则新建） */
  async save(params: SaveScheduleParams): Promise<Schedule> {
    return typedInvoke<Schedule>('save_schedule', { params })
  },

  /** 按 id 删除日程 */
  async delete(id: string): Promise<void> {
    return typedInvoke<void>('delete_schedule', { id })
  },
}

// ==================== 窗口管理 ====================

export interface WindowOpenOptions {
  /** 世界观窗口可选 tab */
  tab?: string
  /** 版本历史/章节总结窗口参数 */
  chapterId?: string
  bookId?: string
  chapterTitle?: string
}

export const windowApi = {
  /** 打开世界观资料库独立窗口 */
  async openWorld(bookId: string, tab?: string): Promise<void> {
    return typedInvoke<void>('open_world_window', { bookId, tab: tab ?? null })
  },

  /** 关闭世界观资料库独立窗口 */
  async closeWorld(): Promise<void> {
    return typedInvoke<void>('close_world_window')
  },

  /** 打开版本历史独立窗口 */
  async openHistory(chapterId: string, bookId: string, chapterTitle: string): Promise<void> {
    return typedInvoke<void>('open_history_window', { chapterId, bookId, chapterTitle })
  },

  /** 关闭版本历史独立窗口 */
  async closeHistory(): Promise<void> {
    return typedInvoke<void>('close_history_window')
  },

  /** 打开章节总结独立窗口 */
  async openSummary(chapterId: string, bookId: string, chapterTitle: string): Promise<void> {
    return typedInvoke<void>('open_summary_window', { chapterId, bookId, chapterTitle })
  },

  /** 关闭章节总结独立窗口 */
  async closeSummary(): Promise<void> {
    return typedInvoke<void>('close_summary_window')
  },

  /** 打开 AI 工具箱独立窗口 */
  async openAiToolbox(): Promise<void> {
    return typedInvoke<void>('open_ai_toolbox_window')
  },

  /** 关闭 AI 工具箱独立窗口 */
  async closeAiToolbox(): Promise<void> {
    return typedInvoke<void>('close_ai_toolbox_window')
  },

  /** 打开英语字典（生词本）独立窗口（已打开则关闭，即 toggle） */
  async openVocab(): Promise<void> {
    return typedInvoke<void>('open_vocab_window')
  },

  /** 关闭英语字典独立窗口 */
  async closeVocab(): Promise<void> {
    return typedInvoke<void>('close_vocab_window')
  },

  /** 英语字典窗口当前是否打开 */
  async isVocabOpen(): Promise<boolean> {
    return typedInvoke<boolean>('is_vocab_window_open')
  },

  /** 打开任务卡（项目管理）独立窗口；传 section 时窗口已开则直接导航到该区段 */
  async openTasks(section?: 'today' | 'all'): Promise<void> {
    return typedInvoke<void>('open_tasks_window', { section: section ?? null })
  },

  /** 关闭任务卡独立窗口 */
  async closeTasks(): Promise<void> {
    return typedInvoke<void>('close_tasks_window')
  },

  /** 任务卡窗口当前是否打开 */
  async isTasksOpen(): Promise<boolean> {
    return typedInvoke<boolean>('is_tasks_window_open')
  },

  /** 打开/切换「看日记」书页浏览独立窗口（已打开则关闭，未打开则创建） */
  async openDiaryBook(): Promise<void> {
    return typedInvoke<void>('open_diary_book_window')
  },

  /** 关闭「看日记」书页浏览独立窗口 */
  async closeDiaryBook(): Promise<void> {
    return typedInvoke<void>('close_diary_book_window')
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
    return typedInvoke<RagResultItem[]>(
      'rag_search',
      { bookId, query, topN, endpoint: endpoint ?? null, apiKey: apiKey ?? null, embeddingModel: embeddingModel ?? null }
    )
  },

  /** 检查指定书籍的 Embedding 索引状态（是否过期） */
  async checkEmbeddingStatus(bookId: string): Promise<EmbeddingStatus> {
    return typedInvoke<EmbeddingStatus>('check_embedding_status', { bookId })
  },

  /** 为指定书籍的所有章节和世界观卡片生成 Embedding 向量 */
  async triggerEmbedding(bookId: string, endpoint: string, apiKey: string, embeddingModel: string): Promise<EmbeddingProgress> {
    return typedInvoke<EmbeddingProgress>('trigger_embedding', { bookId, endpoint, apiKey, embeddingModel })
  },

  /** 流式 AI 对话（Rust 侧处理 HTTP 流式请求，前端通过事件接收） */
  async streamChat(args: StreamChatArgs): Promise<string> {
    return typedInvoke<string>('stream_ai_chat', { args })
  },

  /** 测试 AI 服务连接 */
  async testConnection(provider: string, endpoint: string, apiKey?: string): Promise<ConnectionTestResult> {
    return typedInvoke<ConnectionTestResult>('test_ai_connection', { provider, endpoint, apiKey })
  },

  /** 测试 RAG Embedding 服务连接 */
  async testRagConnection(endpoint: string, apiKey: string, embeddingModel: string): Promise<ConnectionTestResult> {
    return typedInvoke<ConnectionTestResult>('test_rag_connection', { endpoint, apiKey, embeddingModel })
  },

  /** 总结章节内容（非流式） */
  async summarizeChapter(args: SummarizeArgs): Promise<ChapterSummary> {
    return typedInvoke<ChapterSummary>('summarize_chapter', { args })
  },

  /** 总结历史对话（用于滑动窗口 context 压缩） */
  async summarizeConversation(args: SummarizeConversationArgs): Promise<ConversationSummary> {
    return typedInvoke<ConversationSummary>('summarize_conversation', { args })
  },
}

// ==================== Agent 引擎 ====================

/** Agent 对话历史项（execute_agent_skill 入参，与后端 SkillHistoryItem 对齐） */
export interface AgentHistoryItem {
  role: string
  content: string
}

/** Agent 调用 AI 配置（与后端 AiConfigParams 对齐，camelCase） */
export interface AgentAiConfig {
  provider: string
  endpoint: string
  model: string
  apiKey?: string | null
  temperature?: number | null
  maxTokens?: number | null
  thinkingEnabled?: boolean | null
  /** DeepSeek 思考强度：high（默认）或 max（Agent 场景推荐） */
  reasoningEffort?: string | null
}

/** execute_agent_skill 完整参数（事件流经 `agent-stream-chunk` 推送） */
export interface AgentSkillArgs {
  skill: string
  bookId: string
  message: string
  /** 最近对话历史；Skill 独立任务轮次可传 null */
  conversationHistory?: AgentHistoryItem[] | null
  aiConfig?: AgentAiConfig | null
  requestId?: string
  /** 会话滑动窗口摘要（聊天模式传入；Skill 模式传 null） */
  conversationSummary?: string | null
}

/** 记忆类型（三层记忆体） */
export type AgentMemoryType = 'preference' | 'decision' | 'lesson'

/** 单条 Agent 记忆（字段 snake_case 与后端 MemoryInfo 对齐） */
export interface AgentMemoryInfo {
  id: number
  book_id: string
  skill_type: string
  memory_type: AgentMemoryType
  content: string
  keywords: string
  relevance_score: number
  created_at: string
  updated_at: string
  /** 最近一次被检索命中并注入对话的时间（null = 从未命中） */
  last_hit_at?: string | null
}

/** Agent 记忆列表响应 */
export interface AgentMemoryListResponse {
  memories: AgentMemoryInfo[]
  total: number
}

export const agentApi = {
  /**
   * 执行 Agent Skill（SSE 流式）
   * 流式事件经 `agent-stream-chunk` 推送（携带 requestId），返回值为最终累积的完整文本
   */
  async executeSkill(args: AgentSkillArgs): Promise<string> {
    return typedInvoke<string>('execute_agent_skill', { ...args })
  },

  /** 取消当前正在执行的 Agent 任务（CancelToken 即时中断） */
  async cancelSkill(): Promise<void> {
    return invoke('cancel_agent_skill')
  },

  /** 列出指定书籍的 Agent 记忆（skillType 可选过滤，null = 全部） */
  async listMemories(bookId: string, skillType?: string | null): Promise<AgentMemoryListResponse> {
    return typedInvoke<AgentMemoryListResponse>('list_agent_memories', {
      bookId,
      skillType: skillType ?? null,
    })
  },

  /** 更新单条记忆（字段传 null 表示不修改） */
  async updateMemory(
    memoryId: number,
    content?: string | null,
    keywords?: string | null,
    memoryType?: string | null,
  ): Promise<void> {
    return invoke('update_agent_memory', {
      memoryId,
      content: content ?? null,
      keywords: keywords ?? null,
      memoryType: memoryType ?? null,
    })
  },

  /** 删除单条记忆 */
  async deleteMemory(memoryId: number): Promise<void> {
    return typedInvoke<void>('delete_agent_memory', { memoryId })
  },

  /** 清空指定书籍全部记忆，返回删除条数 */
  async clearMemories(bookId: string): Promise<number> {
    return typedInvoke<number>('clear_agent_memories', { bookId })
  },

  // ── Agent Trace 持久化（v1.9）──

  /** 按 request_id 列出 Agent 推理轨迹（调试控制台回放） */
  async listTraces(requestId: string): Promise<AgentTrace[]> {
    return typedInvoke<AgentTrace[]>('list_agent_traces', { requestId })
  },

  /**
   * 清理 Agent 轨迹
   * @param requestId 传入则清指定会话，不传清全部
   * @returns 删除条数
   */
  async clearTraces(requestId?: string): Promise<number> {
    return typedInvoke<number>('clear_agent_traces', { requestId: requestId ?? null })
  },
}

// ==================== 图片处理 ====================

export const imageApi = {
  /** 处理图片：压缩 + 缩放 + Base64 编码，返回 data: URL */
  async process(sourcePath: string, maxWidth = 1200, quality = 80): Promise<string> {
    return typedInvoke<string>('process_image', { sourcePath, maxWidth, quality })
  },

  /** 裁剪图片：裁剪 + 压缩 + 缩放 + Base64 编码，返回 data: URL */
  async processCropped(
    sourcePath: string,
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number,
    maxWidth = 1200,
    quality = 80,
  ): Promise<string> {
    return typedInvoke<string>('process_image_cropped', {
      sourcePath,
      cropX: Math.round(cropX),
      cropY: Math.round(cropY),
      cropW: Math.round(cropW),
      cropH: Math.round(cropH),
      maxWidth,
      quality,
    })
  },
}

// ==================== 导入导出 ====================

export type ImportStrategy = 'replace' | 'merge' | 'fill-gaps'

/** 单表写入统计 */
export interface TableWriteStats {
  inserted: number
  updated: number
  skipped: number
}

/** merge / fill-gaps 导入报告（各表统计） */
export type ImportWriteStats = Record<string, TableWriteStats>

/** import_backup 统一返回（replace：rollbackTs；merge/fill-gaps：stats） */
export interface ImportBackupResult {
  cache: unknown
  backupType: string
  strategy?: ImportStrategy
  rollbackTs?: string | null
  stats?: ImportWriteStats
}

/** 单表行级对账分类（Spec §5.5） */
export interface RowReconcile {
  matched: number
  targetStale: number
  targetNewer: number
  missing: number
}

/** 逐表对账汇总 */
export interface ReconcileReport {
  books: RowReconcile
  volumes: RowReconcile
  chapters: RowReconcile
  snapshots: RowReconcile
  worldCards: RowReconcile
}

/** inspect_backup 只读预检报告（①文件 → ②解密 → ③结构/引用 → ④幂等 → ⑤对账） */
export interface BackupInspectReport {
  ok: boolean
  backupType: 'full' | 'single'
  fileName: string
  fileSizeBytes: number
  counts: {
    books: number
    volumes: number
    chapters: number
    snapshots: number
    worldCards: number
    embeddings: number
  }
  singleBook: { id: string; title: string } | null
  issues: string[]
  /** v2 内容指纹（SHA-256）；v1 旧文件为 null */
  payloadHash: string | null
  /** 幂等判定：该文件曾于何时导入（同指纹 + 类型 + 大小命中 import_log） */
  duplicateOf: { importedAt: string; fileName: string } | null
  /** 备份各行 vs 目标库的对账清单 */
  reconcile: ReconcileReport
}

/** 格式导出进度事件（Spec §7：export-progress 事件载荷） */
export interface ExportProgress {
  bookId: string
  format: string
  phase: string
  done: number
  total: number
}

export const importExportApi = {
  async exportBook(bookId: string, format: 'txt' | 'md' | 'html', outputPath: string): Promise<void> {
    return typedInvoke<void>('export_book', { bookId, format, outputPath })
  },

  /** 取消进行中的格式导出（幂等，无导出时无副作用） */
  async cancelBookExport(): Promise<void> {
    return typedInvoke<void>('cancel_book_export')
  },

  /** TXT 导入结果（Spec §6.3：去重后计数，前端据此提示） */
  async importTxt(
    bookId: string,
    filePath: string,
  ): Promise<{ chaptersCreated: number; chaptersSkipped: number; chaptersRenamed: number }> {
    return typedInvoke<{ chaptersCreated: number; chaptersSkipped: number; chaptersRenamed: number }>(
      'import_txt',
      { bookId, filePath },
    )
  },

  /** 导出全部数据（数据库 + localStorage 缓存）到 JSON 文件 */
  async exportAllData(outputPath: string, cacheJson: string): Promise<void> {
    return typedInvoke<void>('export_all_data', { outputPath, cacheJson })
  },

  /** 导出单个作品的完整数据（数据库 + localStorage 缓存）到加密 .tw 文件 */
  async exportSingleBook(bookId: string, outputPath: string, cacheJson: string): Promise<void> {
    return typedInvoke<void>('export_single_book', { bookId, outputPath, cacheJson })
  },

  /**
   * 统一导入备份文件（自动根据 backupType 选择全量/单作品导入）。
   * strategy：replace（默认，清空重建 + 可回退）/ merge（择优合并，保留目标新增）/
   * fill-gaps（仅补缺）。merge / fill-gaps 返回 stats。
   */
  async importBackup(filePath: string, strategy?: ImportStrategy): Promise<ImportBackupResult> {
    return typedInvoke<ImportBackupResult>('import_backup', { filePath, strategy })
  },

  /** 只读预检备份文件（结构/行数/引用完整性，不写库），返回报告 */
  async inspectBackup(filePath: string): Promise<BackupInspectReport> {
    return typedInvoke<BackupInspectReport>('inspect_backup', { filePath })
  },

  /** 撤销一次导入：把数据库恢复至该回退点快照（导入前状态，24h 内有效，执行后回退点即消费） */
  async rollbackImport(ts: string): Promise<{
    rolledBack: boolean
    ts: string
    scope: string
    file_name: string
    restored: Record<string, number>
  }> {
    return invoke('rollback_import', { ts })
  },
}

// ==================== 调试控制台 ====================

export interface LogEntry {
  timestamp: string
  level: string
  message: string
  file?: string
  fileName?: string
  line?: number
}

/** 数据库校验 — 单条问题 */
export interface ValidationIssue {
  table: string
  column?: string
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
    return typedInvoke<void>('open_debug_window')
  },

  /** 关闭调试控制台窗口 */
  async close(): Promise<void> {
    return typedInvoke<void>('close_debug_window')
  },

  /** 获取所有已缓存的日志（调试窗口启动时调用） */
  async getLogs(): Promise<LogEntry[]> {
    return typedInvoke<LogEntry[]>('get_debug_logs')
  },

  /** 清空所有日志 */
  async clear(): Promise<void> {
    return typedInvoke<void>('clear_debug_logs')
  },

  /** 校验本地 SQLite 数据库表结构和数据完整性 */
  async validateDatabase(): Promise<ValidationResult> {
    return typedInvoke<ValidationResult>('validate_database')
  },

  /** 将前端日志汇入后端日志系统 */
  async logMessage(entries: { level: string; message: string; file?: string | null; fileName?: string | null; line?: number | null }[]): Promise<void> {
    return typedInvoke<void>('log_message', { entries })
  },
}

// ==================== 系统检查 ====================

export interface SystemCheckItem {
  name: string
  value: string
  status: string // "ok" | "warning" | "error"
  detail?: string | null
}

export interface SystemCheckResult {
  items: SystemCheckItem[]
  ok: boolean
}

export const systemApi = {
  /** 执行系统环境检查（Python/Node/Rust 版本、系统信息、安装路径） */
  async check(): Promise<SystemCheckResult> {
    return typedInvoke<SystemCheckResult>('system_check')
  },
}

// ==================== 英语生词本（vocabApi） ====================

export const vocabApi = {
  /** 收录生词（同词已存在时更新释义并返回） */
  async add(args: AddVocabWordArgs): Promise<VocabWord> {
    return typedInvoke<VocabWord>('vocab_add', { args })
  },

  /** 编辑生词音标/释义/例句 */
  async update(args: UpdateVocabWordArgs): Promise<VocabWord> {
    return typedInvoke<VocabWord>('vocab_update', { args })
  },

  /** 切换状态（learning / mastered / suspended） */
  async setStatus(id: string, status: VocabWord['status']): Promise<VocabWord> {
    return typedInvoke<VocabWord>('vocab_set_status', { id, status })
  },

  /** 删除生词（复习记录级联删除） */
  async delete(id: string): Promise<void> {
    return typedInvoke<void>('vocab_delete', { id })
  },

  /** 列表（status: all/learning/mastered/suspended；query 单词模糊搜索） */
  async list(status?: string, query?: string): Promise<VocabWord[]> {
    return typedInvoke<VocabWord[]>('vocab_list', { status: status ?? null, query: query ?? null })
  },

  /** 今日到期复习队列 */
  async due(): Promise<VocabWord[]> {
    return typedInvoke<VocabWord[]>('vocab_due')
  },

  /** 单条详情 */
  async get(id: string): Promise<VocabWord> {
    return typedInvoke<VocabWord>('vocab_get', { id })
  },

  /** 提交复习反馈（0 忘记 / 1 模糊 / 2 记得 / 3 轻松），返回更新后的词条 */
  async review(wordId: string, rating: 0 | 1 | 2 | 3): Promise<VocabWord> {
    return typedInvoke<VocabWord>('vocab_review', { wordId, rating })
  },

  /** 某生词的复习历史 */
  async logs(wordId: string): Promise<VocabReviewLog[]> {
    return typedInvoke<VocabReviewLog[]>('vocab_logs', { wordId })
  },

  /** 生词本统计 */
  async stats(): Promise<VocabStats> {
    return typedInvoke<VocabStats>('vocab_stats')
  },
}

// ==================== TTS 朗读（豆包语音合成 seed-tts） ====================

export const ttsApi = {
  /**
   * 朗读文本：后端调用豆包语音合成（seed-tts）合成 MP3 并缓存到本地（幂等），返回文件路径
   */
  async speak(text: string, apiKey: string, speaker?: string): Promise<TtsSpeakResult> {
    return typedInvoke<TtsSpeakResult>('tts_speak', {
      args: {
        text,
        apiKey,
        speaker: speaker || null,
      },
    })
  },
}

// ==================== 英语字典（离线词库 + AI 释义） ====================

export const dictApi = {
  /** 离线词典状态（是否已安装 ECDICT 词库） */
  async status(): Promise<DictStatus> {
    return typedInvoke<DictStatus>('dict_status')
  },

  /** 导入离线词典文件（ECDICT sqlite） */
  async import(sourcePath: string): Promise<DictStatus> {
    return typedInvoke<DictStatus>('dict_import', { sourcePath })
  },

  /** 离线查词（精确命中 + 前缀建议） */
  async lookup(word: string): Promise<DictLookupResult> {
    return typedInvoke<DictLookupResult>('dict_lookup', { word })
  },

  /** AI 兜底释义（DeepSeek，需已配置 AI） */
  async explainAi(args: ExplainWordArgs): Promise<AiWordExplain> {
    return typedInvoke<AiWordExplain>('dict_explain_ai', { args })
  },

  /** AI 单词形态检查（轻量模型判定：完整单词 / 简写 / 缩写 / 不存在） */
  async checkWord(args: ExplainWordArgs): Promise<WordCheckResult> {
    return typedInvoke<WordCheckResult>('check_word_ai', { args })
  },
}

// ==================== 任务卡 · 个人项目管理 ====================

export const taskCardApi = {
  // ── 项目 ──
  /** 列出项目（可按状态过滤），含实时统计 */
  async listProjects(status?: ProjectStatus | null): Promise<ProjectView[]> {
    return typedInvoke<ProjectView[]>('project_list', { status: status ?? null })
  },
  /** 获取单个项目（含统计） */
  async getProject(id: string): Promise<ProjectView> {
    return typedInvoke<ProjectView>('project_get', { id })
  },
  /** 创建项目 */
  async createProject(args: CreateProjectArgs): Promise<TaskProject> {
    return typedInvoke<TaskProject>('project_create', { args })
  },
  /** 更新项目（部分更新） */
  async updateProject(id: string, args: UpdateProjectArgs): Promise<TaskProject> {
    return typedInvoke<TaskProject>('project_update', { id, args })
  },
  /** 软删除项目（连带任务进入回收站） */
  async deleteProject(id: string): Promise<void> {
    return typedInvoke<void>('project_delete', { id })
  },
  /** 恢复项目（连带任务） */
  async restoreProject(id: string): Promise<void> {
    return typedInvoke<void>('project_restore', { id })
  },
  /** 彻底删除项目 */
  async hardDeleteProject(id: string): Promise<void> {
    return typedInvoke<void>('project_hard_delete', { id })
  },
  /** 列出回收站中的项目 */
  async listDeletedProjects(): Promise<TaskProject[]> {
    return typedInvoke<TaskProject[]>('project_list_deleted')
  },
  /** 清空项目回收站 */
  async clearProjectTrash(): Promise<number> {
    return typedInvoke<number>('project_clear_trash')
  },

  // ── 任务 ──
  /** 列出某项目全部任务（含标签） */
  async listTasks(projectId: string): Promise<TaskCard[]> {
    return typedInvoke<TaskCard[]>('task_list', { projectId })
  },
  /** 列出全部未删除任务（跨项目） */
  async listAllTasks(): Promise<TaskCard[]> {
    return typedInvoke<TaskCard[]>('task_list_all')
  },
  /** 获取单个任务 */
  async getTask(id: string): Promise<TaskCard> {
    return typedInvoke<TaskCard>('task_get', { id })
  },
  /** 创建任务 */
  async createTask(args: CreateTaskArgs): Promise<TaskCard> {
    return typedInvoke<TaskCard>('task_create', { args })
  },
  /** 更新任务（部分更新） */
  async updateTask(id: string, args: UpdateTaskArgs): Promise<TaskCard> {
    return typedInvoke<TaskCard>('task_update', { id, args })
  },
  /** 状态切换 / 勾选完成 / 重新打开；勾选完成可携带富文本总结（HTML，空串=清空，null=不改动） */
  async setTaskStatus(id: string, status: TaskStatus, completionSummary: string | null = null): Promise<TaskCard> {
    return typedInvoke<TaskCard>('task_set_status', { id, status, completionSummary })
  },
  /** 看板拖拽：跨列改状态 + 按目标列最终顺序重排 */
  async dragTask(id: string, toStatus: TaskStatus, orderedIds: string[]): Promise<void> {
    return typedInvoke<void>('task_drag', { id, toStatus, orderedIds })
  },
  /** 复制任务 */
  async copyTask(id: string): Promise<TaskCard> {
    return typedInvoke<TaskCard>('task_copy', { id })
  },
  /** 移动任务到其他项目 */
  async moveTaskToProject(id: string, toProjectId: string): Promise<TaskCard> {
    return typedInvoke<TaskCard>('task_move_to_project', { id, toProjectId })
  },
  /** 软删除任务 */
  async deleteTask(id: string): Promise<void> {
    return typedInvoke<void>('task_delete', { id })
  },
  /** 恢复任务 */
  async restoreTask(id: string): Promise<void> {
    return typedInvoke<void>('task_restore', { id })
  },
  /** 彻底删除任务 */
  async hardDeleteTask(id: string): Promise<void> {
    return typedInvoke<void>('task_hard_delete', { id })
  },
  /** 列出回收站中的任务（含所属项目名） */
  async listDeletedTasks(): Promise<DeletedTaskItem[]> {
    return typedInvoke<DeletedTaskItem[]>('task_list_deleted')
  },
  /** 清空任务回收站 */
  async clearTaskTrash(): Promise<number> {
    return typedInvoke<number>('task_clear_trash')
  },
  /** 回收站自动清理（硬删删除超 30 天的任务与项目），返回清理条数 */
  async purgeExpiredTrash(): Promise<number> {
    return typedInvoke<number>('task_purge_expired_trash')
  },

  // ── 子任务 ──
  /** 列出某任务全部子任务 */
  async listSubtasks(taskId: string): Promise<TaskSubtask[]> {
    return typedInvoke<TaskSubtask[]>('subtask_list', { taskId })
  },
  /** 创建子任务 */
  async createSubtask(taskId: string, title: string): Promise<TaskSubtask> {
    return typedInvoke<TaskSubtask>('subtask_create', { taskId, title })
  },
  /** 重命名子任务 */
  async updateSubtask(id: string, title: string): Promise<TaskSubtask> {
    return typedInvoke<TaskSubtask>('subtask_update', { id, title })
  },
  /** 勾选 / 取消完成 */
  async setSubtaskDone(id: string, done: boolean): Promise<TaskSubtask> {
    return typedInvoke<TaskSubtask>('subtask_set_done', { id, done })
  },
  /** 删除子任务 */
  async deleteSubtask(id: string): Promise<void> {
    return typedInvoke<void>('subtask_delete', { id })
  },

  // ── 任务模板 ──
  /** 列出全部模板 */
  async listTemplates(): Promise<TaskTemplate[]> {
    return typedInvoke<TaskTemplate[]>('template_list')
  },
  /** 创建模板 */
  async createTemplate(args: CreateTemplateArgs): Promise<TaskTemplate> {
    return typedInvoke<TaskTemplate>('template_create', { args })
  },
  /** 更新模板 */
  async updateTemplate(id: string, args: UpdateTemplateArgs): Promise<TaskTemplate> {
    return typedInvoke<TaskTemplate>('template_update', { id, args })
  },
  /** 删除模板 */
  async deleteTemplate(id: string): Promise<void> {
    return typedInvoke<void>('template_delete', { id })
  },
  /** 一键套用模板创建任务 */
  async createTaskFromTemplate(
    templateId: string,
    projectId: string,
    dueTime?: string,
  ): Promise<TaskCard> {
    return typedInvoke<TaskCard>('task_create_from_template', { templateId, projectId, dueTime })
  },

  // ── 附件 ──
  /** 列出某任务的附件 */
  async listAttachments(taskId: string): Promise<Attachment[]> {
    return typedInvoke<Attachment[]>('attachment_list', { taskId })
  },
  /** 系统对话框选择文件并添加为附件；取消返回 null */
  async pickAndAddAttachment(taskId: string): Promise<Attachment | null> {
    return typedInvoke<Attachment | null>('attachment_pick_and_add', { taskId })
  },
  /** 用系统默认应用打开附件 */
  async openAttachment(id: string): Promise<void> {
    return typedInvoke<void>('attachment_open', { id })
  },
  /** 删除附件（记录 + 文件） */
  async deleteAttachment(id: string): Promise<void> {
    return typedInvoke<void>('attachment_delete', { id })
  },

  // ── 操作日志 ──
  /** 某任务的动态时间线（最新在前） */
  async listTaskActivity(taskId: string, limit?: number): Promise<ActivityLog[]> {
    return typedInvoke<ActivityLog[]>('activity_list_task', { taskId, limit })
  },
  /** 某项目的动态时间线（最新在前） */
  async listProjectActivity(projectId: string, limit?: number): Promise<ActivityLog[]> {
    return typedInvoke<ActivityLog[]>('activity_list_project', { projectId, limit })
  },
  /** 项目近 N 周新增/完成统计（默认 8 周） */
  async projectWeeklyStats(projectId: string, weeks?: number): Promise<ProjectWeeklyStat[]> {
    return typedInvoke<ProjectWeeklyStat[]>('project_weekly_stats', { projectId, weeks })
  },

  // ── 今日任务 ──
  /** 「计划今日」滚动清理（自然日切换后调用） */
  async rollPlannedToday(): Promise<number> {
    return typedInvoke<number>('task_roll_planned_today')
  },
  /** 今日任务概览 */
  async todayOverview(): Promise<TodayOverview> {
    return typedInvoke<TodayOverview>('task_today_overview')
  },

  // ── 标签 ──
  /** 列出全部标签 */
  async listTags(): Promise<TaskTag[]> {
    return typedInvoke<TaskTag[]>('tag_list')
  },
  /** 创建标签 */
  async createTag(name: string, color: string): Promise<TaskTag> {
    return typedInvoke<TaskTag>('tag_create', { name, color })
  },
  /** 更新标签 */
  async updateTag(id: string, args: UpdateTagArgs): Promise<TaskTag> {
    return typedInvoke<TaskTag>('tag_update', { id, args })
  },
  /** 删除标签（返回被移除的关联数） */
  async deleteTag(id: string): Promise<number> {
    return typedInvoke<number>('tag_delete', { id })
  },

  // ── 设置（key-value / 提醒偏好） ──
  /** 读取任意 key */
  async getMeta(key: string): Promise<string | null> {
    return typedInvoke<string | null>('task_meta_get', { key })
  },
  /** 写入任意 key */
  async setMeta(key: string, value: string): Promise<void> {
    return typedInvoke<void>('task_meta_set', { key, value })
  },
  /** 读取提醒偏好（JSON） */
  async getReminderPrefs(): Promise<string | null> {
    return typedInvoke<string | null>('reminder_prefs_get')
  },
  /** 保存提醒偏好（JSON 整体覆盖） */
  async setReminderPrefs(json: string): Promise<void> {
    return typedInvoke<void>('reminder_prefs_set', { json })
  },
  /** 手动触发一次到期/逾期提醒扫描（调试用），返回发送条数 */
  async reminderCheck(): Promise<number> {
    return typedInvoke<number>('reminder_check')
  },

  // ── 个人日程迁移 ──
  /** 执行个人日程 → 任务卡迁移（幂等） */
  async migrateSchedules(): Promise<MigrateResult> {
    return typedInvoke<MigrateResult>('migrate_schedules')
  },
}

// ==================== 写作统计（Phase 4 问题 24） ====================

/** 单日写作量（对齐 Rust DailyWords） */
export interface WritingDailyPoint {
  date: string
  words: number
}

/** 写作统计聚合（对齐 Rust WritingStats） */
export interface WritingStatsPayload {
  dailyTarget: number
  todayWords: number
  streakDays: number
  lastDays: WritingDailyPoint[]
}

export const writingApi = {
  /** 获取书籍写作统计（今日字数 / 连续天数 / 近 30 日曲线） */
  async getWritingStats(bookId: string): Promise<WritingStatsPayload> {
    return typedInvoke<WritingStatsPayload>('get_writing_stats', { bookId })
  },
}
