/**
 * 目录（大纲）面板共享类型定义
 *
 * 集中定义 OutlinePanel 及其子组件（弹窗 / 拖拽行 / hooks）之间传递的
 * 纯数据与回调类型，避免跨文件重复声明：
 * - OutlinePanelProps：目录面板的入口参数（bookId，指定展示哪本书的卷-章节树）
 * - InputDialogState / ConfirmDialogState：新建/重命名输入框与二次确认框的受控状态
 * - FlatItem：将树形结构拍平为线性列表后的条目，与虚拟滚动行一一对应
 *   （供 useOutlineDnd 做拖拽碰撞检测与 OutlinePanel 渲染使用）
 *
 * 注意：OutlinePanel.tsx 内部另声明了一份同名 OutlinePanelProps，
 * 本文件的导出版当前未被引用（属历史遗留重复定义）。
 */
import type { Chapter, Volume } from '@/types'

/** 目录面板入口参数（OutlinePanel 内部有同名局部定义，此处导出版未被引用） */
export interface OutlinePanelProps {
  bookId: string
}

/** 新建/重命名输入框的受控状态（label 为提示文案，onSubmit 回车时回调） */
export interface InputDialogState {
  open: boolean
  label: string
  defaultValue: string
  onSubmit: (value: string) => void
}

/** 二次确认框的受控状态（danger 为 false 时隐藏取消按钮，退化为通知型对话框） */
export interface ConfirmDialogState {
  open: boolean
  title: string
  message: string
  onConfirm: () => void
  confirmLabel?: string
  danger?: boolean
}

/** 拍平后的列表项 */
export type FlatItem =
  | { type: 'chapter'; id: string; chapter: Chapter; indent: boolean }
  | { type: 'volume'; id: string; volume: Volume; collapsed: boolean }
