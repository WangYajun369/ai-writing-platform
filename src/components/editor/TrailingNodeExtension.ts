/**
 * TrailingNodeExtension — 确保文档末尾始终有一个可编辑的段落
 *
 * 当文档以代码块、表格等块级节点结束时，
 * 自动追加一个空段落，确保用户可以点击空白区域继续输入。
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const pluginKey = new PluginKey('trailingNode')

export const TrailingNode = Extension.create({
  name: 'trailingNode',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        appendTransaction(_, __, newState) {
          const { doc, tr } = newState
          // 文档为空或最后一个节点是段落/标题等文本块，无需处理
          if (doc.childCount === 0) {
            const newTr = tr.insert(0, doc.type.schema.nodes.paragraph.create())
            return newTr
          }

          const lastNode = doc.lastChild
          if (!lastNode) return

          // 这些节点类型后可以正常点击输入，无需追加段落
          const inlineTypes = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList'])
          if (inlineTypes.has(lastNode.type.name)) return

          // 最后一个节点是代码块、表格等块级不可继续输入的节点，追加空段落
          const trailing = doc.type.schema.nodes.paragraph.create()
          const newTr = tr.insert(doc.content.size, trailing)
          return newTr
        },
      }),
    ]
  },
})
