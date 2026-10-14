/**
 * 单词关联图谱纯函数单元测试
 *
 * 覆盖：节点半径（potential 固定值 / 度数封顶）、向光标锚点缩放（k 钳制 +
 * 光标下图坐标不动公式）、自适应 fit（包围盒 + 边距 + 居中）。
 */
import { describe, it, expect } from 'vitest'
import {
  fitViewToNodes,
  GRAPH_FIT_MAX,
  GRAPH_ZOOM_MAX,
  GRAPH_ZOOM_MIN,
  graphNodeRadius,
  zoomViewAt,
} from '@/components/vocabulary/vocab-utils'

describe('graphNodeRadius', () => {
  it('potential 叶子固定 4.5', () => {
    expect(graphNodeRadius({ status: 'potential', degree: 0 })).toBe(4.5)
    expect(graphNodeRadius({ status: 'potential', degree: 9 })).toBe(4.5)
  })

  it('已收录词按度数增长：7 + degree * 1.2', () => {
    expect(graphNodeRadius({ status: 'learning', degree: 0 })).toBe(7)
    expect(graphNodeRadius({ status: 'mastered', degree: 5 })).toBeCloseTo(13)
  })

  it('高度数封顶 16', () => {
    expect(graphNodeRadius({ status: 'learning', degree: 100 })).toBe(16)
    expect(graphNodeRadius({ status: 'learning', degree: 8 })).toBe(16) // 7+9.6=16.6 → 封顶
  })
})

describe('zoomViewAt', () => {
  const view = { k: 1, x: 0, y: 0 }

  it('放大 ×1.15、缩小 ÷1.15', () => {
    expect(zoomViewAt(view, 100, 50, true).k).toBeCloseTo(1.15)
    expect(zoomViewAt(view, 100, 50, false).k).toBeCloseTo(1 / 1.15)
  })

  it('k 钳制在 [0.2, 4]', () => {
    let v = view
    for (let i = 0; i < 30; i++) v = zoomViewAt(v, 0, 0, true)
    expect(v.k).toBe(GRAPH_ZOOM_MAX)
    for (let i = 0; i < 60; i++) v = zoomViewAt(v, 0, 0, false)
    expect(v.k).toBe(GRAPH_ZOOM_MIN)
  })

  it('光标锚点：缩放前后光标下的图坐标不变', () => {
    const before = { k: 1.3, x: 40, y: -20 }
    const mx = 320
    const my = 180
    const after = zoomViewAt(before, mx, my, true)
    // 图坐标 g = (屏幕 - 平移) / k，缩放前后应相等
    const gxBefore = (mx - before.x) / before.k
    const gyBefore = (my - before.y) / before.k
    const gxAfter = (mx - after.x) / after.k
    const gyAfter = (my - after.y) / after.k
    expect(gxAfter).toBeCloseTo(gxBefore)
    expect(gyAfter).toBeCloseTo(gyBefore)
  })

  it('到达钳制边界后视图不再变化（k 不变 → x/y 也不变）', () => {
    const atMax = { k: GRAPH_ZOOM_MAX, x: 10, y: 10 }
    const next = zoomViewAt(atMax, 500, 300, true)
    expect(next.k).toBe(GRAPH_ZOOM_MAX)
    expect(next.x).toBeCloseTo(atMax.x)
    expect(next.y).toBeCloseTo(atMax.y)
  })
})

describe('fitViewToNodes', () => {
  it('无有效坐标节点或尺寸非法时返回默认视图', () => {
    expect(fitViewToNodes([], 800, 600)).toEqual({ k: 1, x: 0, y: 0 })
    expect(fitViewToNodes([{ x: 1 }], 800, 600)).toEqual({ k: 1, x: 0, y: 0 })
    expect(fitViewToNodes([{ x: 1, y: 2 }], 0, 600)).toEqual({ k: 1, x: 0, y: 0 })
  })

  it('包围盒居中：图中心映射到视口中心', () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 400, y: 200 },
    ]
    const v = fitViewToNodes(nodes, 800, 600, 60)
    // 图中心 (200,100) → 屏幕 (400,300)
    expect(200 * v.k + v.x).toBeCloseTo(400)
    expect(100 * v.k + v.y).toBeCloseTo(300)
  })

  it('缩放按边距计算且不超上限', () => {
    const wide = [
      { x: 0, y: 0 },
      { x: 2000, y: 10 },
    ]
    const v = fitViewToNodes(wide, 800, 600, 60)
    // 宽度主导：(800-120)/2000 = 0.34
    expect(v.k).toBeCloseTo(0.34)
    // 小包围盒 → 不超过 fit 上限
    const tiny = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]
    expect(fitViewToNodes(tiny, 800, 600, 60).k).toBe(GRAPH_FIT_MAX)
  })

  it('全部节点落入视口（含边距）', () => {
    const nodes = [
      { x: -500, y: -300 },
      { x: 500, y: 300 },
      { x: 0, y: 0 },
    ]
    const v = fitViewToNodes(nodes, 800, 600, 60)
    for (const n of nodes) {
      const sx = n.x * v.k + v.x
      const sy = n.y * v.k + v.y
      expect(sx).toBeGreaterThanOrEqual(60 - 1e-6)
      expect(sx).toBeLessThanOrEqual(800 - 60 + 1e-6)
      expect(sy).toBeGreaterThanOrEqual(60 - 1e-6)
      expect(sy).toBeLessThanOrEqual(600 - 60 + 1e-6)
    }
  })
})
