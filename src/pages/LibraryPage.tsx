/**
 * LibraryPage — 书库管理页面
 *
 * 应用首页，提供：
 * - 多作品网格/列表视图（虚拟化滚动）
 * - 书名/作者搜索与排序
 * - 新建作品弹窗入口
 * - 回收站（软删除作品管理）
 * - 底部状态栏（作品数、总字数）
 */
import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAtom } from 'jotai'
import { PlusIcon, SearchIcon, GridIcon, ListIcon, SettingsIcon, BookOpenIcon, Trash2Icon, WrenchIcon, UploadIcon, DownloadIcon } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { save, open } from '@tauri-apps/plugin-dialog'
import { useAppStore } from '@/stores/appStore'
import { aiToolboxWindowOpenAtom } from '@/stores/uiAtoms'
import { bookApi, importExportApi } from '@/lib/tauri-bridge'
import { cn, formatWordCount } from '@/lib/utils'
import type { Book } from '@/types'
import BookCard from '@/components/library/BookCard'
import NewBookDialog from '@/components/library/NewBookDialog'
import TrashModal from '@/components/library/TrashModal'
import { closeAllMenus } from '@/components/common/ContextMenu'
import { useVirtualizer } from '@tanstack/react-virtual'

type SortBy = 'updatedAt' | 'createdAt' | 'title' | 'wordCount'

/** 不同网格大小对应的列数映射（对应不同容器宽度断点） */
const GRID_COL_MAP = {
  small: { 1280: 6, 1024: 5, 768: 4, 0: 3 },
  medium: { 1280: 5, 1024: 4, 768: 3, 0: 2 },
  large: { 1280: 4, 1024: 3, 768: 2, 0: 1 },
} as const

/** 不同网格大小对应的间距 */
const GRID_GAP_MAP = { small: 'gap-2', medium: 'gap-4', large: 'gap-6' } as const

/**
 * 不同网格大小对应的虚拟化行高预估值
 *
 * 卡片实际高度 ≈ 列宽 × (4/3) + 65px（信息区），随屏幕宽度变化。
 * 估算值取上限覆盖 1920px 宽屏场景，避免初始定位偏低导致行重叠，
 * measureElement 会在首帧后自动修正为精确值。
 */
const GRID_ROW_HEIGHT_MAP = { small: 480, medium: 560, large: 680 } as const

export default function LibraryPage() {
  const navigate = useNavigate()
  const {
    books, setBooks, setCurrentBookId, currentBookId, isLoadingBooks, setLoadingBooks,
    gridSize, appVersion,
    libraryViewMode, setLibraryViewMode,
    librarySortBy, setLibrarySortBy,
    trashCount, setTrashCount,
  } = useAppStore()
  const viewMode = libraryViewMode
  const sortBy = librarySortBy
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewBookDialog, setShowNewBookDialog] = useState(false)
  const [showTrashModal, setShowTrashModal] = useState(false)
  const [aiToolboxWindowOpen, setAiToolboxWindowOpen] = useAtom(aiToolboxWindowOpenAtom)

  // 虚拟化滚动容器 ref
  const parentRef = useRef<HTMLDivElement>(null)
  // 网格列数（仅 grid 模式有效）
  const [columnCount, setColumnCount] = useState(4)
  // 容器宽度，用于动态计算行高
  const [containerWidth, setContainerWidth] = useState(0)

  // 监听容器宽度，根据 gridSize 计算网格列数，并记录容器宽度
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        setContainerWidth(w)
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

  const loadTrashCount = useCallback(async () => {
    try {
      const deleted = await bookApi.listDeleted()
      setTrashCount(deleted.length)
    } catch { /* ignore */ }
  }, [setTrashCount])

  const loadBooks = useCallback(async () => {
    setLoadingBooks(true)
    try {
      const [data] = await Promise.all([bookApi.list(), loadTrashCount()])
      setBooks(data)
    } catch (err) {
      console.error('加载书籍失败', err)
    } finally {
      setLoadingBooks(false)
    }
  }, [setLoadingBooks, setBooks, loadTrashCount])

  const handleTrashChanged = useCallback(() => {
    loadBooks()
    loadTrashCount()
  }, [loadBooks, loadTrashCount])

  /** 导出全部数据（数据库 + localStorage 缓存） */
  const [isExporting, setIsExporting] = useState(false)
  const handleExportAll = useCallback(async () => {
    if (isExporting) return
    setIsExporting(true)
    try {
      // 选择保存路径
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const filePath = await save({
        title: '导出全部数据',
        defaultPath: `TimeWrite-全量备份-${timestamp}.tw`,
        filters: [{ name: 'TimeWrite 备份', extensions: ['tw'] }],
      })
      if (!filePath) { setIsExporting(false); return }

      // 收集 localStorage 缓存数据
      const cacheData: Record<string, unknown> = {}
      const cacheKeys = [
        'time-write-ai-config',
        'time-write-preferences',
        'time-write-editor-state',
        'time-write-ai-conversations',
        'time-write-ai-summaries',
        'time-write-ai-tool-categories',
      ]
      for (const key of cacheKeys) {
        const raw = localStorage.getItem(key)
        if (raw) {
          try { cacheData[key] = JSON.parse(raw) } catch { cacheData[key] = raw }
        }
      }

      await importExportApi.exportAllData(filePath, JSON.stringify(cacheData))
      alert('数据导出成功！')
    } catch (err) {
      console.error('导出数据失败', err)
      alert(`导出失败：${err}`)
    } finally {
      setIsExporting(false)
    }
  }, [isExporting])

  /** 统一导入备份文件（自动识别全量/单作品备份） */
  const [isImporting, setIsImporting] = useState(false)
  const handleImportBackup = useCallback(async () => {
    if (isImporting) return
    setIsImporting(true)
    try {
      // 选择备份文件
      const filePath = await open({
        title: '选择备份文件',
        filters: [{ name: 'TimeWrite 备份', extensions: ['tw'] }],
        multiple: false,
      })
      if (!filePath) { setIsImporting(false); return }

      const filePathStr = typeof filePath === 'string' ? filePath : filePath[0]
      if (!filePathStr) { setIsImporting(false); return }

      // 二次确认
      if (!confirm('确认导入此备份文件？')) {
        setIsImporting(false)
        return
      }

      // 调用后端统一导入，返回 { cache, backupType }
      const result = await importExportApi.importBackup(filePathStr)

      // 恢复 localStorage 缓存数据
      if (result.cache) {
        const cacheData = result.cache as Record<string, unknown>
        for (const [key, value] of Object.entries(cacheData)) {
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
        }
      }

      // 刷新书籍列表
      await loadBooks()

      const msg = result.backupType === 'single'
        ? '单作品数据导入成功！'
        : '全量数据导入成功！'
      alert(msg)
    } catch (err) {
      console.error('导入数据失败', err)
      alert(`导入失败：${err}`)
    } finally {
      setIsImporting(false)
    }
  }, [isImporting, loadBooks])

  async function handleToggleAiToolboxWindow() {
    if (aiToolboxWindowOpen) {
      try {
        await invoke('close_ai_toolbox_window')
      } catch (e) {
        console.error('关闭 AI 工具箱窗口失败', e)
      }
      setAiToolboxWindowOpen(false)
    } else {
      try {
        await invoke('open_ai_toolbox_window')
        setAiToolboxWindowOpen(true)
      } catch (e) {
        console.error('打开 AI 工具箱窗口失败', e)
      }
    }
  }

  function handleOpenBook(book: Book) {
    setCurrentBookId(book.id)
    navigate(`/editor/${book.id}`)
  }

  // 过滤 + 排序（useMemo 避免每次渲染重复计算）
  const filteredBooks = useMemo(() =>
    books
      .filter((b) => b.title.includes(searchQuery) || b.author.includes(searchQuery))
      .sort((a, b) => {
        if (sortBy === 'title') return a.title.localeCompare(b.title, 'zh-CN')
        if (sortBy === 'wordCount') return b.wordCount - a.wordCount
        if (sortBy === 'createdAt') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      }),
    [books, searchQuery, sortBy],
  )

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

  // 监听 AI 工具箱窗口关闭事件
  useEffect(() => {
    const unlisten = listen('ai-toolbox-window-closed', () => {
      setAiToolboxWindowOpen(false)
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [])

  // 动态计算网格行高：基于实际列宽计算，而非固定预估值
  const gridRowHeight = useMemo(() => {
    if (containerWidth === 0 || effectiveColumnCount === 0) return GRID_ROW_HEIGHT_MAP[gridSize]
    const columnWidth = containerWidth / effectiveColumnCount
    // 卡片高度 = 列宽 × (4/3) 封面比例 + 信息区高度 + padding
    const cardHeight = columnWidth * (4 / 3) + 65
    // 加上行间距 (gap-4 = 1rem = 16px)
    return cardHeight + 16
  }, [containerWidth, effectiveColumnCount, gridSize])

  // 虚拟化实例（行高基于实际列宽动态计算）
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (viewMode === 'list' ? 72 : gridRowHeight),
    overscan: 5,
  })

  // 过滤结果或列数变化时重置滚动并重新测量
  useEffect(() => {
    if (rows.length > 0) {
      virtualizer.scrollToOffset(0)
      requestAnimationFrame(() => virtualizer.measure())
    }
  }, [filteredBooks.length, effectiveColumnCount, virtualizer])

  // 监听从编辑页返回（currentBookId 从非 null 变为 null），强制重新测量
  const prevBookIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevBookIdRef.current
    prevBookIdRef.current = currentBookId
    if (prev !== null && prev !== '' && currentBookId === null) {
      // 从编辑页返回，延迟重新测量
      const timer = requestAnimationFrame(() => {
        virtualizer.measure()
      })
      return () => cancelAnimationFrame(timer)
    }
  }, [currentBookId, virtualizer])

  /** 右键空白区域时关闭所有菜单，不弹出任何菜单 */
  const handleBlankContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    closeAllMenus()
  }, [])

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* 顶栏 */}
      <header className="border-b bg-card px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <BookOpenIcon className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">智写时光</h1>
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
          onChange={(e) => setLibrarySortBy(e.target.value as SortBy)}
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
            onClick={() => setLibraryViewMode('grid')}
            className={cn('p-2 transition-colors', viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
          >
            <GridIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => setLibraryViewMode('list')}
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

        {/* 回收站 */}
        <button
          onClick={() => setShowTrashModal(true)}
          className="relative p-2 rounded-lg hover:bg-muted transition-colors"
          title="作品回收站"
        >
          <Trash2Icon className="w-5 h-5 text-muted-foreground" />
          {trashCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full px-1">
              {trashCount > 99 ? '99+' : trashCount}
            </span>
          )}
        </button>

        {/* 导出数据 */}
        <button
          onClick={handleExportAll}
          disabled={isExporting}
          className="p-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          title="导出全部数据"
        >
          <UploadIcon className={`w-5 h-5 text-muted-foreground ${isExporting ? 'animate-pulse' : ''}`} />
        </button>

        {/* 导入数据 */}
        <button
          onClick={handleImportBackup}
          disabled={isImporting}
          className="p-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          title="导入数据备份"
        >
          <DownloadIcon className={`w-5 h-5 text-muted-foreground ${isImporting ? 'animate-pulse' : ''}`} />
        </button>

        {/* AI 工具箱 */}
        <button
          onClick={handleToggleAiToolboxWindow}
          className={cn(
            'p-2 rounded-lg transition-colors',
            aiToolboxWindowOpen ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-muted-foreground',
          )}
          title="AI 工具箱"
        >
          <WrenchIcon className="w-5 h-5" />
        </button>

        <button
          onClick={() => navigate('/settings')}
          className="p-2 rounded-lg hover:bg-muted transition-colors"
        >
          <SettingsIcon className="w-5 h-5 text-muted-foreground" />
        </button>
      </header>

      {/* 主体内容（虚拟化滚动容器） */}
      <main ref={parentRef} className="flex-1 overflow-y-auto p-6" onContextMenu={handleBlankContextMenu}>
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
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <div
                    ref={virtualizer.measureElement}
                    data-index={vItem.index}
                    className={cn(
                      'pb-4',
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
        <span>智写时光 TimeWrite v{appVersion}</span>
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

      {/* 回收站弹窗 */}
      {showTrashModal && (
        <TrashModal
          onClose={() => setShowTrashModal(false)}
          onChanged={handleTrashChanged}
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

