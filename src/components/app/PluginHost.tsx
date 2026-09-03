/**
 * PluginHost — 主窗口插件宿主
 *
 * 挂载时引导内置插件（注册 + 启用）；
 * 渲染全局命令面板宿主（command-palette 扩展点），Ctrl/⌘+Shift+P 唤起。
 */
import { useEffect } from 'react'
import { bootstrapBuiltinPlugins } from '@/plugins/bootstrap'
import { PluginManager } from '@/plugins/PluginManager'
import CommandPalette from '@/components/common/CommandPalette'

export default function PluginHost() {
  useEffect(() => {
    void bootstrapBuiltinPlugins()
    return () => {
      // 主窗口关闭/路由切换时不卸载内置插件（进程级常驻）
    }
  }, [])

  // 保持组件订阅插件状态（供 HomeHeaderPlugins 响应式读取时即时更新）
  useEffect(() => {
    return PluginManager.subscribe(() => {})
  }, [])

  return <CommandPalette />
}
