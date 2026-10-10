/**
 * 作品类型值域 —— 集中定义，供新建/编辑弹窗共用
 *
 * 对齐 ADR-004 决策 5 的值域表与后端 `books.book_type` 列：
 * `novel` / `thesis` / `breakdown` / `note`，空值回退 `novel`，不引入「通用」画像。
 *
 * ⚠️ 阶段五（L3 前端自动发现）落地后，本文件的 `BOOK_TYPES` 应改为从
 * `agent_profile_list` IPC 拉取，使新增画像无需改动前端。届时只需替换本文件，
 * 调用方（NewBookDialog / EditBookDialog）无需改动。
 */

/** 作品类型标识 */
export type BookTypeId = 'novel' | 'thesis' | 'breakdown' | 'note'

/** 作品类型展示元数据 */
export interface BookTypeMeta {
  id: BookTypeId
  /** 中文名 */
  label: string
  /** 一句话说明，展示在选择器下方 */
  description: string
}

/** 作品类型值域表（顺序即 UI 展示顺序） */
export const BOOK_TYPES: readonly BookTypeMeta[] = [
  {
    id: 'novel',
    label: '小说',
    description: '虚构叙事创作，关注情节、人物与文风',
  },
  {
    id: 'thesis',
    label: '论文',
    description: '学术写作，关注论点、论据与引用规范',
  },
  {
    id: 'breakdown',
    label: '拆书',
    description: '把一本书拆成要点卡片，关注拆解与提炼',
  },
  {
    id: 'note',
    label: '学科笔记',
    description: '按学科组织的结构化学习笔记，区别于日记',
  },
]

/** 空值 / 未知值的兜底类型 */
export const DEFAULT_BOOK_TYPE: BookTypeId = 'novel'

/**
 * 归一化作品类型：空值或未知值一律回退 `novel`
 *
 * 存量作品（迁移前创建）的 `book_type` 为空字符串，导入旧备份时也可能缺失该字段，
 * 因此所有读取 `book.bookType` 的调用点都应经此函数。
 *
 * @param value 原始存储值，可能为 undefined / '' / 未知字符串
 * @returns 一定是值域内的合法类型
 */
export function normalizeBookType(value: string | undefined | null): BookTypeId {
  return BOOK_TYPES.some((t) => t.id === value) ? (value as BookTypeId) : DEFAULT_BOOK_TYPE
}

/** 按 id 取展示元数据（找不到时返回兜底类型） */
export function getBookTypeMeta(value: string | undefined | null): BookTypeMeta {
  const id = normalizeBookType(value)
  return BOOK_TYPES.find((t) => t.id === id) ?? BOOK_TYPES[0]
}
