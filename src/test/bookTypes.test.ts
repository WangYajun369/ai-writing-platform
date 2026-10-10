/**
 * book-types 单元测试
 *
 * 重点覆盖「空值 / 未知值回退 novel」这一兜底语义——存量作品的 book_type 为空串，
 * 旧备份导入时字段也可能缺失，回退错了会让整批作品都走错画像。
 */
import { describe, it, expect } from 'vitest'
import {
  BOOK_TYPES,
  DEFAULT_BOOK_TYPE,
  normalizeBookType,
  getBookTypeMeta,
} from '@/lib/book-types'

describe('normalizeBookType', () => {
  it('值域内的四个类型原样返回', () => {
    expect(normalizeBookType('novel')).toBe('novel')
    expect(normalizeBookType('thesis')).toBe('thesis')
    expect(normalizeBookType('breakdown')).toBe('breakdown')
    expect(normalizeBookType('note')).toBe('note')
  })

  it('空串 / undefined / null 回退 novel（存量作品与旧备份）', () => {
    expect(normalizeBookType('')).toBe('novel')
    expect(normalizeBookType(undefined)).toBe('novel')
    expect(normalizeBookType(null)).toBe('novel')
  })

  it('未知值回退 novel', () => {
    expect(normalizeBookType('poetry')).toBe('novel')
    expect(normalizeBookType('NOVEL')).toBe('novel') // 大小写敏感，不模糊匹配
  })
})

describe('getBookTypeMeta', () => {
  it('返回对应元数据，找不到时回退默认类型', () => {
    expect(getBookTypeMeta('thesis').label).toBe('论文')
    expect(getBookTypeMeta('').id).toBe(DEFAULT_BOOK_TYPE)
  })

  it('每个类型都有非空 label 与 description（UI 会直接渲染）', () => {
    for (const t of BOOK_TYPES) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
    }
  })
})

describe('BOOK_TYPES 值域表', () => {
  it('id 唯一且与 DEFAULT_BOOK_TYPE 一致存在', () => {
    const ids = BOOK_TYPES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_BOOK_TYPE)
  })

  it('顺序稳定：小说 → 论文 → 拆书 → 学科笔记', () => {
    expect(BOOK_TYPES.map((t) => t.id)).toEqual(['novel', 'thesis', 'breakdown', 'note'])
  })
})
