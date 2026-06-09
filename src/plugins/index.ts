/**
 * TimeWrite Plugin System
 *
 * 模块入口，统一导出插件系统相关类型和管理器。
 */

export { PluginManager } from './PluginManager'
export type {
  Plugin,
  PluginManifest,
  PluginCommand,
  PluginContext,
  CommandContext,
  ExtensionPoint,
  InstalledPlugin,
  PluginStatus,
  PluginDefinition,
} from './types'

/**
 * 创建一个 TimeWrite 插件的辅助函数
 *
 * @example
 * ```ts
 * import { definePlugin } from '@/plugins'
 *
 * export default definePlugin({
 *   id: 'word-counter',
 *   name: '字数统计增强',
 *   version: '1.0.0',
 *   description: '提供更详细的字数统计功能',
 *   extensionPoints: ['editor-sidebar'],
 *   init(context) {
 *     console.log('字数统计增强插件已加载')
 *   },
 *   getCommands() {
 *     return [
 *       {
 *         id: 'word-counter.show-detail',
 *         label: '详细字数统计',
 *         extensionPoint: 'editor-sidebar',
 *         async handler(ctx) {
 *           const content = ctx.editorContent ?? ''
 *           ctx.notify(`总字数: ${content.length}`)
 *         },
 *       },
 *     ]
 *   },
 * })
 * ```
 */
import type { PluginDefinition } from './types'

export function definePlugin(
  plugin: PluginDefinition,
): import('./types').Plugin {
  const { id, name, version, description, author, homepage, icon, extensionPoints, minAppVersion, ...rest } = plugin
  return {
    manifest: {
      id,
      name,
      version,
      description,
      author,
      homepage,
      icon,
      extensionPoints,
      minAppVersion,
    },
    ...rest,
  }
}
