/**
 * 内置插件引导（仅主窗口执行）
 *
 * 注册并启用内置插件；为 home-header 插件注入角标计数源。
 * 通过 module 级 Promise 保证幂等（React StrictMode 双挂载安全）。
 */
import { PluginManager } from './PluginManager'
import type { PluginContext } from './types'
import { vocabDictionaryPlugin } from './dictionary/plugin'
import { setVocabBadgeSource } from './dictionary/windowState'
import { taskCardsPlugin } from './taskCards/plugin'
import { setTaskCardsBadgeSource } from './taskCards/windowState'
import { vocabApi, taskCardApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'

let bootstrapPromise: Promise<void> | null = null

function buildContext(): PluginContext {
  // 注:storage 由 PluginManager.enable 内部按 pluginId 自动包装(namespace 隔离),
  // bootstrap 仅提供 app / editor 基础能力。
  return {
    app: {
      getActiveBookId: () => undefined,
      getActiveChapterId: () => undefined,
      notify: (message, type = 'info') => toast[type]?.(message),
    },
    editor: {
      getSelectedText: () => '',
      replaceSelection: () => {},
      insertText: () => {},
      getContent: () => '',
    },
    // storage 字段保持兼容:pluginStore 等占位场景仍可调用,
    // 但实际插件收到的 context.storage 已被 PluginManager 替换为 namespaced 版本
    storage: {
      async get<T = unknown>(): Promise<T | undefined> {
        return undefined
      },
      async set(): Promise<void> {},
      async remove(): Promise<void> {},
      async keys(): Promise<string[]> {
        return []
      },
    },
  }
}

async function doBootstrap(): Promise<void> {
  // 注入徽标计数源：今日待复习数
  setVocabBadgeSource(async (): Promise<number> => {
    try {
      const stats = await vocabApi.stats()
      return stats.dueToday
    } catch {
      return 0
    }
  })

  // 注入徽标计数源：今日应办数（今日到期 + 计划今日 + 逾期 的未完成数）
  setTaskCardsBadgeSource(async (): Promise<number> => {
    try {
      const overview = await taskCardApi.todayOverview()
      return overview.badge
    } catch {
      return 0
    }
  })

  PluginManager.register(vocabDictionaryPlugin)
  await PluginManager.enable(vocabDictionaryPlugin.manifest.id, buildContext())
  PluginManager.register(taskCardsPlugin)
  await PluginManager.enable(taskCardsPlugin.manifest.id, buildContext())
}

/** 幂等执行内置插件引导 */
export function bootstrapBuiltinPlugins(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = doBootstrap().catch((err) => {
      console.error('[PluginBootstrap] 内置插件引导失败', err)
    })
  }
  return bootstrapPromise
}
