/**
 * 英语字典窗口的激活状态（模块级，供插件 home-header 的 isActive 使用）。
 * 由 VocabularyWindow 挂载/卸载时更新。
 */

let vocabWindowOpen = false

export function setVocabWindowOpen(open: boolean) {
  vocabWindowOpen = open
}

export function isVocabWindowOpenState(): boolean {
  return vocabWindowOpen
}

/** 今日待复习角标计数源（由应用平台注入，避免与存储模块循环依赖） */
let badgeSource: (() => number | Promise<number> | undefined) | undefined

export function setVocabBadgeSource(source: () => number | Promise<number> | undefined) {
  badgeSource = source
}

export function getVocabBadgeCount(): number | Promise<number> | undefined {
  return badgeSource?.()
}
