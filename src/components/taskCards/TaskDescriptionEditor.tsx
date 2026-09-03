/**
 * TaskDescriptionEditor — 任务描述富文本编辑器（任务卡）
 *
 * 基于 TipTap：轻量工具栏（加粗/斜体/删除线/列表/引用/清除格式/撤销重做）。
 * 编辑区可通过右下角手柄垂直调整高度（最小 108px，最大 55vh）。
 *
 * 保存策略：内容变化即时经 onChange 上抛（供新建模式读取）；
 * 失焦（blur）时若与最近一次保存值不同再触发 onSave（详情模式即时保存）。
 * 兼容旧数据：纯文本描述在挂载时自动按行转段，无需迁移。
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  BoldIcon,
  EraserIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  Redo2Icon,
  StrikethroughIcon,
  Undo2Icon,
} from 'lucide-react'
import { cn, legacyTextToHtml } from '@/lib/utils'
import './TaskDescriptionEditor.css'

interface Props {
  /** 初始内容（纯文本旧数据自动兼容；外部更新不在此回填） */
  value: string
  placeholder?: string
  /** 每次内容变化上抛（新建模式用于读取最终 HTML） */
  onChange?: (html: string) => void
  /** 失焦保存上抛（详情模式即时保存） */
  onSave?: (html: string) => void
  className?: string
}

/** 判断富文本内容是否实质为空（去标签后无可见文字） */
function htmlIsBlank(html: string): boolean {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
  return /^\s*$/.test(text)
}

export default function TaskDescriptionEditor({ value, placeholder, onChange, onSave, className }: Props) {
  const initial = legacyTextToHtml(value)
  const lastSavedRef = useRef(initial)
  const [isEmpty, setIsEmpty] = useState(() => htmlIsBlank(initial))
  const [focused, setFocused] = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
      }),
    ],
    content: initial,
    editorProps: {
      attributes: {
        class: 'task-desc-prose px-3 py-2',
      },
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML()
      setIsEmpty(ed.isEmpty || htmlIsBlank(html))
      onChange?.(html)
    },
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false)
      const html = editor?.getHTML() ?? ''
      if (html !== lastSavedRef.current) {
        lastSavedRef.current = html
        onSave?.(html)
      }
    },
  })

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
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-white/10 bg-black/20 transition focus-within:border-rose-400/50',
        className,
      )}
    >
      {/* 工具栏（阻止 mousedown，避免点击工具让编辑器先失焦保存旧内容） */}
      {editor && (
        <div
          className="flex flex-wrap items-center gap-0.5 border-b border-white/8 px-1.5 py-1"
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
                      if (!editor || disabled) return
                      b.run()
                    }}
                    className={btn(b.active?.() ?? false, disabled)}
                  >
                    {b.icon}
                  </button>
                )
              })}
              {gi < groups.length - 1 && <span className="mx-0.5 h-3.5 w-px bg-white/10" />}
            </span>
          ))}
        </div>
      )}

      {/* 可调整高度的编辑区 */}
      <div className="task-desc-resizer">
        <div className="relative">
          {showPlaceholder && (
            <div className="pointer-events-none absolute left-3 top-2 text-[13px] text-zinc-600">
              {placeholder ?? '补充任务内容或验收标准…'}
            </div>
          )}
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}
