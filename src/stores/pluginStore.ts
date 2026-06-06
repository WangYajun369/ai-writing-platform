/**
 * Plugin Store - 插件系统状态管理
 *
 * 管理已安装插件的状态、启用/禁用操作。
 */

import { create } from 'zustand'
import { PluginManager } from '@/plugins/PluginManager'
import type { InstalledPlugin, PluginStatus } from '@/plugins/types'

interface PluginState {
  /** 所有已注册的插件 */
  plugins: InstalledPlugin[]
  /** 插件系统是否已初始化 */
  initialized: boolean
}

interface PluginActions {
  /** 刷新插件列表 */
  refresh: () => void
  /** 启用插件 */
  enablePlugin: (pluginId: string) => Promise<void>
  /** 禁用插件 */
  disablePlugin: (pluginId: string) => void
  /** 卸载插件 */
  uninstallPlugin: (pluginId: string) => void
  /** 获取指定插件状态 */
  getStatus: (pluginId: string) => PluginStatus | undefined
}

export const usePluginStore = create<PluginState & PluginActions>((set, get) => ({
  plugins: [],
  initialized: false,

  refresh: () => {
    const plugins = PluginManager.getInstalledPlugins()
    set({ plugins, initialized: true })
  },

  enablePlugin: async (pluginId: string) => {
    // context will be injected by the app initialization
    const context = {
      app: {
        getActiveBookId: () => undefined,
        getActiveChapterId: () => undefined,
        notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => {
          console.log(`[Plugin] ${type ?? 'info'}: ${message}`)
        },
      },
      editor: {
        getSelectedText: () => '',
        replaceSelection: () => {},
        insertText: () => {},
        getContent: () => '',
      },
      storage: {
        get: async () => undefined,
        set: async () => {},
        remove: async () => {},
        keys: async () => [],
      },
    }
    try {
      await PluginManager.enable(pluginId, context)
      get().refresh()
    } catch (err) {
      get().refresh()
      throw err
    }
  },

  disablePlugin: (pluginId: string) => {
    PluginManager.disable(pluginId)
    get().refresh()
  },

  uninstallPlugin: (pluginId: string) => {
    PluginManager.unregister(pluginId)
    get().refresh()
  },

  getStatus: (pluginId: string) => {
    return PluginManager.getPluginStatus(pluginId)
  },
}))
