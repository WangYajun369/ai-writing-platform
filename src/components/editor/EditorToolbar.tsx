/**
 * EditorToolbar — 编辑器顶部工具栏
 *
 * 提供返回书库、目录树折叠、专注模式切换、
 * 版本历史/世界观/AI 面板开关等功能按钮。
 * 世界观资料库打开为独立悬浮窗口。
 *
 * 子组件拆分到 ./toolbar/ 目录：
 *  - ToolbarBtn / TooltipWrap → 通用按钮与提示
 *  - SaveIndicator       → 保存状态指示器
 *  - ColorPickerPopover  → 字体颜色选择器弹窗
 *  - TablePopover        → 表格网格弹窗（内化 gridHover）
 *  - CodeLanguageSelect  → 代码块语言切换
 *  - constants           → 预设颜色 / 代码语言列表
 */
import { useAtom, useAtomValue } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import {
  ArrowLeftIcon,
  SidebarIcon,
  BotIcon,
  BookMarkedIcon,
  BookOpenIcon,
  ClockIcon,
  LayoutIcon,
  TypeIcon,
  MinusIcon,
  PlusIcon,
  ImageIcon,
  CropIcon,
  Code2Icon,
  BoldIcon,
  PaletteIcon,
  TableIcon,
  Trash2Icon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  WrenchIcon,
} from 'lucide-react'
import {
  sidebarOpenAtom,
  zenModeAtom,
  aiPanelOpenAtom,
  editorInstanceAtom,
  historyWindowOpenAtom,
  worldWindowOpenAtom,
  summaryWindowOpenAtom,
  aiToolboxWindowOpenAtom,
} from '@/stores/uiAtoms.ts'
import { useCurrentBook, useCurrentChapter, useAppStore } from '@/stores/appStore.ts'
import { cn } from '@/lib/utils.ts'
import { processEditorImage, processCroppedEditorImage } from '@/lib/image-utils.ts'
import { windowApi } from '@/lib/tauri-bridge'
import ImageCropperDialog from './ImageCropperDialog'
import { ToolbarBtn, TooltipWrap } from './toolbar/ToolbarBtn'
import { SaveIndicator } from './toolbar/SaveIndicator'
import { ColorPickerPopover } from './toolbar/ColorPickerPopover'
import { TablePopover } from './toolbar/TablePopover'
import { CodeLanguageSelect } from './toolbar/CodeLanguageSelect'

/**
 * 统一的窗口开关处理函数
 *
 * 四个窗口（World / History / Summary / AiToolbox）拥有相同的开关模式：
 *   open → 调用 windowApi.close*() → setOpen(false)
 *   close → 前置条件检查 → windowApi.open*() → setOpen(true)
 */
async function toggleWindow(
  isOpen: boolean,
  setOpen: (v: boolean) => void,
  closeFn: () => Promise<void>,
  openFn: () => Promise<boolean | void>,
  labels: { open: string; close: string },
) {
  if (isOpen) {
    try {
      await closeFn()
    } catch (e) {
      console.error(`关闭${labels.close}失败`, e)
    }
    setOpen(false)
  } else {
    const ok = await openFn()
    if (ok === false) return // 前置条件不满足，不改变状态
    setOpen(true)
  }
}

/** AI Toolbox / AI 助手渐变按钮 */
function GradientButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-all duration-300',
        active
          ? 'bg-gradient-to-r from-primary/90 to-primary text-primary-foreground shadow-md shadow-primary/25'
          : 'bg-gradient-to-r from-primary/15 via-primary/10 to-primary/15 text-primary border border-primary/20 hover:border-primary/40 hover:shadow-sm hover:shadow-primary/10',
      )}
    >
      {icon}
      <span className="tracking-wide">{label}</span>
      {!active && (
        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
      )}
    </button>
  )
}

export default function EditorToolbar() {
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const [zenMode, setZenMode] = useAtom(zenModeAtom)
  const [aiPanelOpen, setAiPanelOpen] = useAtom(aiPanelOpenAtom)
  const [historyWindowOpen, setHistoryWindowOpen] = useAtom(historyWindowOpenAtom)
  const [worldWindowOpen, setWorldWindowOpen] = useAtom(worldWindowOpenAtom)
  const [summaryWindowOpen, setSummaryWindowOpen] = useAtom(summaryWindowOpenAtom)
  const [aiToolboxWindowOpen, setAiToolboxWindowOpen] = useAtom(aiToolboxWindowOpenAtom)
  const currentBook = useCurrentBook()
  const currentBookId = useAppStore((s) => s.currentBookId)
  const currentChapter = useCurrentChapter()
  const { fontSize, setFontSize } = useAppStore()
  const editor = useAtomValue(editorInstanceAtom)

  // --- 颜色选择器 ---
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const colorPickerRef = useRef<HTMLDivElement>(null)
  const savedColorTargetRef = useRef<{ from: number; to: number } | null>(null)

  // --- 表格 ---
  const [tablePickerOpen, setTablePickerOpen] = useState(false)
  const tablePickerRef = useRef<HTMLDivElement>(null)
  const [isInTable, setIsInTable] = useState(false)

  // --- 图片裁剪 ---
  const [cropperOpen, setCropperOpen] = useState(false)
  const [cropperFilePath, setCropperFilePath] = useState('')

  // 监听编辑器选区变化，实时更新 isInTable 状态
  useEffect(() => {
    if (!editor) return
    const updateTableState = () => setIsInTable(editor.isActive('table'))
    updateTableState()
    editor.on('selectionUpdate', updateTableState)
    editor.on('transaction', updateTableState)
    return () => {
      editor.off('selectionUpdate', updateTableState)
      editor.off('transaction', updateTableState)
    }
  }, [editor])

  /** 打开/关闭颜色选择器，保存当前选区 */
  const handleToggleColorPicker = useCallback(() => {
    if (!colorPickerOpen && editor) {
      const { from, to } = editor.state.selection
      savedColorTargetRef.current = { from, to }
    }
    setColorPickerOpen((v) => !v)
  }, [colorPickerOpen, editor])

  // 点击外部关闭颜色/表格选择器
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

  /** 插入图片（压缩后以 Base64 内嵌，确保导出/导入自包含） */
  const handleInsertImage = useCallback(async () => {
    if (!editor) return
    try {
      const selected = await open({
        title: '选择图片',
        multiple: false,
        filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      })
      if (!selected) return
      const dataUrl = await processEditorImage(selected as string)
      editor.chain().focus().setImage({ src: dataUrl }).run()
    } catch (err) {
      console.error('插入图片失败', err)
    }
  }, [editor])

  /** 裁切插入图片：选择 → 裁剪 → 压缩 → 插入 */
  const handleInsertCroppedImage = useCallback(async () => {
    if (!editor) return
    try {
      const selected = await open({
        title: '选择图片',
        multiple: false,
        filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      })
      if (!selected) return
      setCropperFilePath(selected as string)
      setCropperOpen(true)
    } catch (err) {
      console.error('选择图片失败', err)
    }
  }, [editor])

  /** 裁剪确认 */
  const handleCropperConfirm = useCallback(async (crop: { x: number; y: number; width: number; height: number }) => {
    if (!editor || !cropperFilePath) return
    try {
      const dataUrl = await processCroppedEditorImage(cropperFilePath, crop)
      editor.chain().focus().setImage({ src: dataUrl }).run()
    } catch (err) {
      console.error('裁剪图片失败', err)
    } finally {
      setCropperOpen(false)
      setCropperFilePath('')
    }
  }, [editor, cropperFilePath])

  // ----- 窗口切换（使用统一的 toggleWindow）-----

  const handleToggleWorldWindow = useCallback(async () => {
    await toggleWindow(
      worldWindowOpen, setWorldWindowOpen,
      () => windowApi.closeWorld(),
      async () => {
        if (!currentBookId) return false
        await windowApi.openWorld(currentBookId)
      },
      { open: '世界观窗口', close: '世界观窗口' },
    )
  }, [worldWindowOpen, currentBookId, setWorldWindowOpen])

  const handleToggleHistoryWindow = useCallback(async () => {
    await toggleWindow(
      historyWindowOpen, setHistoryWindowOpen,
      () => windowApi.closeHistory(),
      async () => {
        if (!currentChapter) return false
        await windowApi.openHistory(currentChapter.id, currentChapter.bookId, currentChapter.title)
      },
      { open: '版本历史窗口', close: '版本历史窗口' },
    )
  }, [historyWindowOpen, currentChapter, setHistoryWindowOpen])

  const handleToggleSummaryWindow = useCallback(async () => {
    await toggleWindow(
      summaryWindowOpen, setSummaryWindowOpen,
      () => windowApi.closeSummary(),
      async () => {
        if (!currentChapter) return false
        await windowApi.openSummary(currentChapter.id, currentChapter.bookId, currentChapter.title)
      },
      { open: '章节总结窗口', close: '章节总结窗口' },
    )
  }, [summaryWindowOpen, currentChapter, setSummaryWindowOpen])

  const handleToggleAiToolboxWindow = useCallback(async () => {
    await toggleWindow(
      aiToolboxWindowOpen, setAiToolboxWindowOpen,
      () => windowApi.closeAiToolbox(),
      async () => {
        await windowApi.openAiToolbox()
      },
      { open: 'AI 工具箱窗口', close: 'AI 工具箱窗口' },
    )
  }, [aiToolboxWindowOpen, setAiToolboxWindowOpen])

  // 章节切换时，已打开的版本历史/总结窗口自动跟随
  useEffect(() => {
    if (!historyWindowOpen || !currentChapter) return
    windowApi.openHistory(currentChapter.id, currentChapter.bookId, currentChapter.title)
      .then(() => setHistoryWindowOpen(true))
      .catch((e) => {
        console.error('切换版本历史窗口失败', e)
        setHistoryWindowOpen(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter?.id])

  useEffect(() => {
    if (!summaryWindowOpen || !currentChapter) return
    windowApi.openSummary(currentChapter.id, currentChapter.bookId, currentChapter.title)
      .then(() => setSummaryWindowOpen(true))
      .catch((e) => {
        console.error('切换章节总结窗口失败', e)
        setSummaryWindowOpen(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter?.id])

  // 监听窗口被用户手动关闭（点 X），同步按钮状态
  useEffect(() => {
    const listeners: Promise<() => void>[] = [
      listen('world-window-closed', () => setWorldWindowOpen(false)),
      listen('history-window-closed', () => setHistoryWindowOpen(false)),
      listen('summary-window-closed', () => setSummaryWindowOpen(false)),
      listen('ai-toolbox-window-closed', () => setAiToolboxWindowOpen(false)),
    ]
    return () => {
      listeners.forEach((p) => p.then((fn) => fn()).catch(() => {}))
    }
  }, [])

  return (
    <header className="toolbar border-b bg-card px-4 py-2 flex items-center gap-2 flex-shrink-0 h-12">
      {/* 返回 */}
      <TooltipWrap title="返回书库">
        <button
          onClick={() => navigate('/')}
          className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground"
        >
          <ArrowLeftIcon className="w-4 h-4" />
        </button>
      </TooltipWrap>

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
        <TooltipWrap title="缩小字体">
          <button
            onClick={() => setFontSize(Math.max(12, fontSize - 1))}
            disabled={fontSize <= 12}
            className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <MinusIcon className="w-3.5 h-3.5" />
          </button>
        </TooltipWrap>
        <span className="text-xs text-muted-foreground w-7 text-center tabular-nums">{fontSize}px</span>
        <TooltipWrap title="放大字体">
          <button
            onClick={() => setFontSize(Math.min(24, fontSize + 1))}
            disabled={fontSize >= 24}
            className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <PlusIcon className="w-3.5 h-3.5" />
          </button>
        </TooltipWrap>
      </div>

      <div className="w-px h-5 bg-border mx-1" />

      {/* 插入图片 */}
      <ToolbarBtn active={false} onClick={handleInsertImage} title="插入图片" icon={<ImageIcon className="w-4 h-4" />} />

      {/* 裁切插入图片 */}
      <ToolbarBtn active={cropperOpen} onClick={handleInsertCroppedImage} title="裁切插入图片" icon={<CropIcon className="w-4 h-4" />} />

      {/* 代码块 */}
      <ToolbarBtn
        active={editor?.isActive('codeBlock') ?? false}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        title="代码块"
        icon={<Code2Icon className="w-4 h-4" />}
      />
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
            onClose={() => setTablePickerOpen(false)}
          />
        )}

        {/* 表格上下文操作按钮（仅在光标位于表格内时显示） */}
        {isInTable && !tablePickerOpen && (
          <>
            <span className="w-px h-4 bg-border mx-0.5" />
            <TooltipWrap title="删除当前行">
              <button
                onClick={() => editor?.chain().focus().deleteRow().run()}
                className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <MinusIcon className="w-3 h-3" />
                <span>删行</span>
              </button>
            </TooltipWrap>
            <TooltipWrap title="删除当前列">
              <button
                onClick={() => editor?.chain().focus().deleteColumn().run()}
                className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <MinusIcon className="w-3 h-3" />
                <span>删列</span>
              </button>
            </TooltipWrap>
            <TooltipWrap title="删除整个表格">
              <button
                onClick={() => editor?.chain().focus().deleteTable().run()}
                className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <Trash2Icon className="w-3 h-3" />
                <span>删表</span>
              </button>
            </TooltipWrap>
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
        active={summaryWindowOpen}
        onClick={handleToggleSummaryWindow}
        title="章节总结"
        icon={<BookOpenIcon className="w-4 h-4" />}
      />

      <ToolbarBtn
        active={historyWindowOpen}
        onClick={handleToggleHistoryWindow}
        title="版本历史"
        icon={<ClockIcon className="w-4 h-4" />}
      />

      <ToolbarBtn
        active={worldWindowOpen}
        onClick={handleToggleWorldWindow}
        title="世界观资料库"
        icon={<BookMarkedIcon className="w-4 h-4" />}
      />

      <TooltipWrap title="AI 工具箱">
        <GradientButton
          active={aiToolboxWindowOpen}
          onClick={handleToggleAiToolboxWindow}
          icon={<WrenchIcon className="w-3.5 h-3.5" />}
          label="AI 工具箱"
        />
      </TooltipWrap>

      <TooltipWrap title="AI 助手">
        <GradientButton
          active={aiPanelOpen}
          onClick={() => setAiPanelOpen((v) => !v)}
          icon={<BotIcon className="w-3.5 h-3.5" />}
          label="AI 助手"
        />
      </TooltipWrap>

      {/* 快速保存提示 */}
      <SaveIndicator />

      {/* 图片裁剪弹窗 */}
      {cropperOpen && cropperFilePath && (
        <ImageCropperDialog
          filePath={cropperFilePath}
          onConfirm={handleCropperConfirm}
          onClose={() => {
            setCropperOpen(false)
            setCropperFilePath('')
          }}
        />
      )}
    </header>
  )
}
