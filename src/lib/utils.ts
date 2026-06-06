import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Chapter } from '@/types'

/** Tailwind 类名合并工具 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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

/** 深拷贝 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/** 防抖 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

/** 截断文本 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '…'
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
