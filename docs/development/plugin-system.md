# 插件系统

TimeWrite 内置可扩展的插件系统，基于 PluginManager 单例模式。当前处于框架阶段，内置字符统计示例插件。

## 扩展点（6 个）

| 扩展点 | 说明 | 触发位置 |
|--------|------|---------|
| `editor-toolbar` | 编辑器工具栏按钮 | EditorToolbar |
| `editor-sidebar` | 编辑器侧边栏面板 | EditorPage |
| `library-card` | 书库卡片自定义操作 | LibraryPage |
| `export-format` | 导出格式扩展 | 导入导出模块 |
| `ai-prompt` | AI 提示词模板 | AiSidePanel |
| `command-palette` | 命令面板条目 | 全局命令面板 |

## PluginManager API

```typescript
class PluginManager {
  register(plugin: Plugin): void          // 注册插件
  enable(id: string): void                // 启用插件
  disable(id: string): void               // 禁用插件
  uninstall(id: string): void             // 卸载插件
  getCommandsByExtensionPoint(point): Command[]  // 按扩展点获取命令
  executeCommand(id: string, context): Promise<void>  // 执行命令
  subscribe(callback): () => void         // 订阅状态变化
}
```

## 插件定义

```typescript
interface Plugin {
  manifest: PluginManifest    // 插件元信息
  commands: PluginCommand[]   // 注册的命令
  onEnable?: () => void       // 启用回调
  onDisable?: () => void      // 禁用回调
}

interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  extensionPoints: ExtensionPoint[]  // 使用的扩展点
}
```

## 生命周期

```
register → enable → (运行中) → disable → uninstall
                ↕
             状态切换
```

- **注册**：加载插件但不激活
- **启用**：激活插件，执行 `onEnable`，命令可用
- **禁用**：暂停插件，执行 `onDisable`，命令不可用
- **卸载**：完全移除插件

## 内置示例

`charCounter` 字符统计插件：
- 扩展开：`editor-toolbar`
- 功能：在工具栏显示当前字符计数
- 展示插件注册/命令执行的基本用法

## 开发自定义插件

```typescript
import { definePlugin } from '@/plugins'

const myPlugin = definePlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  description: '一个自定义插件',
  extensionPoints: ['toolbar'],
  commands: [
    {
      id: 'my-action',
      label: '执行操作',
      extensionPoint: 'toolbar',
      execute: async (ctx) => {
        // 插件逻辑
      }
    }
  ]
})

// 注册
pluginManager.register(myPlugin)
pluginManager.enable('my-plugin')
```
