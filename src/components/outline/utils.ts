/**
 * 目录面板纯工具函数
 *
 * 提供目录树拖拽所需的两个基础辅助：
 * - dndId：将拍平条目转成 @dnd-kit 的唯一 id（`type-id`，卷/章节前缀避免 id 冲突）
 * - chapterGroup：判断章节所属分组（卷 id 或未分卷哨兵值）
 */
import type { Chapter } from '@/types'
import type { FlatItem } from './types'

/** 为 DnD 生成唯一标识（卷/章节类型前缀 + 实体 id） */
export function dndId(item: FlatItem): string {
  return `${item.type}-${item.id}`
}

/** 获取章节所属分组（unassigned 或 volumeId） */
export function chapterGroup(chapter: Chapter): string {
  return chapter.volumeId || '__unassigned__'
}
