/**
 * 表格单元格工具函数（合并 / 拆分可用性检测）
 */
import type { Editor } from '@tiptap/react'
import { isEditorUsable } from '@/lib/editor-guard'

/**
 * 判断当前选区是否可以合并单元格。
 *
 * 仅当用户通过拖动或快捷键选中了多个单元格（CellSelection，且锚点与头点不在同一单元格）时，
 * `editor.can().mergeCells()` 才返回 true。
 */
export function canMergeCells(editor: Editor | null): boolean {
  // 已销毁的实例 commandManager 为 null，调用 can() 会抛异常
  if (!isEditorUsable(editor)) return false
  return editor.can().mergeCells()
}

/**
 * 判断当前光标所在单元格是否可以拆分。
 *
 * 当单元格存在 `colspan` 或 `rowspan > 1`（即由合并产生的单元格）时可拆分。
 * 通过编辑器的 DOM 映射定位当前光标所在 td/th 元素并读取其属性。
 */
export function hasSplittableCell(editor: Editor | null): boolean {
  if (!isEditorUsable(editor)) return false
  const { from } = editor.state.selection
  const domNode = editor.view.domAtPos(from).node
  // 光标可能落在文本节点上，需上溯到元素节点
  let node: Element | null = null
  if (domNode instanceof Element) {
    node = domNode
  } else if (domNode.parentElement) {
    node = domNode.parentElement
  }
  if (!node) return false
  const cell = node.closest('td, th')
  if (!cell) return false
  const colspan = Number(cell.getAttribute('colspan') ?? 1)
  const rowspan = Number(cell.getAttribute('rowspan') ?? 1)
  return colspan > 1 || rowspan > 1
}
