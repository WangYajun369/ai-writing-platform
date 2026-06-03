import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Image from '@tiptap/extension-image'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import CharacterCount from '@tiptap/extension-character-count'
import { useAtom } from 'jotai'
import {
  editorFocusAtom,
  isSavingAtom,
  lastSavedAtom,
  wordCountAtom,
  typewriterModeAtom,
  contentRefreshAtom,
} from '@/stores/uiAtoms.ts'
import { useAppStore, useCurrentChapter } from '@/stores/appStore.ts'
import { chapterApi } from '@/lib/tauri-bridge.ts'
import { cn, debounce, countWordsFromHtml, calcBookWordCount } from '@/lib/utils.ts'

const AUTOSAVE_DEBOUNCE_MS = 300
const AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000 // 3 分钟

export default function RichTextEditor() {
  const currentChapter = useCurrentChapter()
  const { updateChapter, updateBook, chapters } = useAppStore()
  const [, setEditorFocus] = useAtom(editorFocusAtom)
  const [, setIsSaving] = useAtom(isSavingAtom)
  const [, setLastSaved] = useAtom(lastSavedAtom)
  const [, setWordCount] = useAtom(wordCountAtom)
  const [typewriterMode] = useAtom(typewriterModeAtom)
  const [contentRefresh] = useAtom(contentRefreshAtom)
  const autoSaveTimer = useRef<ReturnType<typeof setInterval>>(null)
  // 用 ref 保持最新引用，避免 useEditor onUpdate 闭包过期
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  const currentChapterRef = useRef(currentChapter)
  currentChapterRef.current = currentChapter

  // 保存函数（持久化 + 用后端返回的全书总字数校正 wordCountAtom.total）
  const saveContent = useCallback(
    async (html: string) => {
      if (!currentChapter) return
      setIsSaving(true)
      try {
        const result = await chapterApi.save(currentChapter.id, html)
        const frontendCount = countWordsFromHtml(html)
        updateChapter(currentChapter.id, { contentHtml: html, wordCount: frontendCount, updatedAt: new Date().toISOString() })
        updateBook(currentChapter.bookId, { wordCount: result.bookWordCount })
        setWordCount({ chapter: frontendCount, total: result.bookWordCount })
        setLastSaved(new Date())
      } catch (err) {
        console.error('保存失败', err)
      } finally {
        setIsSaving(false)
      }
    },
    [currentChapter, updateChapter, updateBook, setWordCount, setIsSaving, setLastSaved]
  )

  // 防抖保存
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSave = useCallback(debounce(saveContent as (...args: unknown[]) => unknown, AUTOSAVE_DEBOUNCE_MS), [saveContent])
  const debouncedSaveRef = useRef(debouncedSave)
  debouncedSaveRef.current = debouncedSave

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
      }),
      Underline,
      TextStyle,
      Color,
      Image.configure({ inline: false, allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      CharacterCount,
    ],
    content: currentChapter?.contentHtml ?? '<p></p>',
    editorProps: {
      attributes: {
        class: cn(
          'tiptap-editor min-h-[60vh] px-8 py-6 outline-none',
          typewriterMode && 'typewriter-mode'
        ),
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

  // 当切换章节时加载并设置内容
  useEffect(() => {
    if (!editor || !currentChapter) return
    let cancelled = false
    ;(async () => {
      try {
        // list_chapters 不返回 contentHtml，需要单独请求
        const html = await chapterApi.getContent(currentChapter.id)
        if (!cancelled) {
          const current = editor.getHTML()
          const incoming = html || '<p></p>'
          if (current !== incoming) {
            editor.commands.setContent(incoming, false)
          }
          const chapterCount = countWordsFromHtml(incoming)
          const totalCount = calcBookWordCount(chaptersRef.current, currentChapter.id, chapterCount)
          setWordCount({ chapter: chapterCount, total: totalCount })
        }
      } catch (err) {
        console.error('加载章节内容失败', err)
      }
    })()
    return () => { cancelled = true }
  }, [editor, currentChapter?.id, contentRefresh]) // 章节切换或外部刷新时触发

  // 定时自动保存（3 分钟）
  useEffect(() => {
    if (!editor) return
    const timer = setInterval(() => {
      const html = editor.getHTML()
      saveContent(html)
    }, AUTOSAVE_INTERVAL_MS)
    // @ts-ignore
    autoSaveTimer.current = timer
    return () => clearInterval(timer)
  }, [editor, saveContent])

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
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="max-w-3xl mx-auto py-8">
        {/* 章节标题（可直接编辑） */}
        <input
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="w-full text-2xl font-bold px-8 mb-1 bg-transparent outline-none border-b-2 border-transparent focus:border-primary/30 transition-colors text-foreground/80 placeholder:text-muted-foreground/40"
          placeholder="输入章节标题…"
        />
        {/* 编辑器正文 */}
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
