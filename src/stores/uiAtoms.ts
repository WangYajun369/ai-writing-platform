import { atom } from 'jotai'
import type { Editor } from '@tiptap/react'
import type { DiffViewMode } from '../types'

/** 编辑器是否聚焦 */
export const editorFocusAtom = atom<boolean>(false)

/** TipTap 编辑器实例（供工具栏等外部组件使用） */
export const editorInstanceAtom = atom<Editor | null>(null)

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

/** 编辑器滚动位置（用于恢复上次编辑位置） */
export const editorScrollPositionAtom = atom<number>(0)

/** 编辑器光标/选区位置 { from: number, to: number } */
export const editorCursorPositionAtom = atom<{ from: number; to: number } | null>(null)

/** AI 工具箱独立窗口是否打开（跨页面共享） */
export const aiToolboxWindowOpenAtom = atom<boolean>(false)

/** 版本历史独立窗口是否打开 */
export const historyWindowOpenAtom = atom<boolean>(false)

/** 世界观资料库独立窗口是否打开 */
export const worldWindowOpenAtom = atom<boolean>(false)

/** 章节总结独立窗口是否打开 */
export const summaryWindowOpenAtom = atom<boolean>(false)

/** 调试控制台独立窗口是否打开 */
export const debugWindowOpenAtom = atom<boolean>(false)
