/**
 * TimeWrite Plugin Manager
 *
 * 管理插件的注册、初始化、执行和销毁。
 * 单例模式,通过 usePluginStore 交互。
 *
 * ## 稳定性保障(v1.9 强化)
 *
 * 1. **Manifest schema 校验** — register 前调用 `validateManifest`,
 *    畸形插件直接拒绝注册并 console.warn,不污染扩展点枚举。
 * 2. **错误隔离** — 单插件 `init` / `getCommands` / `destroy` 异常
 *    仅标记自身 error 状态,不影响其他插件;`enable` 不再 rethrow,
 *    bootstrap 后续插件可继续注册。
 * 3. **生命周期幂等** — 重复 `enable` / `disable` 直接返回,
 *    不重复调用 init / destroy。
 * 4. **storage namespace 隔离** — `enable` 时按 pluginId 自动包装
 *    `context.storage`,所有 key 自动加 `tw:plugin:<id>:` 前缀,
 *    插件间数据互不可见。
 */

import { errText } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { validateManifest } from './schema'
import {
  Plugin,
  PluginCommand,
  PluginContext,
  InstalledPlugin,
  PluginStatus,
  CommandContext,
  ExtensionPoint,
} from './types'

/** storage namespace 前缀(与旧 bootstrap 实现保持兼容) */
const STORAGE_PREFIX = 'tw:plugin:'

/**
 * 按 pluginId 包装 storage:插件看到的 key 自动加 namespace 前缀。
 * 插件间数据互不可见,且插件无需关心 namespace 拼接。
 *
 * 实现直接基于 localStorage + 前缀,无视外部 base storage
 * (避免 base 自带共享前缀导致 namespace 失效)。
 */
function wrapStorage(pluginId: string): PluginContext['storage'] {
  const prefix = `${STORAGE_PREFIX}${pluginId}:`
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const raw = localStorage.getItem(prefix + key)
      return raw === null ? undefined : (JSON.parse(raw) as T)
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      localStorage.setItem(prefix + key, JSON.stringify(value))
    },
    async remove(key: string): Promise<void> {
      localStorage.removeItem(prefix + key)
    },
    async keys(): Promise<string[]> {
      return Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    },
  }
}

class PluginManagerImpl {
  private plugins = new Map<string, Plugin>()
  private statuses = new Map<string, PluginStatus>()
  private errors = new Map<string, string>()
  private enabledTimes = new Map<string, number>()
  private listeners = new Set<() => void>()

  /** 注册一个插件;manifest 校验失败拒绝注册(不抛错,仅 console.warn) */
  register(plugin: Plugin): void {
    const id = plugin?.manifest?.id
    if (!id || typeof id !== 'string') {
      console.warn(`[PluginManager] 插件缺少合法 manifest.id,拒绝注册`, plugin)
      return
    }
    if (this.plugins.has(id)) {
      console.warn(`[PluginManager] Plugin "${id}" already registered, skipping.`)
      return
    }
    const validation = validateManifest(plugin.manifest)
    if (!validation.ok) {
      const msg = `Plugin "${id}" manifest 校验失败: ${validation.errors.join('; ')}`
      console.warn(`[PluginManager] ${msg}`)
      toast.warning(`插件「${plugin.manifest.name || id}」加载失败:配置不合法`)
      return
    }
    this.plugins.set(id, plugin)
    this.statuses.set(id, 'installed')
    this.notifyListeners()
  }

  /** 启用已注册的插件;init 异常仅标记自身 error,不 rethrow 不阻塞其他插件 */
  async enable(pluginId: string, context: PluginContext): Promise<void> {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found`)

    // 生命周期幂等:已 active 直接返回
    if (this.statuses.get(pluginId) === 'active') return

    // storage namespace 隔离:按 pluginId 自动包装
    const sandboxedContext: PluginContext = {
      ...context,
      storage: wrapStorage(pluginId),
    }

    try {
      await plugin.init?.(sandboxedContext)
      this.statuses.set(pluginId, 'active')
      this.errors.delete(pluginId)
      this.enabledTimes.set(pluginId, Date.now())
      this.notifyListeners()
    } catch (err) {
      const msg = errText(err, '未知错误')
      this.statuses.set(pluginId, 'error')
      this.errors.set(pluginId, msg)
      this.enabledTimes.delete(pluginId)
      console.error(`[PluginManager] Plugin "${pluginId}" init 失败:`, err)
      this.notifyListeners()
      // 不 rethrow:单插件失败不应阻塞 bootstrap 后续插件注册
    }
  }

  /** 禁用插件;destroy 异常仅日志,不抛;重复 disable 直接返回 */
  disable(pluginId: string): void {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return
    // 生命周期幂等:非 active 直接返回(已 disabled / installed / error)
    if (this.statuses.get(pluginId) !== 'active') return

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
    this.enabledTimes.delete(pluginId)
    this.notifyListeners()
  }

  /**
   * 执行指定命令;handler 异常隔离:
   * - 单插件 getCommands 异常跳过,不影响命令枚举
   * - handler 自身异常抛给调用方(由 UI 层 toast 反馈)
   */
  async executeCommand(commandId: string, context: CommandContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (this.statuses.get(plugin.manifest.id) !== 'active') continue
      let commands: PluginCommand[] = []
      try {
        commands = plugin.getCommands?.() ?? []
      } catch (err) {
        console.error(
          `[PluginManager] Plugin "${plugin.manifest.id}" getCommands 抛错,跳过:`,
          err,
        )
        continue
      }
      const cmd = commands.find((c) => c.id === commandId)
      if (cmd) {
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

  /**
   * 按扩展点获取所有可用命令;单插件 getCommands 异常跳过,
   * 不影响其他插件命令枚举。
   */
  getCommandsByExtensionPoint(point: ExtensionPoint): PluginCommand[] {
    const commands: PluginCommand[] = []
    for (const plugin of this.plugins.values()) {
      if (this.statuses.get(plugin.manifest.id) !== 'active') continue
      let cmds: PluginCommand[] = []
      try {
        cmds = plugin.getCommands?.() ?? []
      } catch (err) {
        console.error(
          `[PluginManager] Plugin "${plugin.manifest.id}" getCommands 抛错,跳过:`,
          err,
        )
        continue
      }
      commands.push(...cmds.filter((c) => c.extensionPoint === point))
    }
    return commands
  }

  /** 获取所有命令;同样按插件异常隔离 */
  getAllCommands(): PluginCommand[] {
    const commands: PluginCommand[] = []
    for (const plugin of this.plugins.values()) {
      if (this.statuses.get(plugin.manifest.id) !== 'active') continue
      let cmds: PluginCommand[] = []
      try {
        cmds = plugin.getCommands?.() ?? []
      } catch (err) {
        console.error(
          `[PluginManager] Plugin "${plugin.manifest.id}" getCommands 抛错,跳过:`,
          err,
        )
        continue
      }
      commands.push(...cmds)
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
/** 导出类供测试隔离使用(生产代码请用 PluginManager 单例) */
export { PluginManagerImpl }
export default PluginManager
