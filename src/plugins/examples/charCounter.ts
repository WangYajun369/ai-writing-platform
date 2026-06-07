/**
 * 示例插件：字符统计
 *
 * 演示如何使用 TimeWrite 插件系统。
 * 在实际使用中，插件会被动态加载。
 */

import { definePlugin } from '@/plugins'

export default definePlugin({
  id: 'char-counter',
  name: '字符统计',
  version: '1.0.0',
  description: '在编辑器中提供实时字符/字数统计',
  icon: 'Hash',
  extensionPoints: ['editor-sidebar', 'command-palette'],

  init(context) {
    console.log('[char-counter] 插件已初始化')
    context.app.notify('字符统计插件已加载', 'success')
  },

  getCommands() {
    return [
      {
        id: 'char-counter.show-stats',
        label: '显示字符统计',
        extensionPoint: 'command-palette',
        icon: 'BarChart3',
        async handler(ctx) {
          const text = ctx.selectedText ?? ctx.editorContent ?? ''
          if (!text) {
            ctx.notify('没有可统计的文本', 'warning')
            return
          }
          const chars = text.length
          // 简单中英文统计：非 ASCII 字符算 1 个字，ASCII 单词算 1 个词
          const words = text
            .trim()
            .split(/\s+/)
            .filter(Boolean).length
          const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length

          ctx.notify(
            `字符: ${chars} | 中文: ${chinese} | 词/段落: ${words}`,
            'info',
          )
        },
      },
    ]
  },

  destroy() {
    console.log('[char-counter] 插件已销毁')
  },
})
