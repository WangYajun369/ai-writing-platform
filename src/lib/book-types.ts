/**
 * 作品类型值域 —— 阶段五起由后端画像注册表下发
 *
 * 对齐后端 `books.book_type` 列与 Rust 领域画像（`ProfileKind::Domain`）：
 * `novel` / `thesis` / `breakdown` / `note`，空值回退 `novel`，不引入「通用」画像。
 *
 * ## 为什么还保留一份兜底表
 *
 * 与 AI 面板的技能 chips 不同，这里是**表单控件**（新建 / 编辑作品弹窗），
 * 没有值就无法渲染选项，故 IPC 未就绪时先用内置兜底值保证 UI 可用；
 * IPC 返回后自动切换为后端值域——**后端新增领域无需改动本文件**。
 */

import { useMemo } from 'react'
import { useAgentProfiles, peekAgentProfiles, loadAgentProfiles } from './agent-profiles'
import type { ProfileMeta } from '@/types'

/** 作品类型标识 */
export type BookTypeId = 'novel' | 'thesis' | 'breakdown' | 'note'

/** 作品类型展示元数据 */
export interface BookTypeMeta {
  id: string
  /** 中文名 */
  label: string
  /** 一句话说明，展示在选择器下方 */
  description: string
}

/**
 * IPC 未就绪时的兜底值域
 *
 * ⚠️ 与后端注册表保持一致是**约定而非强制**：后端新增领域后，本表未同步
 * 只会导致「重启后首次打开弹窗的极短窗口内」看不到新项，IPC 返回即修正。
 */
const FALLBACK_TYPES: readonly BookTypeMeta[] = [
  { id: 'novel', label: '小说', description: '虚构叙事创作，关注情节、人物与文风' },
  { id: 'thesis', label: '论文', description: '学术写作，关注论点、论据与引用规范' },
  { id: 'breakdown', label: '拆书', description: '把一本书拆成要点卡片，关注拆解与提炼' },
  {
    id: 'note',
    label: '学科笔记',
    description: '按学科组织的结构化学习笔记，区别于日记',
  },
]

/** 空值 / 未知值的兜底类型 */
export const DEFAULT_BOOK_TYPE = 'novel'

function toMeta(p: ProfileMeta): BookTypeMeta {
  return { id: p.id, label: p.label, description: p.description }
}

/**
 * 同步读取作品类型列表
 *
 * 优先用后端下发的领域画像；IPC 尚未返回时触发一次加载并返回兜底值。
 * 供非 React 场景（如校验函数）使用；React 组件请用 [`useBookTypes`]。
 */
export function getBookTypes(): BookTypeMeta[] {
  const profiles = peekAgentProfiles()
  if (profiles) {
    const domains = profiles.filter((p) => p.kind === 'domain').map(toMeta)
    if (domains.length > 0) return domains
    return FALLBACK_TYPES as BookTypeMeta[]
  }
  void loadAgentProfiles()
  return FALLBACK_TYPES as BookTypeMeta[]
}

/** React 场景：订阅后端值域，加载期间回退内置表 */
export function useBookTypes(): BookTypeMeta[] {
  const profiles = useAgentProfiles()
  return useMemo(() => {
    const domains = profiles ? profiles.filter((p) => p.kind === 'domain').map(toMeta) : []
    return domains.length > 0 ? domains : (FALLBACK_TYPES as BookTypeMeta[])
  }, [profiles])
}

/**
 * 归一化作品类型：空值或未知值一律回退 `novel`
 *
 * 存量作品（迁移前创建）的 `book_type` 为空字符串，导入旧备份时也可能缺失该字段，
 * 因此所有读取 `book.bookType` 的调用点都应经此函数。
 *
 * @param value 原始存储值，可能为 undefined / '' / 未知字符串
 * @returns 值域内的合法类型
 */
export function normalizeBookType(value: string | undefined | null): string {
  const types = getBookTypes()
  return types.some((t) => t.id === value) ? String(value) : DEFAULT_BOOK_TYPE
}

/** 按 id 取展示元数据（找不到时回退默认类型） */
export function getBookTypeMeta(value: string | undefined | null): BookTypeMeta {
  const types = getBookTypes()
  const id = types.some((t) => t.id === value) ? String(value) : DEFAULT_BOOK_TYPE
  return types.find((t) => t.id === id) ?? types[0] ?? FALLBACK_TYPES[0]
}
