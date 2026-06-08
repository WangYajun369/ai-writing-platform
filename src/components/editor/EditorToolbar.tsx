/**
 * EditorToolbar — 编辑器顶部工具栏
 *
 * 提供返回书库、目录树折叠、专注模式切换、
 * 版本历史/世界观/AI 面板开关等功能按钮。
 * 世界观资料库打开为独立悬浮窗口。
 */
import { useAtom, useAtomValue } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import {
  ArrowLeftIcon,
  SidebarIcon,
  BotIcon,
  BookMarkedIcon,
  ClockIcon,
  ZapIcon,
  LayoutIcon,
  TypeIcon,
  MinusIcon,
  PlusIcon,
  ImageIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Code2Icon,
} from 'lucide-react'
import {
    sidebarOpenAtom,
    zenModeAtom,
    aiPanelOpenAtom,
    historyPanelOpenAtom, isSavingAtom, lastSavedAtom,
    editorInstanceAtom,
} from '@/stores/uiAtoms.ts'
import { useCurrentBook, useAppStore } from '@/stores/appStore.ts'
import { cn } from '@/lib/utils.ts'

export default function EditorToolbar() {
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const [zenMode, setZenMode] = useAtom(zenModeAtom)
  const [aiPanelOpen, setAiPanelOpen] = useAtom(aiPanelOpenAtom)
  const [historyPanelOpen, setHistoryPanelOpen] = useAtom(historyPanelOpenAtom)
  const [worldWindowOpen, setWorldWindowOpen] = useState(false)
  const currentBook = useCurrentBook()
  const { fontSize, setFontSize } = useAppStore()
  const editor = useAtomValue(editorInstanceAtom)

  /** 从文件扩展名推断 MIME 类型 */
  const guessMimeType = useCallback((path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
    }
    return mimeMap[ext] ?? 'image/png'
  }, [])

  /** 将 Uint8Array 转为 base64 字符串 */
  const uint8ToBase64 = useCallback((bytes: Uint8Array): string => {
    let binary = ''
    const len = bytes.length
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }, [])

  /** 插入图片 */
  const handleInsertImage = useCallback(async () => {
    if (!editor) return
    try {
      const selected = await open({
        title: '选择图片',
        multiple: false,
        filters: [{
          name: '图片文件',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'],
        }],
      })
      if (!selected) return // 用户取消

      const filePath = selected as string
      const fileBytes = await readFile(filePath)
      const base64 = uint8ToBase64(fileBytes)
      const mime = guessMimeType(filePath)
      const dataUrl = `data:${mime};base64,${base64}`

      editor.chain().focus().setImage({ src: dataUrl }).run()
    } catch (err) {
      console.error('插入图片失败', err)
    }
  }, [editor, guessMimeType, uint8ToBase64])

  async function handleToggleWorldWindow() {
    if (worldWindowOpen) {
      try {
        await invoke('close_world_window')
      } catch (e) {
        console.error('关闭世界观窗口失败', e)
      }
      setWorldWindowOpen(false)
    } else {
      if (!currentBook?.id) return
      try {
        await invoke('open_world_window', { bookId: currentBook.id })
      } catch (e) {
        console.error('打开世界观窗口失败', e)
        return
      }
      setWorldWindowOpen(true)
    }
  }

  // 监听 world 窗口被用户主动关闭（点 X），同步按钮状态
  useEffect(() => {
    const unlisten = listen('world-window-closed', () => {
      setWorldWindowOpen(false)
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

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

      {/* 字体大小 */}
      <div className="flex items-center gap-1">
        <TypeIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <button
          onClick={() => setFontSize(Math.max(12, fontSize - 1))}
          disabled={fontSize <= 12}
          className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="缩小字体"
        >
          <MinusIcon className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs text-muted-foreground w-7 text-center tabular-nums">{fontSize}px</span>
        <button
          onClick={() => setFontSize(Math.min(24, fontSize + 1))}
          disabled={fontSize >= 24}
          className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="放大字体"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="w-px h-5 bg-border mx-1" />

      {/* 插入图片 */}
      <ToolbarBtn
        active={false}
        onClick={handleInsertImage}
        title="插入图片"
        icon={<ImageIcon className="w-4 h-4" />}
      />

      {/* 代码块 */}
      <ToolbarBtn
        active={editor?.isActive('codeBlock') ?? false}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        title="代码块"
        icon={<Code2Icon className="w-4 h-4" />}
      />

      <div className="w-px h-5 bg-border mx-1" />

      {/* 标题 */}
      <ToolbarBtn
        active={editor?.isActive('heading', { level: 1 }) ?? false}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        title="一级标题"
        icon={<Heading1Icon className="w-4 h-4" />}
      />
      <ToolbarBtn
        active={editor?.isActive('heading', { level: 2 }) ?? false}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        title="二级标题"
        icon={<Heading2Icon className="w-4 h-4" />}
      />
      <ToolbarBtn
        active={editor?.isActive('heading', { level: 3 }) ?? false}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        title="三级标题"
        icon={<Heading3Icon className="w-4 h-4" />}
      />

      <div className="w-px h-5 bg-border mx-1" />

      {/* 列表 */}
      <ToolbarBtn
        active={editor?.isActive('bulletList') ?? false}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
        title="无序列表"
        icon={<ListIcon className="w-4 h-4" />}
      />
      <ToolbarBtn
        active={editor?.isActive('orderedList') ?? false}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        title="有序列表"
        icon={<ListOrderedIcon className="w-4 h-4" />}
      />
      <ToolbarBtn
        active={editor?.isActive('taskList') ?? false}
        onClick={() => editor?.chain().focus().toggleTaskList().run()}
        title="待办事项"
        icon={<ListTodoIcon className="w-4 h-4" />}
      />

      <div className="w-px h-5 bg-border mx-1" />

      {/* 功能按钮组 */}
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
        active={worldWindowOpen}
        onClick={handleToggleWorldWindow}
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
