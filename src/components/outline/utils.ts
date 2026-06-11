import type { Chapter } from '@/types'
import type { FlatItem } from './types'

/** 为 DnD 生成唯一标识 */
export function dndId(item: FlatItem): string {
  return `${item.type}-${item.id}`
}

/** 获取章节所属分组（unassigned 或 volumeId） */
export function chapterGroup(chapter: Chapter): string {
  return chapter.volumeId || '__unassigned__'
}
