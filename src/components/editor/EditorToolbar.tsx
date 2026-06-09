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
  TableIcon,
  Trash2Icon,
  ArrowUpIcon,
  ArrowDownIcon,
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  ChevronDownIcon,
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

  // 表格选择器
  const [tablePickerOpen, setTablePickerOpen] = useState(false)
  const tablePickerRef = useRef<HTMLDivElement>(null)
  const [gridHover, setGridHover] = useState({ rows: 3, cols: 3 })
  const [isInTable, setIsInTable] = useState(false)

  // 监听编辑器选区变化，实时更新 isInTable 状态，
  // 确保点击表格时工具栏显示删行/删列/删表按钮，点击其他地方时隐藏
  useEffect(() => {
    if (!editor) return
    function updateTableState() {
      setIsInTable(editor?.isActive('table') ?? false)
    }
    updateTableState()
    editor.on('selectionUpdate', updateTableState)
    editor.on('transaction', updateTableState)
    return () => {
      editor.off('selectionUpdate', updateTableState)
      editor.off('transaction', updateTableState)
    }
  }, [editor])

  /** 打开/关闭颜色选择器，保存当前选区 */
  function handleToggleColorPicker() {
    if (editor && !colorPickerOpen) {
      const { from, to } = editor.state.selection
      savedColorTargetRef.current = { from, to }
    }
    setColorPickerOpen((v) => !v)
  }

  // 点击外部关闭颜色选择器/表格选择器
  useEffect(() => {
    if (!colorPickerOpen && !tablePickerOpen) return
    function handleClick(e: MouseEvent) {
      if (colorPickerOpen && colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false)
      }
      if (tablePickerOpen && tablePickerRef.current && !tablePickerRef.current.contains(e.target as Node)) {
        setTablePickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [colorPickerOpen, tablePickerOpen])

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
      {/* 代码语言选择器（仅在代码块内显示） */}
      {(editor?.isActive('codeBlock') ?? false) && <CodeLanguageSelect editor={editor} />}

      {/* 表格 */}
      <div className="relative flex items-center gap-1">
        <ToolbarBtn
          active={tablePickerOpen || isInTable}
          onClick={() => {
            setTablePickerOpen((v) => !v)
            setColorPickerOpen(false)
          }}
          title="表格"
          icon={<TableIcon className="w-4 h-4" />}
        />
        {tablePickerOpen && (
          <TablePopover
            ref={tablePickerRef}
            editor={editor}
            gridHover={gridHover}
            onGridHover={setGridHover}
            onClose={() => setTablePickerOpen(false)}
          />
        )}

        {/* 表格上下文操作按钮（仅在光标位于表格内时显示） */}
        {isInTable && !tablePickerOpen && (
          <>
            <span className="w-px h-4 bg-border mx-0.5" />
            <button
              onClick={() => editor?.chain().focus().deleteRow().run()}
              className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              title="删除当前行"
            >
              <MinusIcon className="w-3 h-3" />
              <span>删行</span>
            </button>
            <button
              onClick={() => editor?.chain().focus().deleteColumn().run()}
              className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              title="删除当前列"
            >
              <MinusIcon className="w-3 h-3" />
              <span>删列</span>
            </button>
            <button
              onClick={() => editor?.chain().focus().deleteTable().run()}
              className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              title="删除整个表格"
            >
              <Trash2Icon className="w-3 h-3" />
              <span>删表</span>
            </button>
          </>
        )}
      </div>

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

/**
 * 表格操作弹窗
 *
 * 提供表格网格尺寸选择器和行/列添加操作。
 * 删除行/列/表格操作已移至工具栏直接显示。
 */
const TablePopover = forwardRef<
  HTMLDivElement,
  {
    editor: ReturnType<typeof import('@tiptap/react').useEditor>
    gridHover: { rows: number; cols: number }
    onGridHover: (dim: { rows: number; cols: number }) => void
    onClose: () => void
  }
>(function TablePopover({ editor, gridHover, onGridHover, onClose }, ref) {
  const MAX_ROWS = 6
  const MAX_COLS = 6
  const isInTable = editor?.isActive('table') ?? false

  function handleInsertTable() {
    editor
      ?.chain()
      .focus()
      .insertTable({ rows: gridHover.rows, cols: gridHover.cols, withHeaderRow: true })
      .run()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 z-30 bg-popover border rounded-lg shadow-lg p-3 min-w-52"
    >
      {/* --- 表格内行/列添加操作 --- */}
      {isInTable && (
        <>
          <span className="text-xs font-medium text-muted-foreground block mb-2">添加行/列</span>

          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-xs text-muted-foreground w-8">行：</span>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addRowBefore().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在上方插入行"
            >
              <ArrowUpIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addRowAfter().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在下方插入行"
            >
              <ArrowDownIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="flex items-center gap-1 mb-2">
            <span className="text-xs text-muted-foreground w-8">列：</span>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addColumnBefore().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在左侧插入列"
            >
              <ArrowLeftToLineIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().addColumnAfter().run()}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              title="在右侧插入列"
            >
              <ArrowRightToLineIcon className="w-3 h-3" />
              <PlusIcon className="w-2.5 h-2.5" />
            </button>
          </div>

          <div className="h-px bg-border my-2" />
        </>
      )}

      {/* --- 网格尺寸选择器 --- */}
      <span className="text-xs font-medium text-muted-foreground block mb-2">插入表格</span>

      <div className="flex justify-center mb-2">
        <div
          className="inline-grid gap-0.5"
          style={{ gridTemplateColumns: `repeat(${MAX_COLS}, 1.5rem)` }}
        >
          {Array.from({ length: MAX_ROWS }, (_, row) =>
            Array.from({ length: MAX_COLS }, (_, col) => {
              const isActive = row < gridHover.rows && col < gridHover.cols
              return (
                <div
                  key={`${row}-${col}`}
                  onMouseEnter={() => onGridHover({ rows: row + 1, cols: col + 1 })}
                  onClick={handleInsertTable}
                  className={cn(
                    'w-6 h-6 rounded-sm border cursor-pointer transition-colors',
                    isActive
                      ? 'bg-primary/30 border-primary/50'
                      : 'border-border hover:border-muted-foreground/40'
                  )}
                />
              )
            })
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground mb-2">
        {gridHover.rows} × {gridHover.cols}
      </p>

      {/* 取消按钮 */}
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        className="w-full py-1.5 text-xs rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      >
        取消
      </button>
    </div>
  )
})

/** 代码块支持的语言列表 */
const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'plaintext', label: '纯文本' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'rust', label: 'Rust' },
  { value: 'java', label: 'Java' },
  { value: 'go', label: 'Go' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'scala', label: 'Scala' },
  { value: 'bash', label: 'Bash' },
  { value: 'shell', label: 'Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'less', label: 'Less' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'yaml', label: 'YAML' },
  { value: 'toml', label: 'TOML' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'nginx', label: 'Nginx' },
  { value: 'makefile', label: 'Makefile' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'ini', label: 'INI' },
  { value: 'diff', label: 'Diff' },
  { value: 'powershell', label: 'PowerShell' },
]

/**
 * 代码块语言选择器
 *
 * 在光标位于代码块内时显示，允许切换代码块的语言以实现语法高亮。
 */
function CodeLanguageSelect({ editor }: { editor: ReturnType<typeof import('@tiptap/react').useEditor> }) {
  const currentLang = (editor?.getAttributes('codeBlock').language ?? 'plaintext') as string
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const currentLabel = CODE_LANGUAGES.find((l) => l.value === currentLang)?.label ?? currentLang

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title="选择代码语言"
      >
        <span>{currentLabel}</span>
        <ChevronDownIcon className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 bg-popover border rounded-lg shadow-lg py-1 max-h-64 overflow-y-auto min-w-36">
          {CODE_LANGUAGES.map((lang) => (
            <button
              key={lang.value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor?.chain().focus().updateAttributes('codeBlock', { language: lang.value }).run()
                setOpen(false)
              }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                currentLang === lang.value
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
