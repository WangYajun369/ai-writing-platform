import { useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAtom } from 'jotai'
import { sidebarOpenAtom, zenModeAtom, aiPanelOpenAtom, worldPanelOpenAtom } from '@/stores/uiAtoms'
import { useAppStore } from '@/stores/appStore'
import { chapterApi, volumeApi } from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import EditorLayout from '@/components/layout/EditorLayout'
import OutlinePanel from '@/components/outline/OutlinePanel'
import RichTextEditor from '@/components/editor/RichTextEditor'
import WorldbuildingPanel from '@/components/worldbuilding/WorldbuildingPanel'
import AiSidePanel from '@/components/ai/AiSidePanel'
import EditorToolbar from '@/components/editor/EditorToolbar'
import StatusBar from '@/components/layout/StatusBar'

export default function EditorPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [sidebarOpen] = useAtom(sidebarOpenAtom)
  const [zenMode] = useAtom(zenModeAtom)
  const [aiPanelOpen] = useAtom(aiPanelOpenAtom)
  const [worldPanelOpen] = useAtom(worldPanelOpenAtom)
  const {
    setCurrentBookId,
    setVolumes,
    setChapters,
    setLoadingChapters,
  } = useAppStore()

  useEffect(() => {
    if (!bookId) {
      navigate('/')
      return
    }
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
    } catch (err) {
      console.error('加载章节树失败', err)
    } finally {
      setLoadingChapters(false)
    }
  }

  return (
    <div className={cn('h-screen flex flex-col overflow-hidden', zenMode && 'zen-mode')}>
      {/* 顶部工具栏 */}
      {!zenMode && <EditorToolbar />}

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

        {/* 右侧面板（世界观 / AI） */}
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
