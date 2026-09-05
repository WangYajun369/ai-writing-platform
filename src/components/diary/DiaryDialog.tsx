/**
 * DiaryDialog — 日记撰写 / 编辑弹窗
 *
 * 顶部工具头与作品详情（编辑器页 EditorToolbar）的内容格式工具栏保持一致
 * （字号、插入/裁剪图片、代码块、表格、加粗、字体颜色、标题、列表），
 * 但剔除所有 AI 相关工具与作品级工具（目录树、章节总结、版本历史、世界观等）。
 *
 * 特性：
 * - 300ms 防抖自动保存 + Ctrl/Cmd+S + 关闭前自动落盘
 * - 内容清空时自动删除该日日记
 * - 关键字由正文自动提取，保存后展示于底部状态栏
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errText } from '@/lib/errors'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import CharacterCount from '@tiptap/extension-character-count'
import { open } from '@tauri-apps/plugin-dialog'
import {
  BoldIcon,
  Code2Icon,
  CropIcon,
  ImageIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  Loader2Icon,
  MinusIcon,
  NotebookPenIcon,
  PaletteIcon,
  PlusIcon,
  TableCellsMergeIcon,
  TableCellsSplitIcon,
  TableIcon,
  Trash2Icon,
  TypeIcon,
  XIcon,
} from 'lucide-react'
import { diaryApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { countWordsFromHtml } from '@/lib/utils'
import { isEditorUsable } from '@/lib/editor-guard'
import { processEditorImage, processCroppedEditorImage } from '@/lib/image-utils'
import { extractKeywords, formatDiaryTime, formatFullDateLabel, toDateKey } from '@/lib/diary-utils'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { ToolbarBtn, TooltipWrap } from '@/components/editor/toolbar/ToolbarBtn'
import { HeadingSelect } from '@/components/editor/toolbar/HeadingSelect'
import { CodeLanguageSelect } from '@/components/editor/toolbar/CodeLanguageSelect'
import { ColorPickerPopover } from '@/components/editor/toolbar/ColorPickerPopover'
import { TablePopover } from '@/components/editor/toolbar/TablePopover'
import { canMergeCells, hasSplittableCell } from '@/components/editor/toolbar/table-utils'
import { ResizableImage } from '@/components/editor/ResizableImageExtension'
import ImageCropperDialog from '@/components/editor/ImageCropperDialog'

const lowlight = createLowlight(common)

/** 自动保存防抖间隔 */
const AUTOSAVE_DEBOUNCE_MS = 300
/** 删除二次确认自动复原时间 */
const CONFIRM_DELETE_MS = 2500

interface DiaryDialogProps {
  /** 日记日期 YYYY-MM-DD */
  diaryDate: string
  onClose: () => void
  /** 保存/删除成功后通知父级刷新列表 */
  onChanged: (diaryDate: string) => void
}

/** HTML → 纯文本（用于关键字提取 / 空内容判断） */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.innerText || doc.body.textContent || '').replace(/\s+/g, ' ').trim()
}

/** 打开系统文件选择框（图片） */
async function pickImage(): Promise<string | null> {
  const selected = await open({
    title: '选择图片',
    multiple: false,
    filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  })
  return typeof selected === 'string' ? selected : null
}

export default function DiaryDialog({ diaryDate, onClose, onChanged }: DiaryDialogProps) {
  const { fontSize, setFontSize } = usePreferencesStore()

  // ── 保存相关状态 ──
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [wordCount, setWordCount] = useState(0)
  const [keywordPreview, setKeywordPreview] = useState<string[]>([])
  const latestHtmlRef = useRef('<p></p>')
  /** 保存基线：与当前存储内容一致时跳过保存 */
  const initialContentRef = useRef('<p></p>')
  /** 该日期是否已有日记记录 */
  const existedRef = useRef(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistBusyRef = useRef(false)
  const persistQueuedRef = useRef(false)

  // ── 表格 / 颜色 / 裁剪 UI 状态 ──
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const colorPickerRef = useRef<HTMLDivElement>(null)
  const colorAnchorRef = useRef<HTMLDivElement>(null)
  const savedColorTargetRef = useRef<{ from: number; to: number } | null>(null)
  const [tablePickerOpen, setTablePickerOpen] = useState(false)
  const tablePickerRef = useRef<HTMLDivElement>(null)
  const tableAnchorRef = useRef<HTMLDivElement>(null)
  const [isInTable, setIsInTable] = useState(false)
  const [canMerge, setCanMerge] = useState(false)
  const [canSplit, setCanSplit] = useState(false)
  const [cropperOpen, setCropperOpen] = useState(false)
  const [cropperFilePath, setCropperFilePath] = useState('')

  // ── 删除二次确认 ──
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isToday = diaryDate === toDateKey(new Date())
  /** 日期中文标题：2026年9月2日 星期三 */
  const dateTitle = useMemo(() => formatFullDateLabel(diaryDate), [diaryDate])

  // 引用保持最新（onUpdate / 卸载前落盘使用）
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // ── 编辑器 ──
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
      TextStyle,
      Color,
      ResizableImage.configure({ inline: false, allowBase64: true }),
      TaskList,
      TaskItem,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      CharacterCount,
    ],
    content: '<p></p>',
    editorProps: {
      attributes: {
        class: 'tiptap-editor px-8 py-6 outline-none',
        'data-placeholder': '此刻的心情，想写点什么…',
      },
    },
    onUpdate: ({ editor: ed }) => {
      latestHtmlRef.current = ed.getHTML()
      setWordCount(countWordsFromHtml(latestHtmlRef.current))
      setKeywordPreview(extractKeywords(htmlToText(latestHtmlRef.current)))
      scheduleSave()
    },
  })

  /** 加载该日期已有日记 */
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await diaryApi.get(diaryDate)
        if (cancelled || !editor || editor.isDestroyed) return
        const html = data?.contentHtml ?? ''
        const nextHtml = html || '<p></p>'
        existedRef.current = !!data
        initialContentRef.current = nextHtml
        latestHtmlRef.current = nextHtml
        setLastSavedAt(data ? new Date(data.updatedAt) : null)
        setKeywordPreview(extractKeywords(htmlToText(html)))
        editor.commands.setContent(nextHtml)
        setWordCount(countWordsFromHtml(html))
      } catch (err) {
        console.error('加载日记失败', err)
        toast.error(`加载日记失败：${errText(err, '未知错误')}`)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [diaryDate, editor])

  /** 防抖触发保存 */
  function scheduleSave() {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void persistRef.current()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  /** 执行保存（幂等：无变化 / 无内容时不落盘；内容清空则删除该日记录） */
  const persist = useCallback(async (): Promise<void> => {
    if (persistBusyRef.current) {
      persistQueuedRef.current = true
      return
    }
    persistBusyRef.current = true
    try {
      const html = latestHtmlRef.current
      const empty = htmlToText(html).length === 0

      // 内容清空：删除该日日记（若已存在）
      if (empty) {
        if (existedRef.current) {
          try {
            await diaryApi.delete(diaryDate)
            existedRef.current = false
            initialContentRef.current = '<p></p>'
            setLastSavedAt(null)
            setKeywordPreview([])
            onChangedRef.current(diaryDate)
          } catch (err) {
            console.error('清空日记删除失败', err)
            toast.error(`删除日记失败：${errText(err, '未知错误')}`)
          }
        }
        return
      }

      // 内容未变化则跳过
      if (html === initialContentRef.current) return

      setSaving(true)
      try {
        const count = countWordsFromHtml(html)
        const keywords = extractKeywords(htmlToText(html))
        await diaryApi.save({ diaryDate, contentHtml: html, wordCount: count, keywords })
        initialContentRef.current = html
        existedRef.current = true
        setLastSavedAt(new Date())
        setKeywordPreview(keywords)
        onChangedRef.current(diaryDate)
      } catch (err) {
        console.error('保存日记失败', err)
        toast.error(`保存日记失败：${errText(err, '未知错误')}`)
      } finally {
        setSaving(false)
      }
    } finally {
      persistBusyRef.current = false
      if (persistQueuedRef.current) {
        persistQueuedRef.current = false
        void persistRef.current()
      }
    }
  }, [diaryDate])
  const persistRef = useRef(persist)
  persistRef.current = persist

  /** 关闭：先落盘再关闭 */
  const handleClose = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    await persistRef.current()
    onCloseRef.current()
  }, [])
  const handleCloseRef = useRef(handleClose)
  handleCloseRef.current = handleClose

  // Esc 关闭 / Ctrl+S 保存
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
          debounceTimerRef.current = null
        }
        void persistRef.current()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        void handleCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 卸载前兜底落盘（正常关闭路径已通过 handleClose 落盘，此为兜底）
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      const html = latestHtmlRef.current
      if (html && html !== initialContentRef.current) {
        void (async () => {
          try {
            await diaryApi.save({
              diaryDate,
              contentHtml: html,
              wordCount: countWordsFromHtml(html),
              keywords: extractKeywords(htmlToText(html)),
            })
          } catch (err) {
            console.error('卸载兜底保存失败', err)
          }
        })()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diaryDate])

  // 卸载时清理删除确认定时器
  useEffect(() => {
    return () => {
      if (confirmDeleteTimerRef.current) clearTimeout(confirmDeleteTimerRef.current)
    }
  }, [])

  // ── 表格状态监听 ──
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const updateTableState = () => {
      if (editor.isDestroyed) return
      setIsInTable(editor.isActive('table'))
      setCanMerge(canMergeCells(editor))
      setCanSplit(hasSplittableCell(editor))
    }
    updateTableState()
    editor.on('selectionUpdate', updateTableState)
    editor.on('transaction', updateTableState)
    return () => {
      editor.off('selectionUpdate', updateTableState)
      editor.off('transaction', updateTableState)
    }
  }, [editor])

  // ── 颜色 / 表格选择器点击外部关闭 ──
  useEffect(() => {
    if (!colorPickerOpen && !tablePickerOpen) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (colorPickerOpen && colorPickerRef.current && !colorPickerRef.current.contains(target)) {
        setColorPickerOpen(false)
      }
      if (tablePickerOpen && tablePickerRef.current && !tablePickerRef.current.contains(target)) {
        setTablePickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [colorPickerOpen, tablePickerOpen])

  const usableEditor = isEditorUsable(editor) ? editor : null

  // ── 图片 ──
  const handleInsertImage = useCallback(async () => {
    if (!usableEditor) return
    try {
      const filePath = await pickImage()
      if (!filePath) return
      if (!isEditorUsable(usableEditor)) return
      const dataUrl = await processEditorImage(filePath)
      usableEditor.chain().focus().setImage({ src: dataUrl }).run()
    } catch (err) {
      console.error('插入图片失败', err)
    }
  }, [usableEditor])

  const handleInsertCroppedImage = useCallback(async () => {
    if (!usableEditor) return
    try {
      const filePath = await pickImage()
      if (!filePath) return
      setCropperFilePath(filePath)
      setCropperOpen(true)
    } catch (err) {
      console.error('选择图片失败', err)
    }
  }, [usableEditor])

  const handleCropperConfirm = useCallback(
    async (crop: { x: number; y: number; width: number; height: number }) => {
      if (!usableEditor || !cropperFilePath) return
      try {
        const dataUrl = await processCroppedEditorImage(cropperFilePath, crop)
        if (!isEditorUsable(usableEditor)) return
        usableEditor.chain().focus().setImage({ src: dataUrl }).run()
      } catch (err) {
        console.error('裁剪图片失败', err)
        toast.error('图片裁剪失败')
      } finally {
        setCropperOpen(false)
        setCropperFilePath('')
      }
    },
    [usableEditor, cropperFilePath],
  )

  const handleToggleColorPicker = useCallback(() => {
    if (!colorPickerOpen && usableEditor) {
      const { from, to } = usableEditor.state.selection
      savedColorTargetRef.current = { from, to }
    }
    setColorPickerOpen((v) => !v)
  }, [colorPickerOpen, usableEditor])

  // ── 删除 ──
  const handleDelete = useCallback(async () => {
    setConfirmDelete(false)
    if (confirmDeleteTimerRef.current) clearTimeout(confirmDeleteTimerRef.current)
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    try {
      await diaryApi.delete(diaryDate)
      toast.success('日记已删除')
      onChangedRef.current(diaryDate)
      onCloseRef.current()
    } catch (err) {
      console.error('删除日记失败', err)
      toast.error(`删除日记失败：${errText(err, '未知错误')}`)
    }
  }, [diaryDate])

  const requestDelete = useCallback(() => {
    setConfirmDelete(true)
    if (confirmDeleteTimerRef.current) clearTimeout(confirmDeleteTimerRef.current)
    confirmDeleteTimerRef.current = setTimeout(() => setConfirmDelete(false), CONFIRM_DELETE_MS)
  }, [])

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void handleCloseRef.current()
      }}
    >
      <div className="bg-background rounded-xl shadow-2xl border flex flex-col overflow-hidden w-[min(900px,94vw)] h-[min(80vh,780px)]">
        {/* ─── 标题栏 ─── */}
        <div className="h-11 px-3 border-b bg-card flex items-center gap-2 shrink-0">
          <NotebookPenIcon className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-semibold whitespace-nowrap">{dateTitle}</span>
          {isToday && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-primary/15 text-primary font-medium shrink-0">
              今天
            </span>
          )}
          <div className="flex-1" />

          {/* 保存状态 */}
          {saving ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <Loader2Icon className="w-3 h-3 animate-spin" />
              保存中…
            </span>
          ) : lastSavedAt ? (
            <span className="text-xs text-muted-foreground/80 shrink-0" title="最近一次自动保存时间">
              已保存 {formatDiaryTime(lastSavedAt.toISOString())}
            </span>
          ) : (
            loaded && (
              <span className="text-xs text-muted-foreground/80 shrink-0">自动保存已开启</span>
            )
          )}

          {/* 删除（二次确认） */}
          {confirmDelete ? (
            <button
              onClick={() => void handleDelete()}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-destructive text-white text-xs font-medium hover:opacity-90 transition-opacity shrink-0"
            >
              确认删除
            </button>
          ) : (
            <TooltipWrap title="删除这篇日记">
              <button
                onClick={requestDelete}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
              >
                <Trash2Icon className="w-4 h-4" />
              </button>
            </TooltipWrap>
          )}

          <div className="w-px h-5 bg-border mx-0.5 shrink-0" />

          <TooltipWrap title="关闭 (Esc)">
            <button
              onClick={() => void handleClose()}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </TooltipWrap>
        </div>

        {/* ─── 内容格式工具头（与作品详情一致，无 AI 工具） ─── */}
        <div className="toolbar border-b bg-card px-4 py-1.5 flex items-center gap-2 shrink-0 overflow-x-auto scrollbar-hide">
          {/* 字体大小 */}
          <div className="flex items-center gap-1 shrink-0">
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

          <div className="w-px h-5 bg-border mx-1 shrink-0" />

          {/* 插入图片 */}
          <ToolbarBtn active={false} onClick={() => void handleInsertImage()} title="插入图片" icon={<ImageIcon className="w-4 h-4" />} />

          {/* 裁切插入图片 */}
          <ToolbarBtn active={cropperOpen} onClick={() => void handleInsertCroppedImage()} title="裁切插入图片" icon={<CropIcon className="w-4 h-4" />} />

          {/* 代码块 */}
          <ToolbarBtn
            active={usableEditor?.isActive('codeBlock') ?? false}
            onClick={() => usableEditor?.chain().focus().toggleCodeBlock().run()}
            title="代码块"
            icon={<Code2Icon className="w-4 h-4" />}
          />
          {(usableEditor?.isActive('codeBlock') ?? false) && <CodeLanguageSelect editor={usableEditor} />}

          {/* 表格 */}
          <div ref={tableAnchorRef} className="relative flex items-center gap-1 shrink-0">
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
                editor={usableEditor}
                onClose={() => setTablePickerOpen(false)}
                canMergeCells={canMerge}
                canSplitCell={canSplit}
                anchorRef={tableAnchorRef}
                popoverRef={tablePickerRef}
              />
            )}

            {/* 表格上下文操作（光标位于表格内时） */}
            {isInTable && !tablePickerOpen && (
              <>
                <span className="w-px h-4 bg-border mx-0.5 shrink-0" />
                {canMerge && (
                  <TooltipWrap title="合并选中的单元格">
                    <button
                      onClick={() => usableEditor?.chain().focus().mergeCells().run()}
                      className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors shrink-0 whitespace-nowrap"
                    >
                      <TableCellsMergeIcon className="w-3 h-3" />
                      <span>合并</span>
                    </button>
                  </TooltipWrap>
                )}
                {canSplit && (
                  <TooltipWrap title="拆分当前单元格">
                    <button
                      onClick={() => usableEditor?.chain().focus().splitCell().run()}
                      className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors shrink-0 whitespace-nowrap"
                    >
                      <TableCellsSplitIcon className="w-3 h-3" />
                      <span>拆分</span>
                    </button>
                  </TooltipWrap>
                )}
                <TooltipWrap title="删除当前行">
                  <button
                    onClick={() => usableEditor?.chain().focus().deleteRow().run()}
                    className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0 whitespace-nowrap"
                  >
                    <MinusIcon className="w-3 h-3" />
                    <span>删行</span>
                  </button>
                </TooltipWrap>
                <TooltipWrap title="删除当前列">
                  <button
                    onClick={() => usableEditor?.chain().focus().deleteColumn().run()}
                    className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0 whitespace-nowrap"
                  >
                    <MinusIcon className="w-3 h-3" />
                    <span>删列</span>
                  </button>
                </TooltipWrap>
                <TooltipWrap title="删除整个表格">
                  <button
                    onClick={() => usableEditor?.chain().focus().deleteTable().run()}
                    className="flex items-center gap-0.5 px-1.5 py-1 rounded text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0 whitespace-nowrap"
                  >
                    <Trash2Icon className="w-3 h-3" />
                    <span>删表</span>
                  </button>
                </TooltipWrap>
              </>
            )}
          </div>

          <div className="w-px h-5 bg-border mx-1 shrink-0" />

          {/* 加粗 */}
          <ToolbarBtn
            active={usableEditor?.isActive('bold') ?? false}
            onClick={() => usableEditor?.chain().focus().toggleBold().run()}
            title="加粗"
            icon={<BoldIcon className="w-4 h-4" />}
          />

          {/* 字体颜色 */}
          <div ref={colorAnchorRef} className="relative shrink-0">
            <ToolbarBtn
              active={colorPickerOpen}
              onClick={handleToggleColorPicker}
              title="字体颜色"
              icon={<PaletteIcon className="w-4 h-4" />}
            />
            {colorPickerOpen && (
              <ColorPickerPopover
                currentColor={usableEditor?.getAttributes('textStyle').color ?? null}
                onSelectColor={(color) => {
                  if (usableEditor) {
                    const target = savedColorTargetRef.current
                    if (target && target.from !== target.to) {
                      usableEditor.commands.setTextSelection({ from: target.from, to: target.to })
                    }
                    savedColorTargetRef.current = null
                    if (color) {
                      usableEditor.chain().focus().setColor(color).run()
                    } else {
                      usableEditor.chain().focus().unsetColor().run()
                    }
                  }
                  setColorPickerOpen(false)
                }}
                anchorRef={colorAnchorRef}
                popoverRef={colorPickerRef}
              />
            )}
          </div>

          <div className="w-px h-5 bg-border mx-1 shrink-0" />

          {/* 标题 */}
          <HeadingSelect editor={usableEditor} />

          <div className="w-px h-5 bg-border mx-1 shrink-0" />

          {/* 列表 */}
          <ToolbarBtn
            active={usableEditor?.isActive('bulletList') ?? false}
            onClick={() => usableEditor?.chain().focus().toggleBulletList().run()}
            title="无序列表"
            icon={<ListIcon className="w-4 h-4" />}
          />
          <ToolbarBtn
            active={usableEditor?.isActive('orderedList') ?? false}
            onClick={() => usableEditor?.chain().focus().toggleOrderedList().run()}
            title="有序列表"
            icon={<ListOrderedIcon className="w-4 h-4" />}
          />
          <ToolbarBtn
            active={usableEditor?.isActive('taskList') ?? false}
            onClick={() => usableEditor?.chain().focus().toggleTaskList().run()}
            title="待办事项"
            icon={<ListTodoIcon className="w-4 h-4" />}
          />
        </div>

        {/* ─── 编辑区 ─── */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-background">
          <EditorContent editor={editor} />
        </div>

        {/* ─── 底部状态栏 ─── */}
        <div className="h-9 px-4 border-t bg-card flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          {keywordPreview.length > 0 ? (
            <>
              <span className="shrink-0">关键字</span>
              <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                {keywordPreview.slice(0, 6).map((kw) => (
                  <span
                    key={kw}
                    className="px-1.5 py-px text-[10px] rounded bg-primary/10 text-primary/80 border border-primary/15 whitespace-nowrap"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground/60 truncate">
              {loaded ? '写完后自动提取关键字，方便日后回顾' : '正在加载…'}
            </span>
          )}
          <div className="flex-1" />
          <span className="tabular-nums shrink-0">{wordCount.toLocaleString()} 字</span>
        </div>
      </div>

      {/* 图片裁剪弹窗 */}
      {cropperOpen && (
        <ImageCropperDialog
          filePath={cropperFilePath}
          onConfirm={(crop) => void handleCropperConfirm(crop)}
          onClose={() => {
            setCropperOpen(false)
            setCropperFilePath('')
          }}
        />
      )}
    </div>
  )
}
