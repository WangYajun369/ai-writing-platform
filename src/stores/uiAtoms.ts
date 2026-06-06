import { atom } from 'jotai'
import type { DiffViewMode } from '../types'

/** 编辑器是否聚焦 */
export const editorFocusAtom = atom<boolean>(false)

/** Diff 对比视图模式 */
export const diffViewModeAtom = atom<DiffViewMode>('side-by-side')

/** 侧边栏是否展开 */
export const sidebarOpenAtom = atom<boolean>(true)

/** AI 对话面板是否展开 */
export const aiPanelOpenAtom = atom<boolean>(false)

/** 版本历史面板是否展开 */
export const historyPanelOpenAtom = atom<boolean>(false)

/** 专注模式 */
export const zenModeAtom = atom<boolean>(false)

/** 当前悬浮速览关键词 */
export const hoverKeywordAtom = atom<string | null>(null)

/** 模态框栈（用于嵌套弹窗管理） */
export const modalStackAtom = atom<string[]>([])

/** 正在保存 */
export const isSavingAtom = atom<boolean>(false)

/** 最后保存时间 */
export const lastSavedAtom = atom<Date | null>(null)

/** 字数统计 */
export const wordCountAtom = atom<{ chapter: number; total: number }>({ chapter: 0, total: 0 })

/** 搜索面板 */
export const searchOpenAtom = atom<boolean>(false)

/** 章节内容外部刷新计数器（恢复快照等场景递增触发编辑器重载） */
export const contentRefreshAtom = atom<number>(0)
