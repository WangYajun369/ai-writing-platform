/**
 * CompleteSummaryModal — 完成任务 · 填写总结（任务卡）
 *
 * 勾选「完成」时弹出：富文本总结编辑器（TipTap），支持加粗/斜体/删除线、
 * 无序/有序列表、引用、代码块、超链接、图片（压缩为 Base64 内嵌）。
 *
 * 交互：
 *  - 保存总结并完成：将 HTML 总结随 task_set_status(done) 写入 completion_summary
 *  - 跳过总结：直接置为完成（总结清空）
 *  - 已有总结会自动预填（重新打开后再完成时可在其上续写/覆盖）
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { open } from '@tauri-apps/plugin-dialog'
import {
  BoldIcon,
  CheckIcon,
  Code2Icon,
  EraserIcon,
  ImageIcon,
  ItalicIcon,
  Link2Icon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  Redo2Icon,
  StrikethroughIcon,
  Undo2Icon,
  UnlinkIcon,
  XIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { processEditorImage } from '@/lib/image-utils'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import type { TaskCard } from '@/types'
import './TaskDescriptionEditor.css'

interface Props {
  task: TaskCard
  /** 关闭（不完成任务） */
  onClose: () => void
  /** 保存总结并完成（或跳过）成功后回调；宿主可借此刷新自己的数据 */
  onCompleted?: () => void
}

/** 判断富文本内容是否实质为空（去标签后无可见文字） */
function htmlIsBlank(html: string): boolean {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
  return /^\s*$/.test(text)
}

/** 空内容归一为空串，保留有效 HTML */
function normalizeHtml(html: string): string {
  return htmlIsBlank(html) ? '' : html
}

export default function CompleteSummaryModal({ task, onClose, onCompleted }: Props) {
  const setStatus = useTaskCardsStore((s) => s.setStatus)
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const linkRef = useRef<HTMLDivElement>(null)

  const initial = task.completionSummary || '<p></p>'
  const [isEmpty, setIsEmpty] = useState(() => htmlIsBlank(task.completionSummary))

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        // codeBlock / horizontalRule 默认启用（总结支持代码块与分隔线）
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      Image.configure({ allowBase64: true }),
    ],
    content: initial,
    editorProps: {
      attributes: {
        class: 'task-desc-prose px-3 py-2',
      },
    },
    onUpdate: ({ editor: ed }) => {
      setIsEmpty(ed.isEmpty || htmlIsBlank(ed.getHTML()))
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  })

  // Esc 关闭（链接输入打开时优先收掉链接输入框）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (linkOpen) {
        setLinkOpen(false)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [linkOpen, onClose])

  // 点击链接输入框外部时收起
  useEffect(() => {
    if (!linkOpen) return
    function handleClick(e: MouseEvent) {
      if (linkRef.current && !linkRef.current.contains(e.target as Node)) {
        setLinkOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [linkOpen])

  /** 提交完成：保存总结（空串=跳过）并置为已完成 */
  const submit = async (summary: string) => {
    if (busy) return
    setBusy(true)
    try {
      await setStatus(task.id, 'done', summary)
      const name = summary ? '已完成并保存总结' : '已完成'
      toast.success(`「${task.title}」${name}`)
      onCompleted?.()
      onClose()
    } catch (err) {
      const msg = errText(err, '操作失败，请重试')
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  /** 打开链接输入框（已存在链接时回填） */
  const openLinkEditor = () => {
    if (!editor) return
    const href = editor.isActive('link') ? String(editor.getAttributes('link').href ?? '') : ''
    setLinkUrl(href)
    setLinkOpen(true)
  }

  /** 应用链接（空内容 = 移除链接） */
  const applyLink = () => {
    if (!editor) return
    const href = linkUrl.trim()
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    }
    setLinkOpen(false)
  }

  /** 插入图片：选文件 → 压缩 Base64 → 内嵌 */
  const handleInsertImage = async () => {
    if (!editor) return
    try {
      const selected = await open({
        title: '插入图片',
        multiple: false,
        filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      })
      if (!selected) return
      const dataUrl = await processEditorImage(selected as string)
      editor.chain().focus().setImage({ src: dataUrl }).run()
    } catch (err) {
      console.error('插入图片失败', err)
      toast.error('插入图片失败，请重试')
    }
  }

  const btn = (active: boolean, disabled: boolean) =>
    cn(
      'flex h-6.5 w-7 items-center justify-center rounded-md text-[12px] transition',
      disabled && 'cursor-not-allowed opacity-30',
      !disabled && (active ? 'bg-rose-500/25 text-rose-300' : 'text-zinc-400 hover:bg-white/8 hover:text-zinc-200'),
    )

  // 工具栏按钮定义：title / icon / isActive / can
  const groups: {
    key: string
    title: string
    icon: ReactNode
    active?: () => boolean
    can?: () => boolean
    run: () => boolean
  }[][] = [
    [
      {
        key: 'bold',
        title: '加粗',
        icon: <BoldIcon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('bold') ?? false,
        run: () => editor?.chain().focus().toggleBold().run() ?? false,
      },
      {
        key: 'italic',
        title: '斜体',
        icon: <ItalicIcon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('italic') ?? false,
        run: () => editor?.chain().focus().toggleItalic().run() ?? false,
      },
      {
        key: 'strike',
        title: '删除线',
        icon: <StrikethroughIcon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('strike') ?? false,
        run: () => editor?.chain().focus().toggleStrike().run() ?? false,
      },
    ],
    [
      {
        key: 'bullet',
        title: '无序列表',
        icon: <ListIcon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('bulletList') ?? false,
        run: () => editor?.chain().focus().toggleBulletList().run() ?? false,
      },
      {
        key: 'ordered',
        title: '有序列表',
        icon: <ListOrderedIcon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('orderedList') ?? false,
        run: () => editor?.chain().focus().toggleOrderedList().run() ?? false,
      },
      {
        key: 'quote',
        title: '引用',
        icon: <QuoteIcon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('blockquote') ?? false,
        run: () => editor?.chain().focus().toggleBlockquote().run() ?? false,
      },
      {
        key: 'codeBlock',
        title: '代码块',
        icon: <Code2Icon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('codeBlock') ?? false,
        run: () => editor?.chain().focus().toggleCodeBlock().run() ?? false,
      },
    ],
    [
      {
        key: 'link',
        title: '插入/编辑超链接',
        icon: editor?.isActive('link') ? <UnlinkIcon className="h-3.5 w-3.5" /> : <Link2Icon className="h-3.5 w-3.5" />,
        active: () => editor?.isActive('link') ?? false,
        run: () => {
          openLinkEditor()
          return true
        },
      },
      {
        key: 'image',
        title: '插入图片',
        icon: <ImageIcon className="h-3.5 w-3.5" />,
        run: () => {
          void handleInsertImage()
          return true
        },
      },
    ],
    [
      {
        key: 'clear',
        title: '清除格式',
        icon: <EraserIcon className="h-3.5 w-3.5" />,
        run: () => editor?.chain().focus().unsetAllMarks().run() ?? false,
      },
      {
        key: 'undo',
        title: '撤销',
        icon: <Undo2Icon className="h-3.5 w-3.5" />,
        can: () => editor?.can().chain().focus().undo().run() ?? false,
        run: () => editor?.chain().focus().undo().run() ?? false,
      },
      {
        key: 'redo',
        title: '重做',
        icon: <Redo2Icon className="h-3.5 w-3.5" />,
        can: () => editor?.can().chain().focus().redo().run() ?? false,
        run: () => editor?.chain().focus().redo().run() ?? false,
      },
    ],
  ]

  const showPlaceholder = isEmpty && !focused

  return (
    <div className="fixed inset-0 z-80 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[86vh] w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-white/12 bg-[#1a1a1d] shadow-2xl">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4 border-b border-white/8 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-zinc-100">完成任务 · 填写总结</h3>
            <p className="mt-0.5 truncate text-[12.5px] text-zinc-500">{task.title}</p>
          </div>
          <button
            type="button"
            title="取消（不完成任务）"
            disabled={busy}
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 transition hover:bg-white/8 hover:text-zinc-200 disabled:opacity-40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* 工具栏 */}
        {editor && (
          <div
            className="relative flex flex-wrap items-center gap-0.5 border-b border-white/8 px-2 py-1.5"
            onMouseDown={(e) => e.preventDefault()}
          >
            {groups.map((group, gi) => (
              <span key={gi} className="flex items-center gap-0.5">
                {group.map((b) => {
                  const disabled = b.can ? !b.can() : false
                  return (
                    <button
                      key={b.key}
                      title={b.title}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (!editor || disabled || busy) return
                        b.run()
                      }}
                      className={btn(b.active?.() ?? false, disabled)}
                    >
                      {b.icon}
                    </button>
                  )
                })}
                {gi < groups.length - 1 && <span className="mx-1 h-3.5 w-px bg-white/10" />}
              </span>
            ))}

            {/* 链接输入浮层 */}
            {linkOpen && (
              <div
                ref={linkRef}
                className="absolute left-2 top-[calc(100%+4px)] z-10 flex w-[380px] items-center gap-1.5 rounded-lg border border-white/12 bg-[#222226] p-2 shadow-xl"
                onMouseDown={(e) => e.preventDefault()}
              >
                <Link2Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <input
                  autoFocus
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      applyLink()
                    }
                  }}
                  placeholder="https://…"
                  spellCheck={false}
                  className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 text-[12.5px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-rose-400/60"
                />
                <button
                  type="button"
                  title="应用链接"
                  onClick={applyLink}
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-rose-500/80 text-white transition hover:bg-rose-500 disabled:opacity-40"
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                </button>
                {editor?.isActive('link') && (
                  <button
                    type="button"
                    title="移除链接"
                    onClick={() => {
                      editor.chain().focus().extendMarkRange('link').unsetLink().run()
                      setLinkOpen(false)
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/8 hover:text-zinc-200"
                  >
                    <UnlinkIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* 编辑区 */}
        <div className="relative flex-1 overflow-y-auto">
          {showPlaceholder && (
            <div className="pointer-events-none absolute left-3 top-2 z-0 text-[13px] text-zinc-600">
              记录本次完成的过程、成果或心得…（可插入图片、链接、代码块）
            </div>
          )}
          <EditorContent editor={editor} />
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between gap-3 border-t border-white/8 px-5 py-3.5">
          <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-zinc-600">
            重新打开任务后总结仍会保留，下次完成时可续写。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit('')}
            className="shrink-0 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-zinc-300 transition hover:bg-white/8 disabled:opacity-40"
          >
            跳过总结
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit(normalizeHtml(editor?.getHTML() ?? ''))}
            className="shrink-0 rounded-md bg-rose-500 px-3.5 py-1.5 text-[12.5px] font-medium text-white shadow transition hover:bg-rose-400 disabled:opacity-40"
          >
            {busy ? '提交中…' : '保存总结并完成'}
          </button>
        </div>
      </div>
    </div>
  )
}
