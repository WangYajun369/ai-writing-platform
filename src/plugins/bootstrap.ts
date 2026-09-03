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
import { vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'

let bootstrapPromise: Promise<void> | null = null

const STORAGE_PREFIX = 'tw:plugin:'

function buildContext(): PluginContext {
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
    storage: {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        try {
          const raw = localStorage.getItem(STORAGE_PREFIX + key)
          return raw === null ? undefined : (JSON.parse(raw) as T)
        } catch {
          return undefined
        }
      },
      async set(key, value) {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
      },
      async remove(key) {
        localStorage.removeItem(STORAGE_PREFIX + key)
      },
      async keys() {
        return Object.keys(localStorage)
          .filter((k) => k.startsWith(STORAGE_PREFIX))
          .map((k) => k.slice(STORAGE_PREFIX.length))
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

  PluginManager.register(vocabDictionaryPlugin)
  await PluginManager.enable(vocabDictionaryPlugin.manifest.id, buildContext())
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
