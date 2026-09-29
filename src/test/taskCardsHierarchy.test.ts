/**
 * collectParentRows 单元测试（任务卡层级工具）
 *
 * 锁定三个关键行为：
 * 1. 树序展开：父在前、子按全角空格缩进
 * 2. 防环排除：excludeId 的任务及其全部后代不出现在候选中
 * 3. 孤儿兜底：父引用缺失（父不在列表）的任务仍作为顶层候选
 */
import { describe, expect, it } from 'vitest'
import { collectParentRows } from '@/lib/taskCardsHierarchy'
import type { TaskCard } from '@/types'

function t(id: string, parentId: string | null): TaskCard {
  return {
    id,
    parentId,
    projectId: 'p1',
    title: `任务${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    plannedToday: false,
    note: '',
    remindType: '',
    recurrence: '',
    tags: [],
    createdAt: '2026-01-01T00:00:00',
    updatedAt: '2026-01-01T00:00:00',
  } as unknown as TaskCard
}

describe('collectParentRows', () => {
  it('按「父在前」树序展开，子任务带缩进前缀', () => {
    const list = [t('a', null), t('b', null), t('a1', 'a'), t('a1x', 'a1')]
    const rows = collectParentRows(list, null)
    // b 在 a 之后创建，但树序以列表原序展开顶层：a → a1 → a1x → b
    expect(rows.map((r) => r.id)).toEqual(['a', 'a1', 'a1x', 'b'])
    expect(rows[0].prefix).toBe('')
    expect(rows[1].prefix).toBe('　')
    expect(rows[2].prefix).toBe('　　')
  })

  it('excludeId 排除自身及其全部后代（防循环引用）', () => {
    const list = [t('a', null), t('a1', 'a'), t('a1x', 'a1'), t('b', null)]
    const rows = collectParentRows(list, 'a1')
    // a1 及其后代 a1x 均被排除
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('excludeId 为 null 时（新建模式）不排除任何任务', () => {
    const list = [t('a', null), t('a1', 'a')]
    const rows = collectParentRows(list, null)
    expect(rows.map((r) => r.id)).toEqual(['a', 'a1'])
  })

  it('孤儿任务（父不在列表）作为顶层候选兜底', () => {
    const list = [t('ghost', 'missing'), t('a', null)]
    const rows = collectParentRows(list, null)
    expect(rows.map((r) => r.id)).toContain('ghost')
    expect(rows.find((r) => r.id === 'ghost')?.prefix).toBe('')
  })
})
