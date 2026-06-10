import { clsx, type ClassValue } from 'clsx'
import type { Chapter } from '@/types'

/** 类名合并工具 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

/** 格式化字数 */
export function formatWordCount(count: number): string {
  return `${count.toLocaleString()}字`
}

/** 格式化相对时间 */
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  if (diffHour < 24) return `${diffHour}小时前`
  if (diffDay < 30) return `${diffDay}天前`
  return date.toLocaleDateString('zh-CN')
}

/** 从 HTML 内容提取纯文本字数（去标签、解码实体、去空白，统计可见字符） */
export function countWordsFromHtml(html: string): number {
  // 使用 DOMParser 正确提取纯文本（自动解码所有 HTML 实体）
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const text = doc.body.textContent ?? ''
  return text.replace(/\s/g, '').length
}

/** 计算全书总字数，可覆盖指定章节的字数 */
export function calcBookWordCount(
  chapters: Chapter[],
  overrideChapterId?: string,
  overrideCount?: number,
): number {
  return chapters.reduce((sum, c) => {
    if (c.id === overrideChapterId) return sum + (overrideCount ?? 0)
    return sum + (c.wordCount || 0)
  }, 0)
}

/**
 * localStorage 持久化工具：创建一个带读取/写入的持久化存储包装器
 *
 * 用法：
 *   const store = createStorage('my-key', { theme: 'light' })
 *   const data = store.load()    // 读取并合并默认值
 *   store.save({ theme: 'dark' }) // 部分更新并写入
 */
export function createStorage<T extends Record<string, unknown>>(key: string, defaults: T) {
  return {
    load(): T {
      try {
        const raw = localStorage.getItem(key)
        if (raw) return { ...defaults, ...JSON.parse(raw) }
      } catch { /* ignore */ }
      return defaults
    },
    save(data: T) {
      try {
        localStorage.setItem(key, JSON.stringify(data))
      } catch { /* ignore */ }
    },
    /** 合并部分字段并保存 */
    patch(partial: Partial<T>) {
      const existing = this.load()
      this.save({ ...existing, ...partial })
    },
  }
}

/** 生成章节状态标签配置 */
export const CHAPTER_STATUS_CONFIG = {
  outline: { label: '大纲', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  draft: { label: '草稿', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
  polishing: { label: '精修', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
  finished: { label: '已定稿', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
} as const

/** 世界观卡片类型配置 */
export const WORLD_CARD_TYPE_CONFIG = {
  character: { label: '人物', icon: '👤', color: 'bg-purple-100 text-purple-700' },
  location: { label: '地点', icon: '🗺️', color: 'bg-teal-100 text-teal-700' },
  timeline: { label: '时间线', icon: '📅', color: 'bg-blue-100 text-blue-700' },
  faction: { label: '势力', icon: '⚔️', color: 'bg-red-100 text-red-700' },
  item: { label: '物品', icon: '💎', color: 'bg-yellow-100 text-yellow-700' },
  misc: { label: '其他', icon: '📝', color: 'bg-gray-100 text-gray-700' },
} as const

/**
 * 将 Markdown 文本转换为 HTML 字符串（供 TipTap insertContent 使用）
 *
 * TipTap 的 insertContent 接收 HTML 字符串并交由 ProseMirror HTML parser 解析，
 * 依据 schema 映射为对应的 nodes/marks。直接传入 Markdown 文本会导致格式丢失。
 *
 * 覆盖 AI 回复中最常见的 Markdown 语法：
 * - 标题（h1-h4）
 * - 粗体/斜体/行内代码
 * - 有序/无序列表
 * - 代码块（围栏式）
 * - 引用块
 * - 分割线
 * - 段落
 */
export function markdownToHtml(md: string): string {
  if (!md) return '<p></p>'

  // 预处理：将 CRLF 统一为 LF
  let text = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const lines = text.split('\n')
  const result: string[] = []
  let i = 0
  let inList: 'ul' | 'ol' | null = null

  /** 处理行内 Markdown 语法：**粗体** *斜体* `代码` */
  const parseInline = (s: string): string => {
    // 转义 HTML 特殊字符（先保留已有的）
    let t = s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    // 行内代码（需在粗斜体之前处理，避免 `` 内部被误转换）
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>')

    // 粗体 **text** 或 __text__
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>')

    // 斜体 *text* 或 _text_（不在单词内部）
    t = t.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    t = t.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>')

    // 还原转义的 HTML 实体（移除多余的转义）
    return t
  }

  /** 关闭当前列表 */
  const closeList = () => {
    if (inList === 'ul') result.push('</ul>')
    if (inList === 'ol') result.push('</ol>')
    inList = null
  }

  while (i < lines.length) {
    const raw = lines[i]
    const trimmed = raw.trim()

    // 空行：结束当前列表/段落
    if (trimmed === '') {
      closeList()
      i++
      continue
    }

    // 围栏式代码块 ```...```
    if (trimmed.startsWith('```')) {
      closeList()
      const lang = trimmed.slice(3).trim()
      result.push(lang ? `<pre><code class="language-${lang}">` : '<pre><code>')
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        // 代码块内不进行 Markdown 转义，保留原样
        result.push(lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        i++
      }
      result.push('</code></pre>')
      i++ // 跳过结束的 ```
      continue
    }

    // 分割线 --- / *** / ___
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList()
      result.push('<hr>')
      i++
      continue
    }

    // 标题 # ... ###### ...
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      closeList()
      const level = headingMatch[1].length
      const content = parseInline(headingMatch[2])
      result.push(`<h${level}>${content}</h${level}>`)
      i++
      continue
    }

    // 引用块 > text
    if (trimmed.startsWith('> ')) {
      closeList()
      const content = parseInline(trimmed.slice(2))
      result.push(`<blockquote><p>${content}</p></blockquote>`)
      i++
      continue
    }

    // 无序列表 - text 或 * text
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/)
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList()
        result.push('<ul>')
        inList = 'ul'
      }
      const content = parseInline(ulMatch[1])
      result.push(`<li>${content}</li>`)
      i++
      continue
    }

    // 有序列表 1. text
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/)
    if (olMatch) {
      if (inList !== 'ol') {
        closeList()
        result.push('<ol>')
        inList = 'ol'
      }
      const content = parseInline(olMatch[2])
      result.push(`<li>${content}</li>`)
      i++
      continue
    }

    // 普通段落
    closeList()
    const content = parseInline(trimmed)
    result.push(`<p>${content}</p>`)
    i++
  }

  // 关闭未闭合的列表
  closeList()

  return result.join('\n') || '<p></p>'
}
