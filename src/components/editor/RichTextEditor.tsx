import { useCallback, useEffect, useRef } from 'react'
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
} from '@/stores/uiAtoms.ts'
import { useAppStore, useCurrentChapter } from '@/stores/appStore.ts'
import { chapterApi } from '@/lib/tauri-bridge.ts'
import { cn, debounce, countWordsFromHtml } from '@/lib/utils.ts'

const AUTOSAVE_DEBOUNCE_MS = 300
const AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000 // 3 分钟

export default function RichTextEditor() {
  const currentChapter = useCurrentChapter()
  const { updateChapter } = useAppStore()
  const [, setEditorFocus] = useAtom(editorFocusAtom)
  const [, setIsSaving] = useAtom(isSavingAtom)
  const [, setLastSaved] = useAtom(lastSavedAtom)
  const [, setWordCount] = useAtom(wordCountAtom)
  const [typewriterMode] = useAtom(typewriterModeAtom)
  const autoSaveTimer = useRef<ReturnType<typeof setInterval>>(null)

  // 保存函数
  const saveContent = useCallback(
    async (html: string) => {
      if (!currentChapter) return
      setIsSaving(true)
      try {
        const { wordCount } = await chapterApi.save(currentChapter.id, html)
        updateChapter(currentChapter.id, { contentHtml: html, wordCount, updatedAt: new Date().toISOString() })
        setLastSaved(new Date())
        setWordCount((prev) => ({ ...prev, chapter: wordCount }))
      } catch (err) {
        console.error('保存失败', err)
      } finally {
        setIsSaving(false)
      }
    },
    [currentChapter, updateChapter, setIsSaving, setLastSaved, setWordCount]
  )

  // 防抖保存
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedSave = useCallback(debounce(saveContent as (...args: unknown[]) => unknown, AUTOSAVE_DEBOUNCE_MS), [saveContent])

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
      setWordCount((prev) => ({ ...prev, chapter: chars }))
      debouncedSave(html)
    },
    onFocus: () => setEditorFocus(true),
    onBlur: () => setEditorFocus(false),
  })

  // 当切换章节时更新内容
  useEffect(() => {
    if (!editor || !currentChapter) return
    const current = editor.getHTML()
    const incoming = currentChapter.contentHtml ?? '<p></p>'
    if (current !== incoming) {
      editor.commands.setContent(incoming, false)
    }
  }, [editor, currentChapter?.id]) // 只在章节 id 变化时触发

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
        {/* 章节标题展示 */}
        <h2 className="text-2xl font-bold px-8 mb-4 text-foreground/80">{currentChapter.title}</h2>
        {/* 编辑器正文 */}
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
