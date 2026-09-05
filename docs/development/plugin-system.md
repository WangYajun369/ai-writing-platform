# 插件系统

> **适用版本**：`1.7.0`　|　**最后核对**：2026-09-05

TimeWrite 内置基于**扩展点（Extension Point）**的插件系统：插件声明元信息与命令，经 `PluginManager`（单例）注册、启用后，命令会出现在对应扩展点的 UI 位置。v1.4.0 起内置插件引导 `bootstrap.ts` 自动注册 home-header 插件「英语字典·生词本」，v1.5.0 再注册「任务卡·项目管理」，两个内置插件在书库首页头部各占一个入口按钮（图标 + 角标），插件系统进入实际落地阶段。

## 扩展点（7 个）

| 扩展点 | 说明 | 触发位置 |
|--------|------|---------|
| `editor-toolbar` | 编辑器工具栏按钮 | EditorToolbar |
| `editor-sidebar` | 编辑器侧边栏面板 | EditorPage |
| `library-card` | 书库卡片自定义操作 | LibraryPage |
| `export-format` | 导出格式扩展 | 导入导出模块 |
| `ai-prompt` | AI 提示词模板 | AiSidePanel |
| `command-palette` | 命令面板条目 | 全局命令面板 |
| `home-header` | 首页头部入口按钮（支持激活态与角标） | LibraryPage 首页头部（v1.4.0） |

`home-header` 扩展点独有能力（`PluginCommand` 上可选）：

- `isActive?: () => boolean` —— 入口是否处于激活态（如对应子窗口已打开），用于按钮高亮
- `badgeCount?: () => number | Promise<number> | undefined` —— 角标计数源（如今日待复习数），返回 0 / undefined 不显示；平台会定期与收到事件后重新拉取
- `activeClassName?: string` —— 激活态图标主色类名

## 目录结构

| 文件 / 目录 | 说明 |
|------|------|
| `src/plugins/types.ts` | 类型定义：`PluginManifest`、`Plugin`、`PluginCommand`、`CommandContext`、`PluginContext`、`ExtensionPoint`、`PluginStatus` |
| `src/plugins/PluginManager.ts` | 单例管理器：注册 / 启用 / 禁用 / 卸载、按扩展点取命令、订阅状态 |
| `src/plugins/index.ts` | 对外导出（含 `definePlugin` 帮助函数） |
| `src/plugins/bootstrap.ts` | 主窗口内置插件引导：注册并启用内置插件、为 home-header 注入角标计数源 |
| `src/plugins/dictionary/` | 内置插件「英语字典·生词本」（v1.4.0，`plugin.ts` + `windowState.ts`） |
| `src/plugins/taskCards/` | 内置插件「任务卡·项目管理」（v1.5.0，`plugin.ts` + `windowState.ts`） |
| `src/plugins/examples/` | `charCounter.ts` 参考示例 |

## 插件结构

`definePlugin` 的入参即 `PluginDefinition`（`PluginManifest` 扁平化 + 生命周期）：

```typescript
import { definePlugin } from '@/plugins'

const myPlugin = definePlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  description: '…',
  icon: 'Sparkles',
  extensionPoints: ['home-header'],
  getCommands() {
    return [
      {
        id: 'my-plugin.open',
        label: '我的插件',
        extensionPoint: 'home-header',
        icon: 'Sparkles',
        activeClassName: 'text-sky-500',
        isActive: () => isMyWindowOpen(),
        badgeCount: () => myBadgeCount(),
        async handler(ctx) {
          ctx.notify('hello', 'info')
        },
      },
    ]
  },
})
```

生命周期（对应 `types.ts` 的 `Plugin`）：

| 方法 | 时机 | 说明 |
|------|------|------|
| `init?(context: PluginContext)` | `enable` 时调用一次 | 初始化（异步可等待），失败则状态置为 `error` |
| `getCommands?()` | 按需调用 | 返回插件命令列表（不启用则不执行） |
| `destroy?()` | `disable` / `unregister` | 清理副作用 |

> 命令字段用 `handler(context)`，并支持 `shortcut`；旧文档中的 `commands` / `onEnable` / `onDisable` 为框架早期形态，已废弃。

## PluginManager API

```typescript
PluginManager.register(plugin)                      // 注册（installed）
PluginManager.enable(id, context)                   // 启用：调用 init（active / error）
PluginManager.disable(id)                           // 禁用：调用 destroy（disabled）
PluginManager.unregister(id)                        // 卸载：disable 后移除
PluginManager.executeCommand(id, context)           // 执行某插件命令
PluginManager.getCommandsByExtensionPoint(point)    // 按扩展点取 active 插件的命令
PluginManager.getAllCommands()
PluginManager.getInstalledPlugins()                 // 状态快照（manifest + status + error）
PluginManager.getPluginStatus(id)
PluginManager.subscribe(listener)                   // 订阅状态变化
```

状态机：`installed → active / disabled / error`。

## 内置插件引导（bootstrap）

仅主窗口执行一次，模块级 Promise 保证幂等（StrictMode 双挂载安全）：

1. 注册并启用「英语字典·生词本」插件（v1.4.0）
2. 注册并启用「任务卡·项目管理」插件（v1.5.0）
3. 为每个 home-header 插件注入角标计数源（词典：`vocabApi.stats() → dueToday`；任务卡：今日应办数统计）
4. `PluginManager.enable(id, buildContext())`（插件 context：storage 走 localStorage，前缀 `tw:plugin:`）

「英语字典·生词本」插件要点：

- `extensionPoints: ['home-header']`，命令 `vocab-dictionary.open`：`windowApi.openVocab()` 打开独立窗口
- 窗口开关状态存于 `plugins/dictionary/windowState.ts`（模块级），不污染主程序 `uiAtoms`
- 后端到期广播事件（`vocab-due-updated`）会触发角标计数源重新拉取，主窗口角标 ⇄ 词典窗口实时同步
- 词典窗口页面位于 `src/components/vocabulary/`（业务组件目录），`components/app/AppInit.tsx` 负责识别 `?vocabwin=1` 路由

「任务卡·项目管理」插件要点（v1.5.0，multi-command 参考）：

- `id: 'task-cards'`，声明 4 个 `command-palette` 命令：`task-cards.open`（打开 / 切换窗口）、`task-cards.open-palette`（直达今日）、`task-cards.goto-today`、`task-cards.goto-all`，深链参数 `?taskswin=1&section=today|all`
- `home-header` 入口复用激活态判断 + 今日应办数角标（`getTaskCardsBadgeCount()`，监听 `tasks-data-updated` 刷新）
- 窗口开关状态存于 `plugins/taskCards/windowState.ts`（模块级），业务数据在 `components/taskCards/TaskCardsWindow.tsx` 挂载时经 `taskCardApi` 拉取进 `taskCardsStore`
- 任务卡窗口页面位于 `src/components/taskCards/`，`AppInit.tsx` 识别 `?taskswin=1`；「看日记」窗口（`diarybookwin=1`）直接由 `windowApi.openDiaryBookWindow()` 打开（非插件入口）

> 两个插件的差异点：词典为「单命令 + 事件驱动角标」，任务卡为「多命令 + 深链直达 + store 数据流」——新插件可按自身形态取舍。

## 示例插件

`examples/charCounter.ts` 展示最简写法（editor-toolbar 扩展点、计数命令），不随内置引导启用，供开发参考。

## 开发自定义插件步骤

1. 在 `src/plugins/<your-plugin>/` 建插件文件，用 `definePlugin` 声明
2. 命令 `handler` 中通过 `windowApi` / `vocabApi` 等 tauri-bridge API 或 `PluginContext` 操作
3. 若需 UI 入口 → 声明到对应扩展点（如 `home-header`）
4. 若需独立窗口 → 复用 `windowApi` 的 open/close/is 模式，并在 `AppInit.tsx` / `windowDetection.ts` 登记窗口参数
5. 需要随应用内置 → 在 `bootstrap.ts` 注册并 enable

## 相关文档

- [项目结构](development/project-structure) — `plugins/` 目录位置
- [用户指南 · 英语字典·生词本](user-guide/vocabulary) — 内置插件使用说明（v1.4.0）
- [用户指南 · 任务卡·项目管理](user-guide/task-cards) — 内置插件使用说明（v1.5.0）
- [状态管理](development/state-management) — PluginManager 与 `pluginStore` 的关系
