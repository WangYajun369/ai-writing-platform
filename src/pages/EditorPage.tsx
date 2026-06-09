/**
 * EditorPage — 章节编辑页面
 *
 * 编辑器主页面，组装三栏布局（目录树/编辑器/右侧面板）。
 * 负责加载书籍的卷章树数据，管理专注模式 Esc 退出。
 * 世界观资料库与版本历史均为独立窗口，离开编辑器时自动关闭。
 */
import { useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAtom } from 'jotai'
import { XIcon } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { sidebarOpenAtom, zenModeAtom, aiPanelOpenAtom, contentRefreshAtom } from '@/stores/uiAtoms'
import { useAppStore, getEditorState } from '@/stores/appStore'
import { chapterApi, volumeApi } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import EditorLayout from '@/components/layout/EditorLayout'
import OutlinePanel from '@/components/outline/OutlinePanel'
import RichTextEditor from '@/components/editor/RichTextEditor'
import AiSidePanel from '@/components/ai/AiSidePanel'
import EditorToolbar from '@/components/editor/EditorToolbar'
import StatusBar from '@/components/layout/StatusBar'

export default function EditorPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [sidebarOpen] = useAtom(sidebarOpenAtom)
  const [zenMode, setZenMode] = useAtom(zenModeAtom)
  const [aiPanelOpen] = useAtom(aiPanelOpenAtom)
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
  // loadBookTree 内部使用的 setter 函数引用稳定，无需加入依赖
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  const [, setContentRefresh] = useAtom(contentRefreshAtom)

  // 监听版本历史窗口恢复快照后刷新编辑器内容
  useEffect(() => {
    const unlisten = listen<string>('history-snapshot-restored', () => {
      setContentRefresh((v) => v + 1)
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [setContentRefresh])

  // 组件卸载（离开编辑页返回书库）时关闭世界观和版本历史独立窗口
  useEffect(() => {
    return () => {
      invoke('close_world_window').catch(() => {})
      invoke('close_history_window').catch(() => {})
    }
  }, [])

  async function loadBookTree(id: string) {
    setLoadingChapters(true)
    try {
      const [volumes, deletedVolumes, chapters, deletedChapters] = await Promise.all([
        volumeApi.listByBook(id),
        volumeApi.listDeleted(id),
        chapterApi.listByBook(id),
        chapterApi.listDeleted(id),
      ])
      // 合并未删除和已删除的数据，确保回收站数据不丢失
      setVolumes([...volumes, ...deletedVolumes])
      setChapters([...chapters, ...deletedChapters])

      // 无章节时自动创建第一章；尝试恢复上次编辑位置，否则选中第一章
      if (chapters.length === 0) {
        const ch = await chapterApi.create({ bookId: id, title: '第一章', sortOrder: 0 })
        addChapter(ch)
        setCurrentChapterId(ch.id)
      } else if (!currentChapterId || !chapters.some((c) => c.id === currentChapterId)) {
        // 尝试恢复上次编辑的章节
        const savedState = getEditorState(id)
        if (savedState && chapters.some((c) => c.id === savedState.chapterId)) {
          setCurrentChapterId(savedState.chapterId)
        } else {
          setCurrentChapterId(chapters[0].id)
        }
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
    <div className={cn('h-screen flex flex-col overflow-hidden editor-font', zenMode && 'zen-mode')}>
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

        {/* 右侧面板（AI） */}
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
