/**
 * EditorToolbar — 编辑器顶部工具栏
 *
 * 提供返回书库、目录树折叠、专注模式切换、
 * 版本历史/世界观/AI 面板开关等功能按钮。
 * 世界观资料库打开为独立悬浮窗口。
 */
import { useAtom, useAtomValue } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback, useRef, forwardRef } from 'react'
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
  BoldIcon,
  PaletteIcon,
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

/** 预设字体颜色 */
const PRESET_COLORS = [
  '#1a1a1a', '#4a4a4a', '#8c8c8c', '#bfbfbf',
  '#e03131', '#e8590c', '#f08c00', '#2f9e44',
  '#1971c2', '#7048e8', '#9c36b5', '#c2255c',
]

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
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const colorPickerRef = useRef<HTMLDivElement>(null)
  // 保存打开颜色选择器前的编辑器选区，防止选区丢失导致无法应用颜色
  const savedColorTargetRef = useRef<{ from: number; to: number } | null>(null)

  /** 打开/关闭颜色选择器，保存当前选区 */
  function handleToggleColorPicker() {
    if (editor && !colorPickerOpen) {
      const { from, to } = editor.state.selection
      savedColorTargetRef.current = { from, to }
    }
    setColorPickerOpen((v) => !v)
  }

  // 点击外部关闭颜色选择器
  useEffect(() => {
    if (!colorPickerOpen) return
    function handleClick(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [colorPickerOpen])

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

      {/* 加粗 */}
      <ToolbarBtn
        active={editor?.isActive('bold') ?? false}
        onClick={() => editor?.chain().focus().toggleBold().run()}
        title="加粗"
        icon={<BoldIcon className="w-4 h-4" />}
      />

      {/* 字体颜色 */}
      <div className="relative">
        <ToolbarBtn
          active={colorPickerOpen}
          onClick={handleToggleColorPicker}
          title="字体颜色"
          icon={<PaletteIcon className="w-4 h-4" />}
        />
        {colorPickerOpen && (
          <ColorPickerPopover
            ref={colorPickerRef}
            currentColor={editor?.getAttributes('textStyle').color ?? null}
            onSelectColor={(color) => {
              if (editor) {
                // 恢复打开选择器前保存的选区
                const target = savedColorTargetRef.current
                if (target && target.from !== target.to) {
                  editor.commands.setTextSelection({ from: target.from, to: target.to })
                }
                savedColorTargetRef.current = null
                if (color) {
                  editor.chain().focus().setColor(color).run()
                } else {
                  editor.chain().focus().unsetColor().run()
                }
              }
              setColorPickerOpen(false)
            }}
          />
        )}
      </div>

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

/**
 * 字体颜色选择器弹窗
 *
 * 展示预设色块网格 + 自定义颜色输入 + 清除颜色按钮。
 */
const ColorPickerPopover = forwardRef<
  HTMLDivElement,
  {
    currentColor: string | null
    onSelectColor: (color: string | null) => void
  }
>(function ColorPickerPopover({ currentColor, onSelectColor }, ref) {
  const [customColor, setCustomColor] = useState('#000000')

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 z-30 bg-popover border rounded-lg shadow-lg p-3 min-w-52"
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">字体颜色</span>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelectColor(null)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="清除颜色"
        >
          还原默认
        </button>
      </div>

      {/* 当前颜色指示 */}
      {currentColor && (
        <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
          <span>当前：</span>
          <span
            className="inline-block w-4 h-4 rounded border border-border"
            style={{ backgroundColor: currentColor }}
          />
          <span className="font-mono">{currentColor}</span>
        </div>
      )}

      {/* 预设颜色网格 */}
      <div className="grid grid-cols-6 gap-1.5 mb-2">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelectColor(color)}
            className="w-7 h-7 rounded border border-border hover:scale-110 transition-transform"
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>

      {/* 分隔线 */}
      <div className="h-px bg-border mb-2" />

      {/* 自定义颜色 */}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={customColor}
          onChange={(e) => setCustomColor(e.target.value)}
          className="w-8 h-8 rounded border border-border cursor-pointer p-0 bg-transparent"
        />
        <span className="text-xs text-muted-foreground font-mono flex-1">{customColor}</span>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelectColor(customColor)}
          className="px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
        >
          应用
        </button>
      </div>
    </div>
  )
})
