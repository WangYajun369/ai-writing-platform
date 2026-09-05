/**
 * RichTextEditor — TipTap 富文本编辑器
 *
 * 核心编辑器组件，集成：
 * - TipTap StarterKit + Underline + Color + Image + Table
 * - 双保险自动保存：300ms 防抖 + 3 分钟定时器
 * - 章节标题内联编辑
 * - 字数实时统计
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { errText } from '@/lib/errors'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'

const lowlight = createLowlight(common)
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { ResizableImage } from './ResizableImageExtension'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import CharacterCount from '@tiptap/extension-character-count'
import { useAtom } from 'jotai'
import { useShortcut } from '@/hooks/useShortcut'
import {
  editorFocusAtom,
  editorInstanceAtom,
  isSavingAtom,
  lastSavedAtom,
  wordCountAtom,
  contentRefreshAtom,
  editorScrollPositionAtom,
  editorCursorPositionAtom,
} from '@/stores/uiAtoms.ts'
import { useCurrentChapter, getEditorState } from '@/stores/appStore'
import { useBooksStore } from '@/stores/booksStore'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { chapterApi } from '@/lib/tauri-bridge.ts'
import { countWordsFromHtml, calcBookWordCount } from '@/lib/utils.ts'
import { toast } from '@/lib/toast.ts'
import { isEditorUsable } from '@/lib/editor-guard.ts'

const AUTOSAVE_DEBOUNCE_MS = 300
const AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000 // 3 分钟

// ─── 会话级草稿保护（离线/崩溃恢复） ───
// 每次击键同步写入 sessionStorage；内容成功入库后清除。
// 会话内章节内容未落库即发生崩溃/误关/切章时，回到该章可恢复。
const DRAFT_KEY_PREFIX = 'mi_draft:'

interface SessionDraft {
  html: string
  savedAt: number
}

const draftKeyFor = (bookId: string, chapterId: string) =>
  `${DRAFT_KEY_PREFIX}${bookId}:${chapterId}`

function readDraft(bookId: string, chapterId: string): SessionDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKeyFor(bookId, chapterId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionDraft
    return typeof parsed.html === 'string' ? parsed : null
  } catch {
    return null
  }
}

function writeDraft(bookId: string, chapterId: string, html: string) {
  try {
    sessionStorage.setItem(
      draftKeyFor(bookId, chapterId),
      JSON.stringify({ html, savedAt: Date.now() } satisfies SessionDraft),
    )
  } catch {
    // sessionStorage 不可用时静默降级（不影响正常编辑）
  }
}

function clearDraft(bookId: string, chapterId: string) {
  try {
    sessionStorage.removeItem(draftKeyFor(bookId, chapterId))
  } catch {
    // 忽略清除失败
  }
}

const EDITOR_WIDTH_CLASS: Record<string, string> = {
  mobile: 'max-w-md',
  standard: 'max-w-3xl',
  wide: 'max-w-5xl',
}

export default function RichTextEditor() {
  const currentChapter = useCurrentChapter()
  const { updateChapter, updateBook, chapters } = useBooksStore()
  const { editorWidth, saveCurrentEditorState } = usePreferencesStore()
  const [, setEditorFocus] = useAtom(editorFocusAtom)
  const [, setEditorInstance] = useAtom(editorInstanceAtom)
  const [, setIsSaving] = useAtom(isSavingAtom)
  const [, setLastSaved] = useAtom(lastSavedAtom)
  const [, setWordCount] = useAtom(wordCountAtom)
  const [contentRefresh] = useAtom(contentRefreshAtom)
  const [, setScrollPosition] = useAtom(editorScrollPositionAtom)
  const [, setCursorPosition] = useAtom(editorCursorPositionAtom)
  const autoSaveTimer = useRef<ReturnType<typeof setInterval>>(null)
  // 编辑器滚动容器 ref（用于保存/恢复滚动位置）
  const editorScrollRef = useRef<HTMLDivElement>(null)
  // 标记是否已完成首次位置恢复
  const positionRestoredRef = useRef(false)
  // 保存编辑器状态定时器（防抖）
  const saveEditorStateTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 用 ref 保持最新引用，避免 useEditor onUpdate 闭包过期
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  const currentChapterRef = useRef(currentChapter)
  currentChapterRef.current = currentChapter

  // 防抖 timer ref（用于跨章节切换时清除旧 timer，避免旧章节数据覆盖新章节）
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 保存函数（持久化 + 用后端返回的全书总字数校正 wordCountAtom.total）
  const saveContent = useCallback(
    async (html: string) => {
      const chapter = currentChapterRef.current
      if (!chapter) {
        console.warn('[自动保存] 跳过：当前章节为空')
        return
      }
      console.log('[自动保存] 开始保存章节', chapter.id, '字数:', countWordsFromHtml(html))
      setIsSaving(true)
      try {
        const frontendCount = countWordsFromHtml(html)
        const result = await chapterApi.save(chapter.id, html, frontendCount)
        console.log('[自动保存] 保存成功，后端返回:', result)
        updateChapter(chapter.id, { contentHtml: html, wordCount: frontendCount, updatedAt: new Date().toISOString() })
        updateBook(chapter.bookId, { wordCount: result.bookWordCount })
        setWordCount({ chapter: frontendCount, total: result.bookWordCount })
        setLastSaved(new Date())
        // 已成功入库：清除会话草稿，避免下次加载误恢复
        clearDraft(chapter.bookId, chapter.id)
      } catch (err) {
        const msg = errText(err, '未知错误')
        console.error('[自动保存] 保存失败', msg)
        toast.error(`保存失败：${msg}`)
      } finally {
        setIsSaving(false)
      }
    },
    [updateChapter, updateBook, setWordCount, setIsSaving, setLastSaved]
  )

  // 防抖保存（使用 ref 存 timer，切换章节时清除旧 timer 防止泄漏）
  const debouncedSave = useCallback((html: string) => {
    // 击键即写会话草稿（崩溃/误关兜底，不依赖防抖定时器是否触发）
    const chapter = currentChapterRef.current
    if (chapter) writeDraft(chapter.bookId, chapter.id, html)
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => saveContent(html), AUTOSAVE_DEBOUNCE_MS)
  }, [saveContent])
  const debouncedSaveRef = useRef(debouncedSave)
  debouncedSaveRef.current = debouncedSave

  // 章节切换时取消待处理的防抖保存
  useEffect(() => {
    return () => clearTimeout(saveTimerRef.current)
  }, [currentChapter?.id])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: null,
      }),
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
    content: currentChapter?.contentHtml ?? '<p></p>',
    editorProps: {
      attributes: {
        class: 'tiptap-editor min-h-[60vh] px-8 py-6 outline-none',
        'data-placeholder': '开始你的故事…',
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      const chars = countWordsFromHtml(html)
      const cur = currentChapterRef.current
      const total = calcBookWordCount(chaptersRef.current, cur?.id, chars)
      setWordCount({ chapter: chars, total })
      debouncedSaveRef.current(html)
    },
    onFocus: () => setEditorFocus(true),
    onBlur: () => setEditorFocus(false),
  })
  // 同步 editor 实例到 atom，供工具栏等外部组件使用
  useEffect(() => {
    // StrictMode 下编辑器可能已被销毁（commandManager 为 null），
    // 此时不能把已销毁实例暴露给外部组件，需置为 null
    setEditorInstance(isEditorUsable(editor) ? editor : null)
    return () => setEditorInstance(null)
  }, [editor, setEditorInstance])
  // 当切换章节时加载并设置内容
  useEffect(() => {
    if (!editor || !currentChapter) return
    let cancelled = false
    ;(async () => {
      try {
        // list_chapters 不返回 contentHtml，需要单独请求
        const html = await chapterApi.getContent(currentChapter.id)
        // await 期间组件可能已卸载或编辑器已被销毁（StrictMode）
        if (!cancelled && isEditorUsable(editor)) {
          const current = editor.getHTML()
          const incoming = html || '<p></p>'
          // 会话草稿恢复：该章存在未成功入库的草稿且与库中内容不同 → 优先草稿并提示
          let finalHtml = incoming
          const draft = readDraft(currentChapter.bookId, currentChapter.id)
          if (draft && draft.html !== incoming) {
            finalHtml = draft.html
            clearDraft(currentChapter.bookId, currentChapter.id)
            toast.info('已恢复未保存的编辑草稿')
          }
          if (current !== finalHtml) {
            editor.commands.setContent(finalHtml, { emitUpdate: false })
          }
          const chapterCount = countWordsFromHtml(finalHtml)
          const totalCount = calcBookWordCount(chaptersRef.current, currentChapter.id, chapterCount)
          setWordCount({ chapter: chapterCount, total: totalCount })
          // 恢复上次编辑位置
          const savedState = getEditorState(currentChapter.bookId)
          if (savedState && savedState.chapterId === currentChapter.id && !positionRestoredRef.current) {
            // 延迟恢复，等 DOM 渲染完成
            requestAnimationFrame(() => {
              // rAF 回调执行时编辑器可能已被销毁（StrictMode），需再次校验
              if (!isEditorUsable(editor)) return
              // 恢复滚动位置
              if (savedState.scrollTop > 0 && editorScrollRef.current) {
                editorScrollRef.current.scrollTop = savedState.scrollTop
              }
              // 恢复光标位置
              if (savedState.cursorPos && editor.isEditable) {
                try {
                  editor.commands.setTextSelection({
                    from: savedState.cursorPos.from,
                    to: savedState.cursorPos.to,
                  })
                  // 滚动到光标所在位置
                  const { from } = savedState.cursorPos
                  const domPos = editor.view.coordsAtPos(from)
                  if (domPos && editorScrollRef.current) {
                    const containerRect = editorScrollRef.current.getBoundingClientRect()
                    const offset = domPos.top - containerRect.top - containerRect.height * 0.3
                    if (offset > 0) {
                      editorScrollRef.current.scrollTop += offset
                    }
                  }
                } catch {
                  // 光标位置可能失效，忽略
                }
              }
              positionRestoredRef.current = true
            })
          }
        }
      } catch (err) {
        console.error('加载章节内容失败', err)
      }
    })()
    return () => { cancelled = true }
  }, [editor, currentChapter?.id, contentRefresh]) // 章节切换或外部刷新时触发

  // 定时自动保存（3 分钟）
  useEffect(() => {
    if (!isEditorUsable(editor)) return
    const timer = setInterval(() => {
      // 定时器回调执行时编辑器可能已被销毁（StrictMode）
      if (!isEditorUsable(editor)) return
      const html = editor.getHTML()
      void saveContent(html)
    }, AUTOSAVE_INTERVAL_MS)
    // @ts-ignore
    autoSaveTimer.current = timer
    return () => clearInterval(timer)
  }, [editor, saveContent])

  // 防抖保存编辑器状态：使用 ref 保持最新 saveCurrentEditorState，避免闭包过期
  const saveEditorStateRef = useRef(saveCurrentEditorState)
  saveEditorStateRef.current = saveCurrentEditorState

  const debouncedSaveEditorState = useCallback(
    (bookId: string, chapterId: string, scrollTop: number, cursorPos: { from: number; to: number } | null) => {
      clearTimeout(saveEditorStateTimerRef.current)
      saveEditorStateTimerRef.current = setTimeout(() => {
        saveEditorStateRef.current(bookId, chapterId, scrollTop, cursorPos)
      }, 500)
    },
    [], // 空依赖，通过 ref 获取最新函数
  )

  // 跟踪编辑器滚动位置
  useEffect(() => {
    const scrollEl = editorScrollRef.current
    if (!scrollEl || !currentChapter) return
    const handleScroll = () => {
      const top = scrollEl.scrollTop
      setScrollPosition(top)
      // 编辑器可能已被销毁，读取 state 前需校验
      const sel = isEditorUsable(editor) ? editor.state.selection : null
      const cursorPos = sel ? { from: sel.from, to: sel.to } : null
      setCursorPosition(cursorPos)
      const ch = currentChapterRef.current
      if (ch) debouncedSaveEditorState(ch.bookId, ch.id, top, cursorPos)
    }
    scrollEl.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', handleScroll)
  }, [editor, currentChapter, setScrollPosition, setCursorPosition, debouncedSaveEditorState])

  // 跟踪光标/选区变化
  useEffect(() => {
    if (!isEditorUsable(editor) || !currentChapter) return
    const handleSelectionUpdate = () => {
      if (!isEditorUsable(editor)) return
      const { from, to } = editor.state.selection
      setCursorPosition({ from, to })
      const scrollTop = editorScrollRef.current?.scrollTop ?? 0
      const ch = currentChapterRef.current
      if (ch) debouncedSaveEditorState(ch.bookId, ch.id, scrollTop, { from, to })
    }
    editor.on('selectionUpdate', handleSelectionUpdate)
    return () => {
      editor.off('selectionUpdate', handleSelectionUpdate)
    }
  }, [editor, currentChapter, setCursorPosition, debouncedSaveEditorState])

  // 组件卸载或章节切换时，立即保存当前编辑位置
  useEffect(() => {
    const bookId = currentChapter?.bookId
    const chapterId = currentChapter?.id
    return () => {
      clearTimeout(saveEditorStateTimerRef.current)
      if (!bookId || !chapterId) return
      const scrollTop = editorScrollRef.current?.scrollTop ?? 0
      // 卸载时编辑器可能已被销毁，读取 state 前需校验
      const sel = isEditorUsable(editor) ? editor.state.selection : null
      const cursorPos = sel ? { from: sel.from, to: sel.to } : null
      saveEditorStateRef.current(bookId, chapterId, scrollTop, cursorPos)
    }
  }, [currentChapter?.id, currentChapter?.bookId])

  // 章节切换时重置位置恢复标记
  useEffect(() => {
    positionRestoredRef.current = false
  }, [currentChapter?.id])

  // Ctrl+S / Cmd+S 手动保存（集中式快捷键系统：mod+s）
  const editorUsable = isEditorUsable(editor)
  useShortcut(
    'mod+s',
    (e) => {
      // 快捷键触发时编辑器可能已被销毁（StrictMode）
      if (!isEditorUsable(editor)) return
      e.preventDefault()
      const html = editor.getHTML()
      console.log('[手动保存] mod+S 触发')
      saveContent(html)
    },
    { enabled: editorUsable, preventDefault: false },
  )

  // 章节标题编辑
  const [titleValue, setTitleValue] = useState(currentChapter?.title ?? '')
  useEffect(() => setTitleValue(currentChapter?.title ?? ''), [currentChapter?.id, currentChapter?.title])

  async function handleTitleBlur() {
    if (!currentChapter) return
    const trimmed = titleValue.trim()
    if (!trimmed || trimmed === currentChapter.title) return
    try {
      await chapterApi.rename(currentChapter.id, trimmed)
      updateChapter(currentChapter.id, { title: trimmed })
    } catch (err) {
      console.error('重命名章节失败', err)
      setTitleValue(currentChapter.title)
    }
  }

  if (!currentChapter) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p>从左侧目录选择或新建章节开始创作</p>
      </div>
    )
  }

  return (
    <div ref={editorScrollRef} className="flex-1 overflow-y-auto bg-background">
      <div className={`${EDITOR_WIDTH_CLASS[editorWidth] ?? 'max-w-3xl'} mx-auto py-8`}>
        {/* 章节标题（可直接编辑） */}
        <input
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          style={{ fontSize: 'calc(var(--font-editor-size, 16px) * 1.5)' }}
          className="w-full font-bold px-8 mb-1 bg-transparent outline-none border-b-2 border-transparent focus:border-primary/30 transition-colors text-foreground/80 placeholder:text-muted-foreground/40"
          placeholder="输入章节标题…"
        />
        {/* 编辑器正文 */}
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
