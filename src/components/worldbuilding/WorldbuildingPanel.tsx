/**
 * WorldbuildingPanel — 世界观资料库面板
 *
 * 两个标签页：
 * - 「设定」：管理书籍的世界观卡片（6 种类型过滤/搜索/虚拟化滚动）
 * - 「大纲」：作品总体大纲输入 + 各章节大纲列表
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { PlusIcon, SearchIcon, XIcon, ChevronDownIcon, ChevronRightIcon, GripHorizontalIcon, Loader2Icon, SparklesIcon, RefreshCwIcon, InfoIcon, Trash2Icon } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { worldCardApi, chapterApi, volumeApi, bookApi, aiApi } from '@/lib/tauri-bridge'
import type { SummarizeArgs } from '@/lib/tauri-bridge'
import type { WorldCard, WorldCardType, Chapter, Volume, Book } from '@/types'
import { WORLD_CARD_TYPE_CONFIG, cn } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import { getChatApiKey } from '@/types'
import WorldCardEditor from './WorldCardEditor'

interface WorldbuildingPanelProps {
  bookId: string
  /** 初始标签页（独立窗口模式下由 URL 参数指定） */
  initialTab?: 'outline'
}

type TabKey = 'cards' | 'outline'

/** 大纲输入框最小/最大高度 */
const MIN_OUTLINE_HEIGHT = 80
const MAX_OUTLINE_HEIGHT = 400

export default function WorldbuildingPanel({ bookId, initialTab }: WorldbuildingPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab ?? 'cards')

  // ---- 卡片相关状态 ----
  const [cards, setCards] = useState<WorldCard[]>([])
  const [filterType, setFilterType] = useState<WorldCardType | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [editingCard, setEditingCard] = useState<WorldCard | null>(null)
  const [showNewCard, setShowNewCard] = useState(false)

  const parentRef = useRef<HTMLDivElement>(null)

  const filtered = cards
    .filter((c) => filterType === 'all' || c.type === filterType)
    .filter((c) => c.title.includes(searchQuery) || c.content.includes(searchQuery))

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 110,
    overscan: 5,
  })

  // ---- 大纲相关状态 ----
  const [bookOutline, setBookOutline] = useState('')
  const [bookOutlineSaving, setBookOutlineSaving] = useState(false)
  const outlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 作品大纲区域拖拽调整高度
  const [bookOutlineHeight, setBookOutlineHeight] = useState(120)
  const [isDraggingOutline, setIsDraggingOutline] = useState(false)
  const dragStartYRef = useRef(0)
  const dragStartHeightRef = useRef(0)

  const { aiConfig, aiToolCategories } = useAppStore()

  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set())
  // 章节大纲编辑缓存
  const [chapterOutlines, setChapterOutlines] = useState<Record<string, string>>({})
  const chapterOutlineTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // 章节总结缓存与状态
  const [summarizingChapters, setSummarizingChapters] = useState<Set<string>>(new Set())
  const [chapterSummaries, setChapterSummaries] = useState<Record<string, { text: string; at: string }>>({})
  // 最近一次总结请求详情（按章节 ID 缓存，用于详情弹窗）
  const [lastSummaryRequests, setLastSummaryRequests] = useState<Record<string, SummarizeArgs>>({})
  const [showDetailForChapter, setShowDetailForChapter] = useState<string | null>(null)

  useEffect(() => {
    loadCards()
    loadBookOutline()
    loadOutlineData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  // 过滤结果变化时重置滚动位置
  useEffect(() => {
    virtualizer.scrollToOffset(0)
    virtualizer.measure()
  }, [filterType, searchQuery, virtualizer])

  // ---- 卡片方法 ----
  async function loadCards() {
    try {
      const data = await worldCardApi.listByBook(bookId)
      setCards(data)
    } catch (err) {
      console.error('加载世界观卡片失败', err)
    }
  }

  // ---- 大纲方法 ----
  async function loadBookOutline() {
    try {
      const book = await bookApi.getById(bookId)
      setBookOutline(book.outline ?? '')
    } catch {
      // 忽略加载错误
    }
  }

  async function saveBookOutline(value: string) {
    setBookOutline(value)
    setBookOutlineSaving(true)
    try {
      await bookApi.update(bookId, { outline: value } as Partial<Book>)
    } catch (err) {
      console.error('保存作品大纲失败', err)
    } finally {
      setBookOutlineSaving(false)
    }
  }

  function handleBookOutlineChange(value: string) {
    setBookOutline(value)
    if (outlineTimerRef.current) clearTimeout(outlineTimerRef.current)
    outlineTimerRef.current = setTimeout(() => saveBookOutline(value), 600)
  }

  async function loadOutlineData() {
    try {
      const [volList, chList] = await Promise.all([
        volumeApi.listByBook(bookId),
        chapterApi.listByBook(bookId),
      ])
      setVolumes(volList)
      setChapters(chList)
      // 初始化章节大纲缓存
      const init: Record<string, string> = {}
      chList.forEach((ch) => { init[ch.id] = ch.outline ?? '' })
      setChapterOutlines(init)
      // 初始化章节总结缓存（从已加载数据中提取）
      const summaries: Record<string, { text: string; at: string }> = {}
      chList.forEach((ch) => {
        if (ch.summary) {
          summaries[ch.id] = { text: ch.summary, at: ch.summaryAt ?? '' }
        }
      })
      setChapterSummaries(summaries)
    } catch (err) {
      console.error('加载大纲数据失败', err)
    }
  }

  /** 清除章节总结（数据库 + 所有本地缓存） */
  const handleClearSummary = useCallback(async (chapterId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      await chapterApi.clearSummary(chapterId)
      // 清除总结缓存
      setChapterSummaries((prev) => {
        const next = { ...prev }
        delete next[chapterId]
        return next
      })
      // 清除请求详情缓存
      setLastSummaryRequests((prev) => {
        const next = { ...prev }
        delete next[chapterId]
        return next
      })
      // 同步清除 chapters state 中的 summary，防止 fallback 残留
      setChapters((prev) =>
        prev.map((c) =>
          c.id === chapterId
            ? { ...c, summary: undefined as unknown as string, summaryAt: undefined as unknown as string }
            : c,
        ),
      )
    } catch (err) {
      console.error('清除章节总结失败:', err)
    }
  }, [])

  /** 为指定章节生成 AI 总结并缓存 */
  const handleChapterSummary = useCallback(async (chapterId: string, chapterTitle: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (summarizingChapters.has(chapterId)) return

    try {
      // 加载章节内容，验证实际字数
      const contentHtml = await chapterApi.getContent(chapterId)
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = contentHtml
      const plainText = (tempDiv.textContent || tempDiv.innerText || '').trim()

      if (plainText.length < 300) {
        console.warn('章节内容不足 300 字，跳过总结')
        return
      }

      const apiKey = getChatApiKey(aiConfig.chat)
      if (!apiKey) {
        console.error('未配置 AI API Key，无法生成总结')
        return
      }

      setSummarizingChapters((prev) => new Set(prev).add(chapterId))

      const allTools = aiToolCategories.flatMap((c) => c.tools)
      const systemPrompt = allTools.find((p) => p.name === '章节总结')?.systemPrompt ?? ''

      const summarizeArgs: SummarizeArgs = {
        endpoint: aiConfig.chat.endpoint,
        model: aiConfig.chat.model,
        apiKey,
        temperature: aiConfig.chat.temperature,
        maxTokens: aiConfig.chat.maxTokens,
        chapterTitle,
        chapterContent: plainText.slice(0, 8000),
        thinkingEnabled: aiConfig.chat.thinkingEnabled,
        systemPrompt: systemPrompt.trim() || undefined,
      }

      setLastSummaryRequests((prev) => ({ ...prev, [chapterId]: summarizeArgs }))

      const result = await aiApi.summarizeChapter(summarizeArgs)

      // 持久化到数据库
      await chapterApi.saveSummary(chapterId, result.summary)
      // 更新本地缓存
      setChapterSummaries((prev) => ({
        ...prev,
        [chapterId]: { text: result.summary, at: new Date().toISOString() },
      }))
    } catch (err) {
      console.error('生成章节总结失败:', err)
    } finally {
      setSummarizingChapters((prev) => {
        const next = new Set(prev)
        next.delete(chapterId)
        return next
      })
    }
  }, [summarizingChapters, aiConfig, aiToolCategories])

  async function saveChapterOutline(chapterId: string, outline: string) {
    try {
      await chapterApi.saveOutline(chapterId, outline)
    } catch (err) {
      console.error('保存章节大纲失败', err)
    }
  }

  function handleChapterOutlineChange(chapterId: string, value: string) {
    setChapterOutlines((prev) => ({ ...prev, [chapterId]: value }))
    if (chapterOutlineTimerRef.current[chapterId]) {
      clearTimeout(chapterOutlineTimerRef.current[chapterId])
    }
    chapterOutlineTimerRef.current[chapterId] = setTimeout(
      () => saveChapterOutline(chapterId, value),
      600,
    )
  }

  // ---- 大纲区域拖拽 ----
  const handleOutlineDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDraggingOutline(true)
    dragStartYRef.current = e.clientY
    dragStartHeightRef.current = bookOutlineHeight
  }, [bookOutlineHeight])

  useEffect(() => {
    if (!isDraggingOutline) return

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - dragStartYRef.current
      const newHeight = Math.min(MAX_OUTLINE_HEIGHT, Math.max(MIN_OUTLINE_HEIGHT, dragStartHeightRef.current + delta))
      setBookOutlineHeight(newHeight)
    }

    const handleMouseUp = () => setIsDraggingOutline(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDraggingOutline])

  // 按卷分组章节
  const chaptersByVolume = (() => {
    const result: { volume: Volume | null; chapters: Chapter[] }[] = []
    // 无卷章节
    const noVol = chapters.filter((ch) => !ch.volumeId)
    if (noVol.length > 0) {
      result.push({ volume: null, chapters: noVol })
    }
    // 有卷分组
    volumes.forEach((vol) => {
      const volChapters = chapters.filter((ch) => ch.volumeId === vol.id)
      if (volChapters.length > 0) {
        result.push({ volume: vol, chapters: volChapters })
      }
    })
    return result
  })()

  return (
    <div className="flex flex-col h-full">
      {/* 标签栏 */}
      <div className="flex items-center border-b px-3">
        <button
          onClick={() => setActiveTab('cards')}
          className={cn(
            'px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-[1px]',
            activeTab === 'cards'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          设定
        </button>
        <button
          onClick={() => setActiveTab('outline')}
          className={cn(
            'px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-[1px]',
            activeTab === 'outline'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          大纲
        </button>
        {/* 卡片模式下才显示新建按钮 */}
        {activeTab === 'cards' && (
          <div className="flex-1 flex items-center justify-end">
            <button
              onClick={() => setShowNewCard(true)}
              className="p-1 rounded hover:bg-muted text-muted-foreground"
            >
              <PlusIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 卡片标签页 */}
      {activeTab === 'cards' && (
        <>
          {/* 搜索 */}
          <div className="px-3 py-2">
            <div className="relative">
              <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索设定…"
                className="w-full pl-7 pr-3 py-1.5 text-xs bg-muted rounded-lg outline-none focus:ring-1 focus:ring-ring"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <XIcon className="w-3 h-3 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>

          {/* 类型过滤标签 */}
          <div className="flex gap-1 px-3 py-2 overflow-x-auto scrollbar-none flex-shrink-0">
            <FilterTag active={filterType === 'all'} onClick={() => setFilterType('all')}>全部</FilterTag>
            {(Object.keys(WORLD_CARD_TYPE_CONFIG) as WorldCardType[]).map((type) => (
              <FilterTag key={type} active={filterType === type} onClick={() => setFilterType(type)}>
                {WORLD_CARD_TYPE_CONFIG[type].icon} {WORLD_CARD_TYPE_CONFIG[type].label}
              </FilterTag>
            ))}
          </div>

          {/* 虚拟化卡片列表 */}
          <div ref={parentRef} className="flex-1 overflow-y-auto px-3 pb-3">
            {filtered.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">
                {searchQuery ? '无匹配结果' : '还没有设定，点击 + 新建'}
              </div>
            ) : (
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((vItem) => {
                  const card = filtered[vItem.index]
                  return (
                    <div
                      key={card.id}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${vItem.size}px`,
                        transform: `translateY(${vItem.start}px)`,
                      }}
                    >
                      <div
                        onClick={() => setEditingCard(card)}
                        className="p-3 rounded-lg border bg-card hover:border-primary/40 cursor-pointer transition-colors"
                        style={{ marginBottom: '8px' }}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm">{WORLD_CARD_TYPE_CONFIG[card.type].icon}</span>
                          <span className="text-sm font-medium truncate">{card.title}</span>
                        </div>
                        {card.content && (
                          <p className="text-xs text-muted-foreground line-clamp-2">{card.content}</p>
                        )}
                        {card.tags.length > 0 && (
                          <div className="flex gap-1 mt-2 flex-wrap">
                            {card.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="text-xs bg-muted px-1.5 py-0.5 rounded-full">{tag}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 新建/编辑弹窗 */}
          {(showNewCard || editingCard) && (
            <WorldCardEditor
              bookId={bookId}
              card={editingCard}
              onClose={() => { setShowNewCard(false); setEditingCard(null) }}
              onSaved={loadCards}
            />
          )}
        </>
      )}

      {/* 大纲标签页 */}
      {activeTab === 'outline' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* 作品大纲 */}
          <div className="px-3 pt-3 pb-1 flex-shrink-0">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">作品大纲</span>
              {bookOutlineSaving && (
                <span className="text-xs text-muted-foreground">保存中…</span>
              )}
            </div>
            <textarea
              value={bookOutline}
              onChange={(e) => handleBookOutlineChange(e.target.value)}
              placeholder="在这里书写整部作品的故事大纲…"
              style={{ height: `${bookOutlineHeight}px` }}
              className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none"
            />
            {/* 拖拽调整手柄 */}
            <div
              onMouseDown={handleOutlineDragStart}
              className="flex items-center justify-center h-5 cursor-ns-resize rounded-b-lg hover:bg-muted/60 transition-colors group -mt-0.5"
            >
              <GripHorizontalIcon className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors" />
            </div>
          </div>

          {/* 分隔 */}
          <div className="border-b mx-3 my-2" />

          {/* 章节大纲 */}
          <div className="px-3 pb-1 flex-shrink-0">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">章节大纲</span>
          </div>

          <div className="flex-1 overflow-y-auto px-3 pb-3">
            {chaptersByVolume.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">
                暂无章节，请先在编辑器中创建章节
              </div>
            ) : (
              <div className="space-y-3">
                {chaptersByVolume.map(({ volume, chapters: volChapters }) => (
                  <div key={volume?.id ?? 'root'}>
                    {/* 卷标题 */}
                    {volume && (
                      <div className="text-xs font-medium text-muted-foreground mb-1.5 pl-1">
                        {volume.title}
                      </div>
                    )}
                    {/* 章节列表 */}
                    <div className="space-y-1.5">
                      {volChapters.map((ch) => {
                        const isExpanded = expandedChapters.has(ch.id)
                        const summaryInfo = chapterSummaries[ch.id] ??
                          (ch.summary ? { text: ch.summary, at: ch.summaryAt ?? '' } : null)
                        const isSummarizing = summarizingChapters.has(ch.id)
                        const wordTooFew = (ch.wordCount ?? 0) < 300 && !summaryInfo
                        return (
                          <div key={ch.id} className="rounded-lg border bg-card">
                            {/* 章节标题栏 */}
                            <button
                              onClick={() =>
                                setExpandedChapters((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(ch.id)) next.delete(ch.id)
                                  else next.add(ch.id)
                                  return next
                                })
                              }
                              className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-lg"
                            >
                              {isExpanded ? (
                                <ChevronDownIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                              ) : (
                                <ChevronRightIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                              )}
                              <span className="text-sm truncate flex-1">{ch.title}</span>
                              {/* 大纲状态 */}
                              <span className="text-xs text-muted-foreground flex-shrink-0 mr-1">
                                {chapterOutlines[ch.id]?.trim()
                                  ? '已有大纲'
                                  : '暂无大纲'}
                              </span>
                              {/* 总结状态 / 操作按钮 */}
                              {isSummarizing ? (
                                <span className="text-xs text-blue-500 flex items-center gap-1 flex-shrink-0">
                                  <Loader2Icon className="w-3 h-3 animate-spin" />
                                  总结中
                                </span>
                              ) : summaryInfo ? (
                                <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1 flex-shrink-0">
                                  ✓ 已总结
                                </span>
                              ) : wordTooFew ? (
                                <span className="text-xs text-muted-foreground/40 flex-shrink-0">内容较少</span>
                              ) : (
                                <button
                                  onClick={(e) => handleChapterSummary(ch.id, ch.title, e)}
                                  className="text-xs text-primary hover:underline flex items-center gap-0.5 flex-shrink-0"
                                >
                                  <SparklesIcon className="w-3 h-3" />
                                  总结
                                </button>
                              )}
                            </button>
                            {/* 展开大纲编辑区 */}
                            {isExpanded && (
                              <div className="px-3 pb-3 pt-0">
                                <textarea
                                  value={chapterOutlines[ch.id] ?? ''}
                                  onChange={(e) => handleChapterOutlineChange(ch.id, e.target.value)}
                                  placeholder={`为「${ch.title}」书写章节大纲…`}
                                  rows={3}
                                  className="w-full bg-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-none"
                                />
                              </div>
                            )}
                            {/* 已缓存的总结内容（大纲下方） */}
                            {isExpanded && summaryInfo && (
                              <div className="px-3 pb-3">
                                <div className="flex items-center justify-between mb-1.5">
                                  <span className="text-[11px] text-muted-foreground font-medium">
                                    AI 章节总结
                                  </span>
                                  <div className="flex items-center gap-0.5">
                                    <button
                                      onClick={(e) => handleChapterSummary(ch.id, ch.title, e)}
                                      disabled={isSummarizing}
                                      className={cn(
                                        'text-[11px] px-1.5 py-0.5 rounded flex items-center gap-0.5 transition-colors',
                                        isSummarizing
                                          ? 'text-blue-500 bg-blue-500/5 cursor-wait'
                                          : 'text-primary hover:bg-primary/5',
                                      )}
                                    >
                                      {isSummarizing ? (
                                        <Loader2Icon className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <RefreshCwIcon className="w-3 h-3" />
                                      )}
                                      {isSummarizing ? '总结中' : '重新总结'}
                                    </button>
                                    <button
                                      onClick={(e) => handleClearSummary(ch.id, e)}
                                      className="text-[11px] px-1.5 py-0.5 rounded flex items-center gap-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                                    >
                                      <Trash2Icon className="w-3 h-3" />
                                      清除总结
                                    </button>
                                    {lastSummaryRequests[ch.id] && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setShowDetailForChapter(ch.id)
                                        }}
                                        className="text-[11px] px-1.5 py-0.5 rounded flex items-center gap-0.5 text-muted-foreground hover:bg-muted transition-colors"
                                      >
                                        <InfoIcon className="w-3 h-3" />
                                        详情
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div className="text-xs text-muted-foreground bg-muted/60 rounded-lg px-2.5 py-2 max-h-28 overflow-y-auto leading-relaxed whitespace-pre-wrap">
                                  {summaryInfo.text}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 总结请求详情弹窗 */}
      {showDetailForChapter && lastSummaryRequests[showDetailForChapter] && (
        <SummarizeRequestDetailModal
          request={lastSummaryRequests[showDetailForChapter]}
          onClose={() => setShowDetailForChapter(null)}
        />
      )}
    </div>
  )
}

/** 与 Rust 端 summarize_chapter 保持一致的默认 system prompt */
const DEFAULT_SUMMARY_SYSTEM_PROMPT = `你是一位专业的小说创作助手。请仔细阅读以下章节内容，然后进行简洁的总结。

总结要求：
1. 提炼出章节的主要情节、关键事件和重要人物
2. 保留故事的核心脉络和转折点
3. 字数控制在300字以内
4. 使用流畅的段落形式，不要使用列表格式

请直接输出总结内容，不需要任何前缀说明。`

/** 章节总结请求详情弹窗 */
function SummarizeRequestDetailModal({ request, onClose }: { request: SummarizeArgs; onClose: () => void }) {
  const hasCustomPrompt = !!request.systemPrompt
  const effectivePrompt = request.systemPrompt || DEFAULT_SUMMARY_SYSTEM_PROMPT
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 bg-background border rounded-xl shadow-2xl w-[90vw] max-w-2xl max-h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <InfoIcon className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">章节总结请求详情</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">请求参数</h3>
            <div className="bg-muted/50 rounded-lg p-3 text-xs space-y-1.5 font-mono">
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">Endpoint：</span>
                <span className="break-all">{request.endpoint}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">模型：</span>
                <span>{request.model}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">Temperature：</span>
                <span>{request.temperature}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">MaxTokens：</span>
                <span>{request.maxTokens ?? '-'}</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground shrink-0">思考模式：</span>
                <span>{request.thinkingEnabled ? '已启用' : '已关闭'}</span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              System Prompt{hasCustomPrompt ? '（自定义）' : '（系统默认）'}
            </h3>
            <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-amber-100/50 dark:bg-amber-900/20 text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                {hasCustomPrompt ? '自定义总结要求' : '系统默认总结要求'}
              </div>
              <div className="px-3 py-2 text-xs whitespace-pre-wrap break-words bg-amber-50/30 dark:bg-amber-950/20 text-foreground leading-relaxed">
                {effectivePrompt}
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">章节标题</h3>
            <div className="bg-muted/50 rounded-lg p-3 text-xs">
              {request.chapterTitle || <span className="text-muted-foreground/40 italic">（空）</span>}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              提交内容（{request.chapterContent.length} 字）
            </h3>
            <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-amber-100/50 dark:bg-amber-900/20 text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                章节正文内容（截取前 8000 字）
              </div>
              <div className="px-3 py-2 text-xs whitespace-pre-wrap break-words bg-amber-50/30 dark:bg-amber-950/20 text-foreground leading-relaxed max-h-[40vh] overflow-y-auto">
                {request.chapterContent}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 类型过滤标签子组件
 *
 * 高亮当前激活的过滤类型。
 */
function FilterTag({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
      )}
    >
      {children}
    </button>
  )
}
