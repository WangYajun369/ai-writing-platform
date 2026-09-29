/**
 * 任务卡层级工具（父子任务树）
 *
 * 自 TaskModal 拆出，供父任务选择器等需要「树序展开 + 防环排除」的场景复用。
 */
import type { TaskCard } from '@/types'

/** 父任务候选行：prefix 为全角空格缩进示意层级 */
export interface ParentRow {
  id: string
  title: string
  prefix: string
}

/**
 * 父任务树形候选：按「父在前」层级展开，子任务以全角空格缩进示意层级。
 * excludeId 非空时（详情模式）排除该任务及其全部后代，避免形成循环引用。
 */
export function collectParentRows(list: TaskCard[], excludeId: string | null): ParentRow[] {
  const byId = new Map(list.map((t) => [t.id, t]))
  const childrenOf = new Map<string, TaskCard[]>()
  for (const t of list) {
    if (t.parentId && byId.has(t.parentId)) {
      const arr = childrenOf.get(t.parentId) ?? []
      arr.push(t)
      childrenOf.set(t.parentId, arr)
    }
  }
  // 排除集 = 自己 + 全部后代（防环）
  const blocked = new Set<string>()
  if (excludeId) {
    const stack = [excludeId]
    while (stack.length) {
      const cur = stack.pop()!
      if (blocked.has(cur)) continue
      blocked.add(cur)
      for (const c of childrenOf.get(cur) ?? []) stack.push(c.id)
    }
  }
  const rows: ParentRow[] = []
  const seen = new Set<string>()
  const walk = (id: string, prefix: string) => {
    if (blocked.has(id) || seen.has(id)) return
    seen.add(id)
    const t = byId.get(id)
    if (t) rows.push({ id, title: t.title, prefix })
    for (const c of childrenOf.get(id) ?? []) walk(c.id, prefix + '　')
  }
  // 顶层任务（无父或父不在列表）按列表原序展开其整棵子树
  for (const t of list) {
    if (!t.parentId || !byId.has(t.parentId)) walk(t.id, '')
  }
  // 兜底：仍在排除集外且未出现过的（异常孤儿）也作为候选
  for (const t of list) {
    if (!blocked.has(t.id) && !seen.has(t.id)) rows.push({ id: t.id, title: t.title, prefix: '' })
  }
  return rows
}
