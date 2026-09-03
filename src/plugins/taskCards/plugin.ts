/**
 * 任务卡 · 项目管理插件
 *
 * home-header：首页头部「任务卡」入口按钮（角标=今日应办数，点击开关窗口）。
 * command-palette：全局命令面板（主窗口 Ctrl/⌘+Shift+P）命令 —— 打开窗口 / 直达今日 / 直达全部任务。
 */
import { definePlugin } from '@/plugins'
import { windowApi } from '@/lib/tauri-bridge'
import { isTasksWindowOpenState, getTaskCardsBadgeCount } from './windowState'

/** 确保任务卡窗口打开并可定向到区段；窗口原本已打开时返回 true（供提示语义用） */
async function ensureTasksWindow(section?: 'today' | 'all'): Promise<boolean> {
  const wasOpen = await windowApi.isTasksOpen()
  await windowApi.openTasks(section)
  return wasOpen
}

export const taskCardsPlugin = definePlugin({
  id: 'task-cards',
  name: '任务卡 · 项目管理',
  version: '1.0.0',
  description:
    '以项目为中心管理个人任务：三态看板（待办/进行中/完成）、计划今日、截止与逾期提醒；支持一键迁移原有「个人日程」。',
  author: 'TimeWrite',
  icon: 'ClipboardList',
  extensionPoints: ['home-header', 'command-palette'],
  getCommands() {
    return [
      {
        id: 'task-cards.open',
        label: '任务卡',
        extensionPoint: 'home-header',
        icon: 'ClipboardList',
        activeClassName: 'text-rose-500',
        isActive: () => isTasksWindowOpenState(),
        badgeCount: () => getTaskCardsBadgeCount(),
        async handler(ctx) {
          await windowApi.openTasks()
          ctx.notify('已切换任务卡窗口', 'info')
        },
      },
      // ── 命令面板条目（command-palette 扩展点）──
      {
        id: 'task-cards.open-palette',
        label: '任务卡 · 打开窗口',
        extensionPoint: 'command-palette',
        icon: 'ClipboardList',
        async handler(ctx) {
          const wasOpen = await ensureTasksWindow()
          ctx.notify(wasOpen ? '已关闭任务卡窗口' : '已打开任务卡窗口', 'info')
        },
      },
      {
        id: 'task-cards.goto-today',
        label: '任务卡 · 今日视图',
        extensionPoint: 'command-palette',
        icon: 'Sun',
        async handler(ctx) {
          const wasOpen = await ensureTasksWindow('today')
          ctx.notify(wasOpen ? '已定位到「今日」' : '已打开任务卡 · 今日视图', 'info')
        },
      },
      {
        id: 'task-cards.goto-all',
        label: '任务卡 · 全部任务',
        extensionPoint: 'command-palette',
        icon: 'ListFilter',
        async handler(ctx) {
          const wasOpen = await ensureTasksWindow('all')
          ctx.notify(wasOpen ? '已定位到「全部任务」' : '已打开任务卡 · 全部任务', 'info')
        },
      },
    ]
  },
})

export default taskCardsPlugin
