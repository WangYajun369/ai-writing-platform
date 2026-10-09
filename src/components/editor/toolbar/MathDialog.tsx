/**
 * MathDialog — 公式插入弹窗（含符号面板，支持数学 / 化学两种模式）
 *
 * 居中模态弹窗：左侧为 LaTeX 输入框 + 实时预览，右侧为分类符号面板。
 * 符号面板为「分类堆叠」布局：所有分类在同一滚动区域内垂直排列，
 * 每个分类带吸顶标题行（中文 + 英文），顶部分类标签为锚点导航，
 * 点击平滑滚动到对应分类；滚动时自动高亮当前可见分类。
 * 点击符号直接插入到光标位置；每个符号均用 KaTeX 实时渲染。
 * 模式切换：数学（KaTeX 原生）／化学（KaTeX mhchem \ce{} 渲染化学式与反应式）。
 * 通过 createPortal 渲染到 document.body，点击遮罩或按 Esc 关闭。
 */
import { useState, useEffect, useMemo, memo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import katex from 'katex'
import type { Editor } from '@tiptap/react'
import { MATH_SYMBOL_CATEGORIES, CHEMISTRY_SYMBOL_CATEGORIES } from './math-symbols'
import type { MathSymbolCategory } from './math-symbols'
import type { MathEditRequest } from '@/stores/uiAtoms'

interface MathDialogProps {
  editor: Editor | null
  onClose: () => void
  /** 编辑模式：双击已有公式节点时传入；null 表示新建插入 */
  editing?: MathEditRequest | null
}

type MathType = 'inline' | 'block'
type Mode = 'math' | 'chemistry'

/** 剥离 \ce{...} 外层，提取化学式的内部源（用于编辑已有化学式节点） */
function stripCe(latex: string): string {
  if (latex.startsWith('\\ce{') && latex.endsWith('}')) {
    return latex.slice(4, -1)
  }
  return latex
}

export const MathDialog = memo(function MathDialog({
  editor,
  onClose,
  editing = null,
}: MathDialogProps) {
  const [mathType, setMathType] = useState<MathType>(editing?.type ?? 'inline')
  // 模式：编辑已有 \ce{} 节点时自动识别为化学；新建时默认数学
  const [mode, setMode] = useState<Mode>(
    editing?.latex?.startsWith('\\ce{') ? 'chemistry' : 'math',
  )
  const [latex, setLatex] = useState(editing ? stripCe(editing.latex ?? '') : '')
  // 当前模式对应的符号分类（数学 / 化学）
  const categories = mode === 'chemistry' ? CHEMISTRY_SYMBOL_CATEGORIES : MATH_SYMBOL_CATEGORIES
  // 符号面板：当前高亮的分类（锚点导航同步）
  const [activeKey, setActiveKey] = useState(categories[0].key)
  // 切换模式时重置高亮分类到该模式的第一个分类
  useEffect(() => {
    setActiveKey(categories[0].key)
  }, [mode, categories])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const symbolScrollRef = useRef<HTMLDivElement>(null)

  // 打开时自动聚焦输入框
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  /** 点击分类导航：平滑滚动到对应分类 */
  const scrollToCategory = useCallback((key: string) => {
    setActiveKey(key)
    document
      .getElementById(`math-cat-${key}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // 滚动符号面板时，根据当前可见的分类标题同步高亮导航
  useEffect(() => {
    const container = symbolScrollRef.current
    if (!container) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // 滚动到底部时直接高亮最后一个分类
        // （末分类内容可能不够高，标题永远到不了判定区）
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 8) {
          setActiveKey(categories[categories.length - 1].key)
          return
        }
        const containerTop = container.getBoundingClientRect().top
        let current = categories[0].key
        for (const el of Array.from(container.querySelectorAll('[data-cat-heading]'))) {
          // 标题越过容器顶部 80px 内即视为当前分类
          if (el.getBoundingClientRect().top - containerTop <= 80) {
            current = el.getAttribute('data-cat-heading') as string
          } else {
            break
          }
        }
        setActiveKey(current)
      })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [categories])

  // 实时预览（化学模式自动用 \ce{} 包裹）
  const previewHtml = useMemo(() => {
    if (!latex.trim()) return ''
    const src = mode === 'chemistry' ? `\\ce{${latex}}` : latex
    try {
      return katex.renderToString(src, {
        displayMode: mathType === 'block',
        throwOnError: false,
      })
    } catch {
      return ''
    }
  }, [latex, mathType, mode])

  /** 将符号插入到光标位置 */
  const insertSymbol = useCallback(
    (text: string) => {
      const el = textareaRef.current
      if (!el) return
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      const before = latex.slice(0, start)
      const after = latex.slice(end)
      const newText = before + text + after
      setLatex(newText)
      // 光标移到插入文本之后
      requestAnimationFrame(() => {
        const newPos = start + text.length
        el.setSelectionRange(newPos, newPos)
        el.focus()
      })
    },
    [latex],
  )

  const handleInsert = () => {
    if (!editor || !latex.trim()) return
    // 化学模式：存储时统一包裹 \ce{}；数学模式原样存储
    const finalLatex = mode === 'chemistry' ? `\\ce{${latex}}` : latex
    if (editing) {
      // 编辑模式：更新已有节点
      if (mathType === 'inline') {
        editor.chain().focus().updateInlineMath({ latex: finalLatex, pos: editing.pos }).run()
      } else {
        editor.chain().focus().updateBlockMath({ latex: finalLatex, pos: editing.pos }).run()
      }
    } else {
      // 插入模式：新建节点
      if (mathType === 'inline') {
        editor.chain().focus().insertInlineMath({ latex: finalLatex }).run()
      } else {
        editor.chain().focus().insertBlockMath({ latex: finalLatex }).run()
      }
    }
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleInsert()
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        // 点击遮罩关闭（点到内容区不触发）
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-popover border rounded-xl shadow-2xl flex w-[900px] max-w-[92vw] h-[85vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ─── 左侧：输入 + 预览 ─── */}
        <div className="flex flex-col flex-1 min-w-0 p-4 gap-3">
          {/* 标题栏 */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {editing ? '编辑公式' : '插入公式'}
              <span className="text-muted-foreground font-normal">（{mode === 'chemistry' ? '化学' : '数学'}）</span>
            </span>
            <button
              onClick={onClose}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors px-1"
              title="关闭 (Esc)"
            >
              ✕
            </button>
          </div>

          {/* 模式切换：数学 / 化学（编辑已有节点时锁定，由节点内容推断） */}
          {!editing && (
            <div className="flex gap-1 p-1 bg-muted rounded-md">
              <button
                onClick={() => setMode('math')}
                className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
                  mode === 'math'
                    ? 'bg-background shadow-sm font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                数学
              </button>
              <button
                onClick={() => setMode('chemistry')}
                className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
                  mode === 'chemistry'
                    ? 'bg-background shadow-sm font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                化学
              </button>
            </div>
          )}

          {/* 类型切换：编辑模式下隐藏（节点类型不可变） */}
          {!editing && (
            <div className="flex gap-1 p-1 bg-muted rounded-md">
              <button
                onClick={() => setMathType('inline')}
                className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
                  mathType === 'inline'
                    ? 'bg-background shadow-sm font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                行内公式
              </button>
              <button
                onClick={() => setMathType('block')}
                className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
                  mathType === 'block'
                    ? 'bg-background shadow-sm font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                块级公式
              </button>
            </div>
          )}

          {/* LaTeX 输入 */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">
              {mode === 'chemistry' ? '化学式（mhchem \\ce{}）' : 'LaTeX 源码'}
            </div>
            <textarea
              ref={textareaRef}
              value={latex}
              onChange={(e) => setLatex(e.target.value)}
              placeholder={
                mode === 'chemistry'
                  ? '输入化学式，如 H2O + CO2 -> H2CO3（自动渲染为 \\ce{}）…'
                  : '在此输入 LaTeX 源码，或从右侧点击符号插入…'
              }
              className="w-full h-32 px-3 py-2 text-sm font-mono bg-background border rounded-md resize-none outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* 实时预览 */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="text-xs text-muted-foreground mb-1.5">实时预览</div>
            <div className="flex-1 min-h-28 p-4 bg-muted/50 rounded-md border border-border/50 flex items-center justify-center overflow-auto">
              {previewHtml ? (
                <div
                  className={mathType === 'block' ? 'text-lg' : 'text-base'}
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <span className="text-sm text-muted-foreground">输入 LaTeX 后此处实时渲染</span>
              )}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleInsert}
              disabled={!latex.trim()}
              className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {editing ? '更新 (⌘+Enter)' : '插入 (⌘+Enter)'}
            </button>
          </div>
        </div>

        {/* ─── 右侧：符号面板（分类堆叠 + 统一滚动） ─── */}
        <div className="w-[380px] border-l flex flex-col shrink-0">
          {/* 分类锚点导航 */}
          <div className="flex flex-wrap gap-1.5 p-3 border-b bg-muted/30">
            {categories.map((cat) => (
              <button
                key={cat.key}
                onClick={() => scrollToCategory(cat.key)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  activeKey === cat.key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {cat.title}
              </button>
            ))}
          </div>

          {/* 全部分类垂直堆叠，统一滚动；分类标题吸顶 */}
          <div ref={symbolScrollRef} className="flex-1 overflow-y-auto min-h-0">
            {categories.map((cat) => (
              <section key={cat.key} id={`math-cat-${cat.key}`}>
                <div
                  data-cat-heading={cat.key}
                  className="sticky top-0 z-10 flex items-baseline gap-2 px-3 py-1.5 bg-popover border-b border-border/50"
                >
                  <span className="text-xs font-semibold">{cat.title}</span>
                  <span className="text-[11px] text-muted-foreground">{cat.titleEn}</span>
                </div>
                <div className="p-3 pt-2">
                  <SymbolGrid category={cat} onInsert={insertSymbol} />
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
})

/**
 * SymbolGrid — 单个分类的符号网格
 *
 * 每个符号用 KaTeX 实时渲染为预览图，点击插入。
 */
interface SymbolGridProps {
  category: MathSymbolCategory
  onInsert: (text: string) => void
}

function SymbolGrid({ category, onInsert }: SymbolGridProps) {
  const rendered = useMemo(() => {
    return category.symbols.map((s) => {
      // 化学分类用 \ce{} 包裹渲染；数学分类直接渲染
      const src = category.renderAs === 'ce' ? `\\ce{${s.label}}` : s.label
      try {
        return katex.renderToString(src, {
          displayMode: false,
          throwOnError: false,
        })
      } catch {
        return '<span style="color:red">err</span>'
      }
    })
  }, [category])

  // 根据 LaTeX 源码长度估算渲染宽度，决定网格跨列数
  // 短符号（α、+）1 列；中等（\frac{a}{b}）2 列；长（矩阵、分段函数）3~6 列
  const spanFor = (label: string): string => {
    const len = label.length
    if (len <= 12) return 'col-span-1'
    if (len <= 24) return 'col-span-2'
    if (len <= 48) return 'col-span-3'
    return 'col-span-6'
  }

  return (
    <div className="grid grid-cols-6 gap-1.5">
      {category.symbols.map((s, i) => (
        <button
          key={`${category.key}-${i}`}
          onClick={() => onInsert(s.insert)}
          title={s.name}
          className={`flex items-center justify-center min-h-12 h-auto px-1.5 py-2 rounded-md border border-border/50 bg-background hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer overflow-hidden ${spanFor(s.label)}`}
        >
          <span
            className="text-sm leading-tight max-w-full [&_.katex]:text-[0.95em]"
            dangerouslySetInnerHTML={{ __html: rendered[i] }}
          />
        </button>
      ))}
    </div>
  )
}
