/**
 * EditorToolbar — 编辑器顶部工具栏
 *
 * 提供返回书库、目录树折叠、打字机/专注模式切换、
 * 版本历史/世界观/AI 面板开关等功能按钮。
 */
import { useAtom } from 'jotai'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeftIcon,
  SidebarIcon,
  BotIcon,
  BookMarkedIcon,
  ClockIcon,
  ZapIcon,
  KeyboardIcon,
  LayoutIcon,
} from 'lucide-react'
import {
    sidebarOpenAtom,
    zenModeAtom,
    typewriterModeAtom,
    aiPanelOpenAtom,
    worldPanelOpenAtom,
    historyPanelOpenAtom, isSavingAtom, lastSavedAtom,
} from '@/stores/uiAtoms.ts'
import { useCurrentBook } from '@/stores/appStore.ts'
import { cn } from '@/lib/utils.ts'

export default function EditorToolbar() {
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const [zenMode, setZenMode] = useAtom(zenModeAtom)
  const [typewriterMode, setTypewriterMode] = useAtom(typewriterModeAtom)
  const [aiPanelOpen, setAiPanelOpen] = useAtom(aiPanelOpenAtom)
  const [worldPanelOpen, setWorldPanelOpen] = useAtom(worldPanelOpenAtom)
  const [historyPanelOpen, setHistoryPanelOpen] = useAtom(historyPanelOpenAtom)
  const currentBook = useCurrentBook()

  return (
    <header className="toolbar border-b bg-card px-4 py-2 flex items-center gap-2 flex-shrink-0 h-12">
      {/* 返回 */}
      <button
        onClick={() => navigate('/')}
        className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground"
        title="返回书库"
      >
        <ArrowLeftIcon className="w-4 h-4" />
      </button>

      {/* 书名 */}
      <span className="text-sm font-medium truncate max-w-32">{currentBook?.title ?? '未命名'}</span>

      <div className="w-px h-5 bg-border mx-1" />

      {/* 目录树 */}
      <ToolbarBtn
        active={sidebarOpen}
        onClick={() => setSidebarOpen((v) => !v)}
        title="目录树"
        icon={<SidebarIcon className="w-4 h-4" />}
      />

      <div className="flex-1" />

      {/* 功能按钮组 */}
      <ToolbarBtn
        active={typewriterMode}
        onClick={() => setTypewriterMode((v) => !v)}
        title="打字机模式"
        icon={<KeyboardIcon className="w-4 h-4" />}
      />

      <ToolbarBtn
        active={zenMode}
        onClick={() => setZenMode((v) => !v)}
        title="专注模式"
        icon={<LayoutIcon className="w-4 h-4" />}
      />

      <div className="w-px h-5 bg-border mx-1" />

      <ToolbarBtn
        active={historyPanelOpen}
        onClick={() => setHistoryPanelOpen((v) => !v)}
        title="版本历史"
        icon={<ClockIcon className="w-4 h-4" />}
      />

      <ToolbarBtn
        active={worldPanelOpen}
        onClick={() => setWorldPanelOpen((v) => !v)}
        title="世界观资料库"
        icon={<BookMarkedIcon className="w-4 h-4" />}
      />

      <ToolbarBtn
        active={aiPanelOpen}
        onClick={() => setAiPanelOpen((v) => !v)}
        title="AI 助手"
        icon={<BotIcon className="w-4 h-4" />}
        className="text-primary"
      />

      {/* 快速保存提示 */}
      <SaveIndicator />
    </header>
  )
}

/**
 * 工具栏按钮子组件
 *
 * 高亮当前激活状态，支持自定义图标与文字提示。
 */
function ToolbarBtn({
  active,
  onClick,
  title,
  icon,
  className,
}: {
  active: boolean
  onClick: () => void
  title: string
  icon: React.ReactNode
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'p-1.5 rounded transition-colors',
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        className
      )}
    >
      {icon}
    </button>
  )
}

/**
 * 保存状态指示器
 *
 * 显示当前是"保存中…"动画还是"已保存"状态。
 */
function SaveIndicator() {
  const [isSaving] = useAtom(isSavingAtom)
  const [lastSaved] = useAtom(lastSavedAtom)

  if (isSaving) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground ml-2">
        <ZapIcon className="w-3 h-3 animate-pulse" />
        保存中…
      </span>
    )
  }
  if (lastSaved) {
    return (
      <span className="text-xs text-muted-foreground ml-2">
        已保存
      </span>
    )
  }
  return null
}
