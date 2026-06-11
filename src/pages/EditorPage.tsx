/**
 * EditorPage — 章节编辑页面
 *
 * 编辑器主页面，组装三栏布局（目录树/编辑器/右侧面板）。
 * 负责加载书籍的卷章树数据，管理专注模式 Esc 退出。
 * 世界观资料库与版本历史均为独立窗口，离开编辑器时自动关闭。
 */
import { useEffect, useRef, useCallback, Component, type ErrorInfo, type ReactNode } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAtom } from 'jotai'
import { XIcon, AlertTriangleIcon, RefreshCwIcon } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { sidebarOpenAtom, zenModeAtom, aiPanelOpenAtom, contentRefreshAtom } from '@/stores/uiAtoms'
import { useAppStore, getEditorState } from '@/stores/appStore'
import { chapterApi, volumeApi, windowApi } from '@/lib/tauri-bridge'
import { cn, createStorage } from '@/lib/utils'
import { useResizeHandle } from '@/hooks/useResizeHandle'
import EditorLayout from '@/components/layout/EditorLayout'
import OutlinePanel from '@/components/outline/OutlinePanel'
import RichTextEditor from '@/components/editor/RichTextEditor'
import AiSidePanel from '@/components/ai/AiSidePanel'
import EditorToolbar from '@/components/editor/EditorToolbar'
import StatusBar from '@/components/layout/StatusBar'

/** AI 面板局部错误边界：防止 AiSidePanel 崩溃导致整个编辑器页面白屏 */
class AiPanelErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AiPanelErrorBoundary] AI 面板渲染异常:', error, info.componentStack)
  }
  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-4 text-center">
          <AlertTriangleIcon className="w-8 h-8 text-red-500 mb-3" />
          <p className="text-sm font-medium mb-2">AI 助手加载失败</p>
          <p className="text-xs text-muted-foreground mb-4 max-w-xs break-all">
            {this.state.error?.message || '未知错误'}
          </p>
          <button
            onClick={this.handleReset}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs hover:opacity-90 transition-opacity"
          >
            <RefreshCwIcon className="w-3 h-3" />
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/** AI 面板比例本地持久化（0-1） */
const aiPanelStorage = createStorage('mirageink-ai-panel-ratio', { ratio: 0.3 })
/** 左侧目录面板像素宽度本地持久化 */
const sidebarPanelStorage = createStorage('mirageink-sidebar-width', { width: 256 })

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
  /** 主编辑区容器 ref，用于比例模式计算 */
  const editorAreaRef = useRef<HTMLDivElement>(null)

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

  // 迁移旧版像素宽度 → 新版比例存储
  useEffect(() => {
    try {
      const oldRaw = localStorage.getItem('mirageink-ai-panel-width')
      const newRaw = localStorage.getItem('mirageink-ai-panel-ratio')
      if (oldRaw && !newRaw) {
        const { width } = JSON.parse(oldRaw) as { width: number }
        const ratio = window.innerWidth > 0 ? width / window.innerWidth : 0.3
        aiPanelStorage.patch({ ratio: Math.min(0.5, Math.max(0.15, ratio)) })
        localStorage.removeItem('mirageink-ai-panel-width')
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 左侧目录面板可拖拽调整宽度（像素模式：固定像素宽度，不受窗口缩放影响）
  const {
    width: sidebarWidth,
    resizeHandleProps: sidebarResizeHandleProps,
    isResizing: sidebarResizing,
  } = useResizeHandle({
    initialWidth: sidebarPanelStorage.load().width,
    minWidth: 180,
    maxWidth: 500,
    direction: 'left',
    onResizeEnd: (width) => sidebarPanelStorage.patch({ width }),
  })

  // AI 面板可拖拽调整宽度（比例模式：随窗口自动缩放）
  const { width: aiPanelWidth, resizeHandleProps, isResizing: aiResizing } = useResizeHandle({
    initialRatio: aiPanelStorage.load().ratio,
    minWidth: 0.15,
    maxWidth: 0.5,
    containerRef: editorAreaRef,
    direction: 'right',
    onResizeEnd: (ratio) => aiPanelStorage.patch({ ratio }),
  })

  // 监听版本历史窗口恢复快照后刷新编辑器内容
  useEffect(() => {
    const unlisten = listen<string>('history-snapshot-restored', () => {
      setContentRefresh((v) => v + 1)
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [setContentRefresh])

  // 组件卸载（离开编辑页返回书库）时关闭世界观、版本历史独立窗口
  // 注意：AI 工具箱不依赖当前作品/章节上下文，不在此自动关闭
  useEffect(() => {
    return () => {
      windowApi.closeWorld().catch(() => {})
      windowApi.closeHistory().catch(() => {})
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
      <div ref={editorAreaRef} className="flex-1 flex overflow-hidden">
        {/* 左侧目录树 + 拖拽手柄 */}
        {sidebarOpen && !zenMode && (
          <>
            <aside
              className="border-r bg-card shrink-0 flex flex-col overflow-hidden"
              style={{ width: sidebarWidth }}
            >
              <OutlinePanel bookId={bookId!} />
            </aside>
            {/* 目录拖拽分界线 */}
            <div
              {...sidebarResizeHandleProps}
              className={cn(
                'w-1.5 shrink-0 cursor-col-resize transition-colors bg-border/30 hover:bg-primary/60 active:bg-primary',
                sidebarResizing && 'bg-primary/60',
              )}
            />
          </>
        )}

        {/* 编辑器区域 */}
        <main className="flex-1 overflow-hidden">
          <EditorLayout>
            <RichTextEditor />
          </EditorLayout>
        </main>

        {/* 拖拽手柄 + 右侧 AI 助手面板 */}
        {aiPanelOpen && !zenMode && (
          <>
            {/* 可拖拽分界线 */}
            <div
              {...resizeHandleProps}
              className={cn(
                'w-1.5 shrink-0 cursor-col-resize transition-colors bg-border/30 hover:bg-primary/60 active:bg-primary',
                aiResizing && 'bg-primary/60',
              )}
            />
            <aside
              className="border-l bg-card shrink-0 overflow-hidden"
              style={{ width: Math.max(200, aiPanelWidth) }}
            >
              <AiPanelErrorBoundary>
                <AiSidePanel />
              </AiPanelErrorBoundary>
            </aside>
          </>
        )}
      </div>

      {/* 底部状态栏 */}
      {!zenMode && <StatusBar />}
    </div>
  )
}
