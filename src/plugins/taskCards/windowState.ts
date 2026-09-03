/**
 * 任务卡窗口的激活状态与今日角标计数源（模块级）
 * 由 TasksWindow 挂载/卸载时更新激活态；计数源由 bootstrap 注入。
 */

let tasksWindowOpen = false

export function setTasksWindowOpen(open: boolean) {
  tasksWindowOpen = open
}

export function isTasksWindowOpenState(): boolean {
  return tasksWindowOpen
}

/** 今日任务角标计数源（由应用平台注入，避免循环依赖） */
let badgeSource: (() => number | Promise<number> | undefined) | undefined

export function setTaskCardsBadgeSource(source: () => number | Promise<number> | undefined) {
  badgeSource = source
}

export function getTaskCardsBadgeCount(): number | Promise<number> | undefined {
  return badgeSource?.()
}
