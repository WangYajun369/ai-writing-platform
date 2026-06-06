/**
 * LibraryPage — 书库管理页面
 *
 * 应用首页，提供：
 * - 多作品网格/列表视图（虚拟化滚动）
 * - 书名/作者搜索与排序
 * - 新建作品弹窗入口
 * - 底部状态栏（作品数、总字数）
 */
import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon, SearchIcon, GridIcon, ListIcon, SettingsIcon, BookOpenIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { bookApi } from '@/lib/tauri-bridge'
import { cn, formatWordCount, formatRelativeTime } from '@/lib/utils'
import type { Book } from '@/types'
import BookCard from '@/components/library/BookCard'
import NewBookDialog from '@/components/library/NewBookDialog'
import { useVirtualizer } from '@tanstack/react-virtual'

type ViewMode = 'grid' | 'list'
type SortBy = 'updatedAt' | 'createdAt' | 'title' | 'wordCount'

/** 不同网格大小对应的列数映射（对应不同容器宽度断点） */
const GRID_COL_MAP = {
  small: { 1280: 6, 1024: 5, 768: 4, 0: 3 },
  medium: { 1280: 5, 1024: 4, 768: 3, 0: 2 },
  large: { 1280: 4, 1024: 3, 768: 2, 0: 1 },
} as const

/** 不同网格大小对应的间距 */
const GRID_GAP_MAP = { small: 'gap-2', medium: 'gap-4', large: 'gap-6' } as const

/** 不同网格大小对应的虚拟化行高预估值 */
const GRID_ROW_HEIGHT_MAP = { small: 260, medium: 340, large: 460 } as const

export default function LibraryPage() {
  const navigate = useNavigate()
  const { books, setBooks, setCurrentBookId, isLoadingBooks, setLoadingBooks, gridSize } = useAppStore()
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [sortBy, setSortBy] = useState<SortBy>('updatedAt')
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewBookDialog, setShowNewBookDialog] = useState(false)

  // 虚拟化滚动容器 ref
  const parentRef = useRef<HTMLDivElement>(null)
  // 网格列数（仅 grid 模式有效）
  const [columnCount, setColumnCount] = useState(4)

  // 监听容器宽度，根据 gridSize 计算网格列数
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        if (viewMode !== 'grid') return
        const thresholds = GRID_COL_MAP[gridSize]
        if (w >= 1280) setColumnCount(thresholds[1280])
        else if (w >= 1024) setColumnCount(thresholds[1024])
        else if (w >= 768) setColumnCount(thresholds[768])
        else setColumnCount(thresholds[0])
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [viewMode, gridSize])

  async function loadBooks() {
    setLoadingBooks(true)
    try {
      const data = await bookApi.list()
      setBooks(data)
    } catch (err) {
      console.error('加载书籍失败', err)
    } finally {
      setLoadingBooks(false)
    }
  }

  function handleOpenBook(book: Book) {
    setCurrentBookId(book.id)
    navigate(`/editor/${book.id}`)
  }

  // 过滤 + 排序
  const filteredBooks = books
    .filter((b) => b.title.includes(searchQuery) || b.author.includes(searchQuery))
    .sort((a, b) => {
      if (sortBy === 'title') return a.title.localeCompare(b.title, 'zh-CN')
      if (sortBy === 'wordCount') return b.wordCount - a.wordCount
      if (sortBy === 'createdAt') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })

  // 按行分组（grid 模式多列，list 模式单列）
  const effectiveColumnCount = viewMode === 'list' ? 1 : columnCount
  const rowCount = Math.ceil(filteredBooks.length / effectiveColumnCount)
  const rows = useMemo(
    () =>
      Array.from({ length: rowCount }, (_, i) =>
        filteredBooks.slice(i * effectiveColumnCount, (i + 1) * effectiveColumnCount),
      ),
    [filteredBooks, effectiveColumnCount, rowCount],
  )

  // 加载书籍列表
  useEffect(() => {
    loadBooks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 虚拟化实例（行高随 gridSize 动态调整）
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (viewMode === 'list' ? 72 : GRID_ROW_HEIGHT_MAP[gridSize]),
    overscan: 5,
  })

  // 过滤结果或列数变化时重置滚动并重新测量
  useEffect(() => {
    virtualizer.scrollToOffset(0)
    // 延迟一帧确保 DOM 更新后再测量
    requestAnimationFrame(() => virtualizer.measure())
  }, [filteredBooks.length, effectiveColumnCount, virtualizer])

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* 顶栏 */}
      <header className="border-b bg-card px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <BookOpenIcon className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">幻境水墨</h1>
        </div>

        {/* 搜索框 */}
        <div className="flex-1 max-w-md relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜索书名、作者…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-muted rounded-lg outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex-1" />

        {/* 排序 */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="text-sm bg-muted border-0 rounded-lg px-3 py-2 outline-none cursor-pointer"
        >
          <option value="updatedAt">最近修改</option>
          <option value="createdAt">创建时间</option>
          <option value="title">书名</option>
          <option value="wordCount">字数</option>
        </select>

        {/* 视图切换 */}
        <div className="flex rounded-lg overflow-hidden border">
          <button
            onClick={() => setViewMode('grid')}
            className={cn('p-2 transition-colors', viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
          >
            <GridIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn('p-2 transition-colors', viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
          >
            <ListIcon className="w-4 h-4" />
          </button>
        </div>

        {/* 新建书籍 */}
        <button
          onClick={() => setShowNewBookDialog(true)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <PlusIcon className="w-4 h-4" />
          新建作品
        </button>

        <button
          onClick={() => navigate('/settings')}
          className="p-2 rounded-lg hover:bg-muted transition-colors"
        >
          <SettingsIcon className="w-5 h-5 text-muted-foreground" />
        </button>
      </header>

      {/* 主体内容（虚拟化滚动容器） */}
      <main ref={parentRef} className="flex-1 overflow-y-auto p-6">
        {isLoadingBooks ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-muted-foreground animate-pulse">加载中…</div>
          </div>
        ) : filteredBooks.length === 0 ? (
          <EmptyLibrary onNew={() => setShowNewBookDialog(true)} />
        ) : (
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const rowBooks = rows[vItem.index]
              if (!rowBooks) return null
              return (
                <div
                  key={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <div
                    className={cn(
                      viewMode === 'grid'
                        ? `grid ${GRID_GAP_MAP[gridSize]}`
                        : 'flex flex-col gap-2',
                    )}
                    style={viewMode === 'grid' ? { gridTemplateColumns: `repeat(${effectiveColumnCount}, minmax(0, 1fr))` } : undefined}
                  >
                    {rowBooks.map((book) => (
                      <BookCard
                        key={book.id}
                        book={book}
                        viewMode={viewMode}
                        onOpen={handleOpenBook}
                        onRefresh={loadBooks}
                      />
                    ))}
                    {/* 网格模式用空 div 补齐最后一行的列 */}
                    {viewMode === 'grid' &&
                      rowBooks.length < effectiveColumnCount &&
                      [...Array(effectiveColumnCount - rowBooks.length)].map(function (_el, idx) {
                        return <div key={`empty-${idx}`} />
                      })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* 底部状态栏 */}
      <footer className="border-t px-6 py-2 text-xs text-muted-foreground flex items-center gap-4">
        <span>{books.length} 部作品</span>
        <span>总字数 {formatWordCount(books.reduce((s, b) => s + b.wordCount, 0))}</span>
        <div className="flex-1" />
        <span>幻境水墨 v0.1.0</span>
      </footer>

      {/* 新建书籍弹窗 */}
      {showNewBookDialog && (
        <NewBookDialog
          onClose={() => setShowNewBookDialog(false)}
          onCreated={(book) => {
            setShowNewBookDialog(false)
            handleOpenBook(book)
          }}
        />
      )}
    </div>
  )
}

/**
 * 空书库占位组件
 *
 * 当没有作品时展示引导创建按钮。
 */
function EmptyLibrary({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
      <BookOpenIcon className="w-16 h-16 text-muted-foreground/30" />
      <div>
        <p className="text-lg font-medium text-muted-foreground">还没有作品</p>
        <p className="text-sm text-muted-foreground/70 mt-1">点击"新建作品"开始你的创作之旅</p>
      </div>
      <button
        onClick={onNew}
        className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity"
      >
        <PlusIcon className="w-4 h-4" />
        新建作品
      </button>
    </div>
  )
}

