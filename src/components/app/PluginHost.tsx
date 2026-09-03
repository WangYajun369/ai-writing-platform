/**
 * PluginHost — 主窗口插件宿主
 *
 * 挂载时引导内置插件（注册 + 启用），提供 home-header 扩展点的渲染数据。
 */
import { useEffect } from 'react'
import { bootstrapBuiltinPlugins } from '@/plugins/bootstrap'
import { PluginManager } from '@/plugins/PluginManager'

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

  return null
}
