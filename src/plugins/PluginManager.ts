/**
 * MirageInk Plugin Manager
 *
 * 管理插件的注册、初始化、执行和销毁。
 * 单例模式，通过 usePluginStore 交互。
 */

import type {
  Plugin,
  PluginCommand,
  PluginContext,
  InstalledPlugin,
  PluginStatus,
  CommandContext,
  ExtensionPoint,
} from './types'

class PluginManagerImpl {
  private plugins = new Map<string, Plugin>()
  private statuses = new Map<string, PluginStatus>()
  private errors = new Map<string, string>()
  private enabledTimes = new Map<string, number>()
  private listeners = new Set<() => void>()

  /** 注册一个插件 */
  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      console.warn(`[PluginManager] Plugin "${plugin.manifest.id}" already registered, skipping.`)
      return
    }
    this.plugins.set(plugin.manifest.id, plugin)
    this.statuses.set(plugin.manifest.id, 'installed')
    this.notifyListeners()
  }

  /** 启用已注册的插件 */
  async enable(pluginId: string, context: PluginContext): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found`)

    try {
      await plugin.init?.(context)
      this.statuses.set(pluginId, 'active')
      this.errors.delete(pluginId)
      this.enabledTimes.set(pluginId, Date.now())
      this.notifyListeners()
    } catch (err) {
      this.statuses.set(pluginId, 'error')
      this.errors.set(pluginId, err instanceof Error ? err.message : String(err))
      this.notifyListeners()
      throw err
    }
  }

  /** 禁用插件 */
  disable(pluginId: string): void {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return

    try {
      plugin.destroy?.()
    } catch (err) {
      console.error(`[PluginManager] Error destroying plugin "${pluginId}":`, err)
    }

    this.statuses.set(pluginId, 'disabled')
    this.enabledTimes.delete(pluginId)
    this.notifyListeners()
  }

  /** 卸载插件 */
  unregister(pluginId: string): void {
    this.disable(pluginId)
    this.plugins.delete(pluginId)
    this.statuses.delete(pluginId)
    this.errors.delete(pluginId)
    this.notifyListeners()
  }

  /** 执行指定命令 */
  async executeCommand(commandId: string, context: CommandContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const commands = plugin.getCommands?.() ?? []
      const cmd = commands.find((c) => c.id === commandId)
      if (cmd && this.statuses.get(plugin.manifest.id) === 'active') {
        await cmd.handler(context)
        return
      }
    }
    throw new Error(`Command "${commandId}" not found or plugin not active`)
  }

  /** 获取所有已注册的插件信息 */
  getInstalledPlugins(): InstalledPlugin[] {
    return Array.from(this.plugins.entries()).map(([id, plugin]) => ({
      manifest: plugin.manifest,
      status: this.statuses.get(id) ?? 'installed',
      error: this.errors.get(id),
      enabledAt: this.enabledTimes.get(id),
    }))
  }

  /** 按扩展点获取所有可用命令 */
  getCommandsByExtensionPoint(point: ExtensionPoint): PluginCommand[] {
    const commands: PluginCommand[] = []
    for (const plugin of this.plugins.values()) {
      if (this.statuses.get(plugin.manifest.id) !== 'active') continue
      const cmds = plugin.getCommands?.() ?? []
      commands.push(...cmds.filter((c) => c.extensionPoint === point))
    }
    return commands
  }

  /** 获取所有命令 */
  getAllCommands(): PluginCommand[] {
    const commands: PluginCommand[] = []
    for (const plugin of this.plugins.values()) {
      if (this.statuses.get(plugin.manifest.id) !== 'active') continue
      commands.push(...(plugin.getCommands?.() ?? []))
    }
    return commands
  }

  /** 获取指定插件的状态 */
  getPluginStatus(pluginId: string): PluginStatus | undefined {
    return this.statuses.get(pluginId)
  }

  /** 订阅插件状态变化 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        console.error('[PluginManager] Listener error:', err)
      }
    }
  }
}

/** 全局单例 */
export const PluginManager = new PluginManagerImpl()
export default PluginManager
