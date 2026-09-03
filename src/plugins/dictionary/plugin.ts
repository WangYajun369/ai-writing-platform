/**
 * 英语字典 · 生词本插件
 *
 * 首个使用 home-header 扩展点的内置插件：
 * 在首页头部渲染一个词典入口按钮，角标显示今日待复习数，
 * 点击打开/关闭英语字典独立窗口。
 */
import { definePlugin } from '@/plugins'
import { windowApi } from '@/lib/tauri-bridge'
import { isVocabWindowOpenState, getVocabBadgeCount } from './windowState'

export const vocabDictionaryPlugin = definePlugin({
  id: 'vocab-dictionary',
  name: '英语字典 · 生词本',
  version: '1.0.0',
  description:
    '收录并整理个人生词，按艾宾浩斯遗忘曲线（SM-2 动态间隔）规划复习；支持 ECDICT 离线词库与 DeepSeek AI 释义兜底。',
  author: 'TimeWrite',
  icon: 'BookMarked',
  extensionPoints: ['home-header'],
  getCommands() {
    return [
      {
        id: 'vocab-dictionary.open',
        label: '英语字典',
        extensionPoint: 'home-header',
        icon: 'BookMarked',
        activeClassName: 'text-sky-500',
        isActive: () => isVocabWindowOpenState(),
        badgeCount: () => getVocabBadgeCount(),
        async handler(ctx) {
          await windowApi.openVocab()
          ctx.notify('已切换英语字典窗口', 'info')
        },
      },
    ]
  },
})

export default vocabDictionaryPlugin
