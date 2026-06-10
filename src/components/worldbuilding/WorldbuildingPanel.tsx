/**
 * WorldbuildingPanel — 世界观资料库面板
 *
 * 两个标签页：
 * - 「设定」：管理书籍的世界观卡片（6 种类型过滤/搜索/虚拟化滚动）
 * - 「大纲」：作品总体大纲输入 + 各章节大纲列表
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { PlusIcon, SearchIcon, XIcon, ChevronDownIcon, ChevronRightIcon, GripHorizontalIcon } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { worldCardApi, chapterApi, volumeApi, bookApi } from '@/lib/tauri-bridge'
import type { WorldCard, WorldCardType, Chapter, Volume, Book } from '@/types'
import { WORLD_CARD_TYPE_CONFIG, cn } from '@/lib/utils'
import WorldCardEditor from './WorldCardEditor'

interface WorldbuildingPanelProps {
  bookId: string
}

type TabKey = 'cards' | 'outline'

/** 大纲输入框最小/最大高度 */
const MIN_OUTLINE_HEIGHT = 80
const MAX_OUTLINE_HEIGHT = 400

export default function WorldbuildingPanel({ bookId }: WorldbuildingPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('cards')

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

  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set())
  // 章节大纲编辑缓存
  const [chapterOutlines, setChapterOutlines] = useState<Record<string, string>>({})
  const chapterOutlineTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

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
    } catch (err) {
      console.error('加载大纲数据失败', err)
    }
  }

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
                              <span className="text-xs text-muted-foreground flex-shrink-0">
                                {chapterOutlines[ch.id]?.trim()
                                  ? '已有大纲'
                                  : '暂无大纲'}
                              </span>
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
