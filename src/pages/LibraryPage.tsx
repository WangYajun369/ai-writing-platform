import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusIcon, SearchIcon, GridIcon, ListIcon, SettingsIcon, BookOpenIcon } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { bookApi } from '@/lib/tauri-bridge'
import { cn, formatWordCount, formatRelativeTime } from '@/lib/utils'
import type { Book } from '@/types'
import BookCard from '@/components/library/BookCard'
import NewBookDialog from '@/components/library/NewBookDialog'

type ViewMode = 'grid' | 'list'
type SortBy = 'updatedAt' | 'createdAt' | 'title' | 'wordCount'

export default function LibraryPage() {
  const navigate = useNavigate()
  const { books, setBooks, setCurrentBookId, isLoadingBooks, setLoadingBooks } = useAppStore()
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [sortBy, setSortBy] = useState<SortBy>('updatedAt')
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewBookDialog, setShowNewBookDialog] = useState(false)

  // 加载书籍列表
  useEffect(() => {
    loadBooks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

      {/* 主体内容 */}
      <main className="flex-1 p-6">
        {isLoadingBooks ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-muted-foreground animate-pulse">加载中…</div>
          </div>
        ) : filteredBooks.length === 0 ? (
          <EmptyLibrary onNew={() => setShowNewBookDialog(true)} />
        ) : (
          <div
            className={cn(
              viewMode === 'grid'
                ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4'
                : 'flex flex-col gap-2'
            )}
          >
            {filteredBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                viewMode={viewMode}
                onOpen={handleOpenBook}
                onRefresh={loadBooks}
              />
            ))}
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

export { formatWordCount, formatRelativeTime }
