import { useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAtom } from 'jotai'
import { XIcon } from 'lucide-react'
import { sidebarOpenAtom, zenModeAtom, aiPanelOpenAtom, worldPanelOpenAtom, historyPanelOpenAtom } from '@/stores/uiAtoms'
import { useAppStore } from '@/stores/appStore'
import { chapterApi, volumeApi } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import EditorLayout from '@/components/layout/EditorLayout'
import OutlinePanel from '@/components/outline/OutlinePanel'
import RichTextEditor from '@/components/editor/RichTextEditor'
import WorldbuildingPanel from '@/components/worldbuilding/WorldbuildingPanel'
import AiSidePanel from '@/components/ai/AiSidePanel'
import SnapshotPanel from '@/components/editor/SnapshotPanel'
import EditorToolbar from '@/components/editor/EditorToolbar'
import StatusBar from '@/components/layout/StatusBar'

export default function EditorPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [sidebarOpen] = useAtom(sidebarOpenAtom)
  const [zenMode, setZenMode] = useAtom(zenModeAtom)
  const [aiPanelOpen] = useAtom(aiPanelOpenAtom)
  const [worldPanelOpen] = useAtom(worldPanelOpenAtom)
  const [historyPanelOpen] = useAtom(historyPanelOpenAtom)
  const {
    setCurrentBookId,
    setVolumes,
    setChapters,
    setLoadingChapters,
    currentChapterId,
    setCurrentChapterId,
    addChapter,
  } = useAppStore()
  const loadedBookIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!bookId) {
      navigate('/')
      return
    }
    // StrictMode 下 effect 会执行两次，用 ref 防止并发重复加载
    if (loadedBookIdRef.current === bookId) return
    loadedBookIdRef.current = bookId
    setCurrentBookId(bookId)
    loadBookTree(bookId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  async function loadBookTree(id: string) {
    setLoadingChapters(true)
    try {
      const [volumes, chapters] = await Promise.all([
        volumeApi.listByBook(id),
        chapterApi.listByBook(id),
      ])
      setVolumes(volumes)
      setChapters(chapters)

      // 无章节时自动创建第一章；无选中章节时自动选中第一章
      if (chapters.length === 0) {
        const ch = await chapterApi.create({ bookId: id, title: '第一章', sortOrder: 0 })
        addChapter(ch)
        setCurrentChapterId(ch.id)
      } else if (!currentChapterId || !chapters.some((c) => c.id === currentChapterId)) {
        setCurrentChapterId(chapters[0].id)
      }
    } catch (err) {
      console.error('加载章节树失败', err)
    } finally {
      setLoadingChapters(false)
    }
  }

  const exitZenMode = useCallback(() => setZenMode(false), [setZenMode])

  // Esc 键退出专注模式
  useEffect(() => {
    if (!zenMode) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitZenMode()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [zenMode, exitZenMode])

  return (
    <div className={cn('h-screen flex flex-col overflow-hidden', zenMode && 'zen-mode')}>
      {/* 顶部工具栏 */}
      {!zenMode && <EditorToolbar />}

      {/* 专注模式退出按钮 */}
      {zenMode && (
        <button
          onClick={exitZenMode}
          className="fixed top-4 right-4 z-50 p-2 rounded-lg bg-card/80 border border-border/50 text-muted-foreground hover:text-foreground hover:bg-card transition-colors shadow-sm"
          title="退出专注模式 (Esc)"
        >
          <XIcon className="w-4 h-4" />
        </button>
      )}

      {/* 主编辑区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧目录树 */}
        {sidebarOpen && !zenMode && (
          <aside className="sidebar w-64 border-r bg-card flex-shrink-0 flex flex-col overflow-hidden">
            <OutlinePanel bookId={bookId!} />
          </aside>
        )}

        {/* 编辑器区域 */}
        <main className="flex-1 overflow-hidden">
          <EditorLayout>
            <RichTextEditor />
          </EditorLayout>
        </main>

        {/* 右侧面板（版本历史 / 世界观 / AI） */}
        {historyPanelOpen && !zenMode && (
          <aside className="w-80 border-l bg-card flex-shrink-0 overflow-hidden">
            <SnapshotPanel />
          </aside>
        )}
        {worldPanelOpen && !zenMode && (
          <aside className="w-80 border-l bg-card flex-shrink-0 overflow-hidden">
            <WorldbuildingPanel bookId={bookId!} />
          </aside>
        )}
        {aiPanelOpen && !zenMode && (
          <aside className="w-96 border-l bg-card flex-shrink-0 overflow-hidden">
            <AiSidePanel />
          </aside>
        )}
      </div>

      {/* 底部状态栏 */}
      {!zenMode && <StatusBar />}
    </div>
  )
}
